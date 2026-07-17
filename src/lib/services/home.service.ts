/**
 * Home module — room-by-room inventory (walk-through capture) and recurring
 * home maintenance with a service log.
 *
 * Item photos reuse the receipts storage pipeline (`getStorageBackend`) under
 * a `home-items/` key prefix — same 10MB limit, images only (JPEG/PNG),
 * validated from magic bytes. Every read/write is fetched-then-checked
 * against the caller's active book_guid.
 */

import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
    getStorageBackend,
    generateStorageKey,
} from '@/lib/storage/storage-backend';
import {
    RECEIPT_MAX_FILE_SIZE,
    detectReceiptMimeType,
    sanitizeFilename,
} from '@/lib/services/document-intake';

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

export const HOME_PHOTO_MAX_FILE_SIZE = RECEIPT_MAX_FILE_SIZE; // 10MB, same as receipts
export const HOME_PHOTO_KEY_PREFIX = 'home-items/';

/** Warranties expiring within this many days count as "expiring soon". */
export const WARRANTY_WARNING_DAYS = 90;

/** Tasks due within this many days count as "due soon". */
export const TASK_DUE_SOON_DAYS = 30;

export const ITEM_CATEGORIES = [
    'furniture',
    'electronics',
    'appliance',
    'jewelry',
    'tool',
    'clothing',
    'decor',
    'other',
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export function isValidCategory(value: unknown): value is ItemCategory {
    return typeof value === 'string' && (ITEM_CATEGORIES as readonly string[]).includes(value);
}

export const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

/**
 * Rooms suggested when the user starts a walk-through with zero rooms.
 * They're plain rows afterwards — rename or delete freely.
 */
export const DEFAULT_ROOMS = [
    'Living Room',
    'Kitchen',
    'Primary Bedroom',
    'Bedroom 2',
    'Bathroom',
    'Garage',
    'Office',
    'Attic/Storage',
] as const;

/** Standard maintenance template offered on first use (user-editable rows). */
export const MAINTENANCE_TEMPLATE: Array<{
    name: string;
    cadenceMonths: number;
    season: string | null;
}> = [
    { name: 'Replace HVAC filter', cadenceMonths: 3, season: null },
    { name: 'Test smoke/CO detectors', cadenceMonths: 6, season: null },
    { name: 'Replace smoke/CO detector batteries', cadenceMonths: 12, season: null },
    { name: 'Clean gutters', cadenceMonths: 6, season: 'spring+fall' },
    { name: 'Flush water heater', cadenceMonths: 12, season: null },
    { name: 'Clean dryer vent', cadenceMonths: 12, season: null },
    { name: 'Vacuum refrigerator coils', cadenceMonths: 12, season: null },
    { name: 'Test sump pump', cadenceMonths: 12, season: 'spring' },
    { name: 'Winterize outdoor faucets', cadenceMonths: 12, season: 'fall' },
    { name: 'HVAC service / tune-up', cadenceMonths: 12, season: null },
];

export class HomeValidationError extends Error {}
export class HomeNotFoundError extends Error {}

/* ------------------------------------------------------------------ */
/* Pure date helpers                                                    */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function utcDay(d: Date): number {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole days from `today` until `date` (UTC-midnight to UTC-midnight).
 * Negative when the date is in the past; null when there is no date.
 */
export function daysUntil(
    date: Date | string | null,
    today: Date = new Date(),
): number | null {
    if (!date) return null;
    const d = typeof date === 'string' ? parseIsoDate(date) : date;
    if (!d || isNaN(d.getTime())) return null;
    return Math.round((utcDay(d) - utcDay(today)) / DAY_MS);
}

/** Parse YYYY-MM-DD into a UTC-midnight Date; null when malformed. */
export function parseIsoDate(value: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const d = new Date(`${value}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date | null): string | null {
    return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Add calendar months in UTC, clamping to the last day of the target month
 * (Jan 31 + 1mo = Feb 28/29 — GnuCash-style month-end clamping).
 */
export function addMonthsClamped(date: Date, months: number): Date {
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
    const daysInTarget = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    target.setUTCDate(Math.min(day, daysInTarget));
    return target;
}

/** First day of each season's "do it now" month (northern hemisphere). */
const SEASON_ANCHOR_MONTH: Record<Season, number> = {
    winter: 0, // Jan 1
    spring: 3, // Apr 1
    summer: 6, // Jul 1
    fall: 9, // Oct 1
};

function seasonParts(season: string): Season[] {
    return season
        .split('+')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is Season => (SEASONS as readonly string[]).includes(s));
}

export function isValidSeason(value: string): boolean {
    const parts = value.split('+').map((s) => s.trim().toLowerCase());
    return parts.length > 0 && parts.every((p) => (SEASONS as readonly string[]).includes(p));
}

/** "spring+fall" → "Spring + Fall". Null in, null out. */
export function seasonLabel(season: string | null): string | null {
    if (!season) return null;
    const parts = seasonParts(season);
    if (parts.length === 0) return null;
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' + ');
}

/**
 * Next due date for a task.
 *
 * - Cadence tasks: last_done + cadence_months (month-end clamped);
 *   never done → null (the status helper surfaces these as "due soon").
 * - Season-only tasks: next season anchor (Apr/Jul/Oct/Jan 1) strictly after
 *   last_done, or the next anchor on/after today when never done.
 * - Neither cadence nor season → null (unscheduled).
 */
export function computeNextDue(
    task: { cadenceMonths: number | null; season: string | null; lastDone: Date | string | null },
    today: Date = new Date(),
): Date | null {
    const lastDone =
        typeof task.lastDone === 'string' ? parseIsoDate(task.lastDone) : task.lastDone;

    if (task.cadenceMonths && task.cadenceMonths > 0) {
        if (!lastDone) return null;
        return addMonthsClamped(lastDone, task.cadenceMonths);
    }

    if (task.season) {
        const parts = seasonParts(task.season);
        if (parts.length === 0) return null;
        const after = lastDone ? utcDay(lastDone) : utcDay(today) - DAY_MS;
        // Candidate anchors across this year and the next two (covers all wraps).
        const baseYear = new Date(after).getUTCFullYear();
        const candidates: number[] = [];
        for (let y = baseYear; y <= baseYear + 2; y++) {
            for (const p of parts) {
                candidates.push(Date.UTC(y, SEASON_ANCHOR_MONTH[p], 1));
            }
        }
        const next = candidates.filter((c) => c > after).sort((a, b) => a - b)[0];
        return next !== undefined ? new Date(next) : null;
    }

    return null;
}

export type TaskStatus = 'overdue' | 'due_soon' | 'later' | 'unscheduled';

/**
 * Bucket a task by its computed next-due date. A scheduled task that has
 * never been done has no anchor yet — it belongs in "due soon" so it
 * surfaces without screaming "overdue" the moment it's created.
 */
export function computeTaskStatus(
    nextDue: Date | null,
    hasSchedule: boolean,
    today: Date = new Date(),
): TaskStatus {
    if (nextDue === null) return hasSchedule ? 'due_soon' : 'unscheduled';
    const days = daysUntil(nextDue, today);
    if (days === null) return hasSchedule ? 'due_soon' : 'unscheduled';
    if (days < 0) return 'overdue';
    if (days <= TASK_DUE_SOON_DAYS) return 'due_soon';
    return 'later';
}

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface HomeRoom {
    id: number;
    name: string;
    sortOrder: number;
}

export interface HomeItemPhoto {
    id: number;
}

export interface HomeItem {
    id: number;
    roomId: number;
    name: string;
    category: string | null;
    estValue: number | null;
    /** ISO date (YYYY-MM-DD) or null. */
    purchaseDate: string | null;
    receiptId: number | null;
    /** Ordered photo list; each id is fetched via /photos/[id]. */
    photos: HomeItemPhoto[];
    warrantyExpires: string | null;
    /** Negative = expired, null = no warranty date. */
    warrantyDays: number | null;
    serial: string | null;
    notes: string | null;
}

export interface HomeTask {
    id: number;
    name: string;
    cadenceMonths: number | null;
    season: string | null;
    seasonLabel: string | null;
    itemId: number | null;
    itemName: string | null;
    lastDone: string | null;
    active: boolean;
    notes: string | null;
    nextDue: string | null;
    daysUntilDue: number | null;
    status: TaskStatus;
}

export interface HomeServiceEntry {
    id: number;
    taskId: number | null;
    taskName: string | null;
    itemId: number | null;
    itemName: string | null;
    serviceDate: string;
    cost: number | null;
    vendor: string | null;
    txnGuid: string | null;
    notes: string | null;
}

export interface RoomSummary extends HomeRoom {
    itemCount: number;
    totalValue: number;
}

export interface WarrantyAlert {
    itemId: number;
    itemName: string;
    roomId: number;
    roomName: string;
    warrantyExpires: string;
    /** Negative = already expired. */
    daysUntil: number;
}

export interface HomeSummary {
    rooms: RoomSummary[];
    totalItems: number;
    totalValue: number;
    warrantyExpired: WarrantyAlert[];
    warrantyExpiringSoon: WarrantyAlert[];
    warrantyWarningDays: number;
    tasksOverdue: number;
    tasksDueSoon: number;
    maintenanceCostYtd: number;
}

/* ------------------------------------------------------------------ */
/* Pure summary math (unit-tested)                                      */
/* ------------------------------------------------------------------ */

export interface SummaryItemInput {
    roomId: number;
    estValue: number | null;
}

/** Per-room item counts + value subtotals, in room sort order. */
export function summarizeRooms(
    rooms: Array<{ id: number; name: string; sortOrder: number }>,
    items: SummaryItemInput[],
): RoomSummary[] {
    const byRoom = new Map<number, { count: number; value: number }>();
    for (const item of items) {
        const agg = byRoom.get(item.roomId) ?? { count: 0, value: 0 };
        agg.count += 1;
        agg.value += item.estValue ?? 0;
        byRoom.set(item.roomId, agg);
    }
    return rooms.map((r) => ({
        id: r.id,
        name: r.name,
        sortOrder: r.sortOrder,
        itemCount: byRoom.get(r.id)?.count ?? 0,
        totalValue: round2(byRoom.get(r.id)?.value ?? 0),
    }));
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Split warranty-dated items into expired vs expiring within the window. */
export function bucketWarranties(
    alerts: Array<Omit<WarrantyAlert, 'daysUntil'>>,
    today: Date = new Date(),
    warningDays: number = WARRANTY_WARNING_DAYS,
): { expired: WarrantyAlert[]; expiringSoon: WarrantyAlert[] } {
    const expired: WarrantyAlert[] = [];
    const expiringSoon: WarrantyAlert[] = [];
    for (const alert of alerts) {
        const days = daysUntil(alert.warrantyExpires, today);
        if (days === null) continue;
        if (days < 0) expired.push({ ...alert, daysUntil: days });
        else if (days <= warningDays) expiringSoon.push({ ...alert, daysUntil: days });
    }
    expired.sort((a, b) => b.daysUntil - a.daysUntil); // most recently expired first
    expiringSoon.sort((a, b) => a.daysUntil - b.daysUntil); // soonest first
    return { expired, expiringSoon };
}

/* ------------------------------------------------------------------ */
/* Row mappers                                                          */
/* ------------------------------------------------------------------ */

interface ItemDbRow {
    id: number;
    book_guid: string;
    room_id: number;
    name: string;
    category: string | null;
    est_value: unknown; // Prisma.Decimal | null
    purchase_date: Date | null;
    receipt_id: number | null;
    photo_key: string | null; // legacy, always null post-backfill
    warranty_expires: Date | null;
    serial: string | null;
    notes: string | null;
    photos?: Array<{ id: number }>;
}

/** Load an item together with its photos, ordered for display. */
const ITEM_PHOTO_INCLUDE = {
    photos: {
        select: { id: true },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    },
} satisfies Prisma.gnucash_web_home_itemsInclude;

function decimalToNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return isNaN(n) ? null : n;
}

function mapItem(row: ItemDbRow, today: Date = new Date()): HomeItem {
    return {
        id: row.id,
        roomId: row.room_id,
        name: row.name,
        category: row.category,
        estValue: decimalToNumber(row.est_value),
        purchaseDate: toIsoDate(row.purchase_date),
        receiptId: row.receipt_id,
        photos: (row.photos ?? []).map((p) => ({ id: p.id })),
        warrantyExpires: toIsoDate(row.warranty_expires),
        warrantyDays: daysUntil(row.warranty_expires, today),
        serial: row.serial,
        notes: row.notes,
    };
}

interface TaskDbRow {
    id: number;
    book_guid: string;
    name: string;
    cadence_months: number | null;
    season: string | null;
    item_id: number | null;
    last_done: Date | null;
    active: boolean;
    notes: string | null;
    item?: { name: string } | null;
}

function mapTask(row: TaskDbRow, today: Date = new Date()): HomeTask {
    const nextDue = computeNextDue(
        { cadenceMonths: row.cadence_months, season: row.season, lastDone: row.last_done },
        today,
    );
    const hasSchedule = Boolean((row.cadence_months && row.cadence_months > 0) || row.season);
    return {
        id: row.id,
        name: row.name,
        cadenceMonths: row.cadence_months,
        season: row.season,
        seasonLabel: seasonLabel(row.season),
        itemId: row.item_id,
        itemName: row.item?.name ?? null,
        lastDone: toIsoDate(row.last_done),
        active: row.active,
        notes: row.notes,
        nextDue: toIsoDate(nextDue),
        daysUntilDue: nextDue ? daysUntil(nextDue, today) : null,
        status: computeTaskStatus(nextDue, hasSchedule, today),
    };
}

interface ServiceLogDbRow {
    id: number;
    book_guid: string;
    task_id: number | null;
    item_id: number | null;
    service_date: Date;
    cost: unknown; // Prisma.Decimal | null
    vendor: string | null;
    txn_guid: string | null;
    notes: string | null;
    task?: { name: string } | null;
    item?: { name: string } | null;
}

function mapServiceEntry(row: ServiceLogDbRow): HomeServiceEntry {
    return {
        id: row.id,
        taskId: row.task_id,
        taskName: row.task?.name ?? null,
        itemId: row.item_id,
        itemName: row.item?.name ?? null,
        serviceDate: toIsoDate(row.service_date) as string,
        cost: decimalToNumber(row.cost),
        vendor: row.vendor,
        txnGuid: row.txn_guid,
        notes: row.notes,
    };
}

/* ------------------------------------------------------------------ */
/* Input validation helpers                                             */
/* ------------------------------------------------------------------ */

function requireName(value: string | undefined, field: string): string {
    const name = value?.trim();
    if (!name) throw new HomeValidationError(`${field} is required`);
    if (name.length > 255) throw new HomeValidationError(`${field} too long (max 255)`);
    return name;
}

function parseOptionalDate(value: string | null | undefined, field: string): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = parseIsoDate(value);
    if (!d) throw new HomeValidationError(`${field} must be YYYY-MM-DD`);
    return d;
}

function parseOptionalValue(value: number | null | undefined, field: string): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
        throw new HomeValidationError(`${field} must be a non-negative number`);
    }
    return round2(value);
}

function parseOptionalGuid(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const guid = value.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(guid)) {
        throw new HomeValidationError('txnGuid must be a 32-character GnuCash GUID');
    }
    return guid;
}

/* ------------------------------------------------------------------ */
/* Rooms                                                                */
/* ------------------------------------------------------------------ */

export async function listRooms(bookGuid: string): Promise<HomeRoom[]> {
    const rows = await prisma.gnucash_web_home_rooms.findMany({
        where: { book_guid: bookGuid },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order }));
}

export async function createRoom(
    bookGuid: string,
    input: { name: string; sortOrder?: number },
): Promise<HomeRoom> {
    const name = requireName(input.name, 'Room name');
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
        const max = await prisma.gnucash_web_home_rooms.aggregate({
            where: { book_guid: bookGuid },
            _max: { sort_order: true },
        });
        sortOrder = (max._max.sort_order ?? -1) + 1;
    }
    const row = await prisma.gnucash_web_home_rooms.create({
        data: { book_guid: bookGuid, name, sort_order: sortOrder },
    });
    return { id: row.id, name: row.name, sortOrder: row.sort_order };
}

/**
 * Create the default room set — only when the book has zero rooms (the
 * "start walk-through" first-use path). Returns all rooms either way.
 */
export async function seedDefaultRooms(bookGuid: string): Promise<HomeRoom[]> {
    const count = await prisma.gnucash_web_home_rooms.count({ where: { book_guid: bookGuid } });
    if (count === 0) {
        await prisma.gnucash_web_home_rooms.createMany({
            data: DEFAULT_ROOMS.map((name, i) => ({
                book_guid: bookGuid,
                name,
                sort_order: i,
            })),
        });
    }
    return listRooms(bookGuid);
}

async function getOwnedRoom(bookGuid: string, id: number) {
    const row = await prisma.gnucash_web_home_rooms.findUnique({ where: { id } });
    if (!row || row.book_guid !== bookGuid) throw new HomeNotFoundError('Room not found');
    return row;
}

export async function updateRoom(
    bookGuid: string,
    id: number,
    input: { name?: string; sortOrder?: number },
): Promise<HomeRoom> {
    await getOwnedRoom(bookGuid, id);
    const data: { name?: string; sort_order?: number } = {};
    if (input.name !== undefined) data.name = requireName(input.name, 'Room name');
    if (input.sortOrder !== undefined) {
        if (!Number.isInteger(input.sortOrder)) {
            throw new HomeValidationError('sortOrder must be an integer');
        }
        data.sort_order = input.sortOrder;
    }
    const row = await prisma.gnucash_web_home_rooms.update({ where: { id }, data });
    return { id: row.id, name: row.name, sortOrder: row.sort_order };
}

/** Best-effort delete of a set of stored photo files (never throws). */
async function deletePhotoFiles(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    let storage;
    try {
        storage = await getStorageBackend();
    } catch (err) {
        console.warn('Storage backend unavailable, skipping home photo deletion:', err);
        return;
    }
    for (const key of keys) {
        try {
            await storage.delete(key);
        } catch (err) {
            console.warn('Failed to delete home item photo:', err);
        }
    }
}

/** Delete a room; item + photo rows cascade, so clean up their photo files first. */
export async function deleteRoom(bookGuid: string, id: number): Promise<void> {
    await getOwnedRoom(bookGuid, id);
    const photos = await prisma.gnucash_web_home_item_photos.findMany({
        where: { item: { room_id: id } },
        select: { photo_key: true },
    });
    await deletePhotoFiles(photos.map((p) => p.photo_key));
    await prisma.gnucash_web_home_rooms.delete({ where: { id } });
}

/* ------------------------------------------------------------------ */
/* Items                                                                */
/* ------------------------------------------------------------------ */

export async function listItems(bookGuid: string, roomId?: number): Promise<HomeItem[]> {
    const rows = await prisma.gnucash_web_home_items.findMany({
        where: { book_guid: bookGuid, ...(roomId !== undefined ? { room_id: roomId } : {}) },
        include: ITEM_PHOTO_INCLUDE,
        orderBy: [{ id: 'asc' }],
    });
    const today = new Date();
    return rows.map((r) => mapItem(r, today));
}

export interface ItemInput {
    roomId?: number;
    name?: string;
    category?: string | null;
    estValue?: number | null;
    purchaseDate?: string | null;
    receiptId?: number | null;
    warrantyExpires?: string | null;
    serial?: string | null;
    notes?: string | null;
}

function validateCategory(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const category = value.trim().toLowerCase();
    if (!isValidCategory(category)) {
        throw new HomeValidationError(
            `Invalid category (expected one of: ${ITEM_CATEGORIES.join(', ')})`,
        );
    }
    return category;
}

function validateSerial(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const serial = value.trim();
    if (serial.length > 100) throw new HomeValidationError('Serial too long (max 100)');
    return serial || null;
}

async function assertReceiptOwned(bookGuid: string, receiptId: number): Promise<void> {
    const receipt = await prisma.gnucash_web_receipts.findUnique({
        where: { id: receiptId },
        select: { book_guid: true },
    });
    if (!receipt || receipt.book_guid !== bookGuid) {
        throw new HomeValidationError('Receipt not found in this book');
    }
}

export async function createItem(bookGuid: string, input: ItemInput): Promise<HomeItem> {
    const name = requireName(input.name, 'Item name');
    if (input.roomId === undefined || !Number.isInteger(input.roomId)) {
        throw new HomeValidationError('roomId is required');
    }
    await getOwnedRoom(bookGuid, input.roomId);
    if (input.receiptId !== null && input.receiptId !== undefined) {
        await assertReceiptOwned(bookGuid, input.receiptId);
    }
    const row = await prisma.gnucash_web_home_items.create({
        data: {
            book_guid: bookGuid,
            room_id: input.roomId,
            name,
            category: validateCategory(input.category),
            est_value: parseOptionalValue(input.estValue, 'estValue'),
            purchase_date: parseOptionalDate(input.purchaseDate, 'purchaseDate'),
            receipt_id: input.receiptId ?? null,
            warranty_expires: parseOptionalDate(input.warrantyExpires, 'warrantyExpires'),
            serial: validateSerial(input.serial),
            notes: input.notes?.trim() || null,
        },
        include: ITEM_PHOTO_INCLUDE,
    });
    return mapItem(row);
}

async function getOwnedItem(bookGuid: string, id: number) {
    const row = await prisma.gnucash_web_home_items.findUnique({
        where: { id },
        include: ITEM_PHOTO_INCLUDE,
    });
    if (!row || row.book_guid !== bookGuid) throw new HomeNotFoundError('Item not found');
    return row;
}

export async function updateItem(
    bookGuid: string,
    id: number,
    input: ItemInput,
): Promise<HomeItem> {
    await getOwnedItem(bookGuid, id);

    const data: {
        room_id?: number;
        name?: string;
        category?: string | null;
        est_value?: number | null;
        purchase_date?: Date | null;
        receipt_id?: number | null;
        warranty_expires?: Date | null;
        serial?: string | null;
        notes?: string | null;
        updated_at?: Date;
    } = { updated_at: new Date() };

    if (input.roomId !== undefined) {
        if (!Number.isInteger(input.roomId)) throw new HomeValidationError('Invalid roomId');
        await getOwnedRoom(bookGuid, input.roomId); // move-to-room stays inside the book
        data.room_id = input.roomId;
    }
    if (input.name !== undefined) data.name = requireName(input.name, 'Item name');
    if (input.category !== undefined) data.category = validateCategory(input.category);
    if (input.estValue !== undefined) data.est_value = parseOptionalValue(input.estValue, 'estValue');
    if (input.purchaseDate !== undefined) {
        data.purchase_date = parseOptionalDate(input.purchaseDate, 'purchaseDate');
    }
    if (input.receiptId !== undefined) {
        if (input.receiptId !== null) await assertReceiptOwned(bookGuid, input.receiptId);
        data.receipt_id = input.receiptId;
    }
    if (input.warrantyExpires !== undefined) {
        data.warranty_expires = parseOptionalDate(input.warrantyExpires, 'warrantyExpires');
    }
    if (input.serial !== undefined) data.serial = validateSerial(input.serial);
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

    const row = await prisma.gnucash_web_home_items.update({
        where: { id },
        data,
        include: ITEM_PHOTO_INCLUDE,
    });
    return mapItem(row);
}

export async function deleteItem(bookGuid: string, id: number): Promise<void> {
    await getOwnedItem(bookGuid, id);
    const photos = await prisma.gnucash_web_home_item_photos.findMany({
        where: { item_id: id },
        select: { photo_key: true },
    });
    await deletePhotoFiles(photos.map((p) => p.photo_key));
    await prisma.gnucash_web_home_items.delete({ where: { id } });
}

/* ------------------------------------------------------------------ */
/* Item photos (receipts storage backend, home-items/ prefix)           */
/* ------------------------------------------------------------------ */

/**
 * Append a photo to an item's gallery. Images only (JPEG/PNG from magic bytes).
 * Returns the item with its full, reordered photo list.
 */
export async function addItemPhoto(
    bookGuid: string,
    itemId: number,
    file: { buffer: Buffer; filename: string },
): Promise<HomeItem> {
    await getOwnedItem(bookGuid, itemId);

    const { buffer, filename } = file;
    if (buffer.byteLength === 0) throw new HomeValidationError('Empty file');
    if (buffer.byteLength > HOME_PHOTO_MAX_FILE_SIZE) {
        throw new HomeValidationError(
            `Photo exceeds ${HOME_PHOTO_MAX_FILE_SIZE / 1024 / 1024}MB limit`,
        );
    }
    const mimeType = detectReceiptMimeType(buffer);
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
        throw new HomeValidationError('Unsupported photo type (must be JPEG or PNG)');
    }

    // New photo sorts after existing ones.
    const maxOrder = await prisma.gnucash_web_home_item_photos.aggregate({
        where: { item_id: itemId },
        _max: { sort_order: true },
    });
    const sortOrder = (maxOrder._max.sort_order ?? -1) + 1;

    const photoKey = HOME_PHOTO_KEY_PREFIX + generateStorageKey(sanitizeFilename(filename));
    const storage = await getStorageBackend();
    await storage.put(photoKey, buffer, mimeType);

    try {
        await prisma.gnucash_web_home_item_photos.create({
            data: {
                book_guid: bookGuid,
                item_id: itemId,
                photo_key: photoKey,
                sort_order: sortOrder,
            },
        });
        await prisma.gnucash_web_home_items.update({
            where: { id: itemId },
            data: { updated_at: new Date() },
        });
    } catch (error) {
        // Roll back the orphaned file if the row insert failed (non-fatal).
        try {
            await storage.delete(photoKey);
        } catch (cleanupErr) {
            console.warn('Failed to clean up orphan photo file:', cleanupErr);
        }
        throw error;
    }

    return mapItem(await getOwnedItem(bookGuid, itemId));
}

export interface ItemPhotoFile {
    buffer: Buffer;
    mimeType: string;
}

/** Fetch a photo row that belongs to the given item within the book. */
async function getOwnedPhoto(bookGuid: string, itemId: number, photoId: number) {
    const photo = await prisma.gnucash_web_home_item_photos.findUnique({ where: { id: photoId } });
    if (!photo || photo.book_guid !== bookGuid || photo.item_id !== itemId) {
        throw new HomeNotFoundError('Photo not found');
    }
    return photo;
}

export async function getItemPhoto(
    bookGuid: string,
    itemId: number,
    photoId: number,
): Promise<ItemPhotoFile> {
    const photo = await getOwnedPhoto(bookGuid, itemId, photoId);
    const storage = await getStorageBackend();
    const buffer = await storage.get(photo.photo_key);
    const mimeType = detectReceiptMimeType(buffer) ?? 'application/octet-stream';
    return { buffer, mimeType };
}

export async function deleteItemPhoto(
    bookGuid: string,
    itemId: number,
    photoId: number,
): Promise<HomeItem> {
    const photo = await getOwnedPhoto(bookGuid, itemId, photoId);
    await deletePhotoFiles([photo.photo_key]);
    await prisma.gnucash_web_home_item_photos.delete({ where: { id: photoId } });
    await prisma.gnucash_web_home_items.update({
        where: { id: itemId },
        data: { updated_at: new Date() },
    });
    return mapItem(await getOwnedItem(bookGuid, itemId));
}

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

export async function listTasks(
    bookGuid: string,
    options: { includeInactive?: boolean } = {},
): Promise<HomeTask[]> {
    const rows = await prisma.gnucash_web_home_tasks.findMany({
        where: {
            book_guid: bookGuid,
            ...(options.includeInactive ? {} : { active: true }),
        },
        include: { item: { select: { name: true } } },
        orderBy: [{ id: 'asc' }],
    });
    const today = new Date();
    return rows
        .map((r) => mapTask(r, today))
        .sort((a, b) => {
            if (a.active !== b.active) return a.active ? -1 : 1;
            // By next due date; never-done tasks sort as "due today".
            const ax = a.daysUntilDue ?? 0;
            const bx = b.daysUntilDue ?? 0;
            return ax - bx || a.name.localeCompare(b.name);
        });
}

export interface TaskInput {
    name?: string;
    cadenceMonths?: number | null;
    season?: string | null;
    itemId?: number | null;
    lastDone?: string | null;
    active?: boolean;
    notes?: string | null;
}

function validateCadence(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < 1 || value > 120) {
        throw new HomeValidationError('cadenceMonths must be an integer between 1 and 120');
    }
    return value;
}

function validateSeasonInput(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const season = value.trim().toLowerCase();
    if (season.length > 20 || !isValidSeason(season)) {
        throw new HomeValidationError(
            'season must be spring, summer, fall, winter, or a "+" combination',
        );
    }
    return season;
}

async function assertItemOwned(bookGuid: string, itemId: number): Promise<void> {
    const item = await prisma.gnucash_web_home_items.findUnique({
        where: { id: itemId },
        select: { book_guid: true },
    });
    if (!item || item.book_guid !== bookGuid) {
        throw new HomeValidationError('Linked item not found in this book');
    }
}

export async function createTask(bookGuid: string, input: TaskInput): Promise<HomeTask> {
    const name = requireName(input.name, 'Task name');
    if (input.itemId !== null && input.itemId !== undefined) {
        await assertItemOwned(bookGuid, input.itemId);
    }
    const row = await prisma.gnucash_web_home_tasks.create({
        data: {
            book_guid: bookGuid,
            name,
            cadence_months: validateCadence(input.cadenceMonths),
            season: validateSeasonInput(input.season),
            item_id: input.itemId ?? null,
            last_done: parseOptionalDate(input.lastDone, 'lastDone'),
            active: input.active ?? true,
            notes: input.notes?.trim() || null,
        },
        include: { item: { select: { name: true } } },
    });
    return mapTask(row);
}

/**
 * Seed the standard maintenance template — only when the book has zero
 * tasks (first-use offer). Returns all tasks either way.
 */
export async function seedMaintenanceTemplate(bookGuid: string): Promise<HomeTask[]> {
    const count = await prisma.gnucash_web_home_tasks.count({ where: { book_guid: bookGuid } });
    if (count === 0) {
        await prisma.gnucash_web_home_tasks.createMany({
            data: MAINTENANCE_TEMPLATE.map((t) => ({
                book_guid: bookGuid,
                name: t.name,
                cadence_months: t.cadenceMonths,
                season: t.season,
            })),
        });
    }
    return listTasks(bookGuid, { includeInactive: true });
}

async function getOwnedTask(bookGuid: string, id: number) {
    const row = await prisma.gnucash_web_home_tasks.findUnique({ where: { id } });
    if (!row || row.book_guid !== bookGuid) throw new HomeNotFoundError('Task not found');
    return row;
}

export async function updateTask(
    bookGuid: string,
    id: number,
    input: TaskInput,
): Promise<HomeTask> {
    await getOwnedTask(bookGuid, id);

    const data: {
        name?: string;
        cadence_months?: number | null;
        season?: string | null;
        item_id?: number | null;
        last_done?: Date | null;
        active?: boolean;
        notes?: string | null;
        updated_at?: Date;
    } = { updated_at: new Date() };

    if (input.name !== undefined) data.name = requireName(input.name, 'Task name');
    if (input.cadenceMonths !== undefined) data.cadence_months = validateCadence(input.cadenceMonths);
    if (input.season !== undefined) data.season = validateSeasonInput(input.season);
    if (input.itemId !== undefined) {
        if (input.itemId !== null) await assertItemOwned(bookGuid, input.itemId);
        data.item_id = input.itemId;
    }
    if (input.lastDone !== undefined) data.last_done = parseOptionalDate(input.lastDone, 'lastDone');
    if (input.active !== undefined) data.active = input.active;
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

    const row = await prisma.gnucash_web_home_tasks.update({
        where: { id },
        data,
        include: { item: { select: { name: true } } },
    });
    return mapTask(row);
}

export async function deleteTask(bookGuid: string, id: number): Promise<void> {
    await getOwnedTask(bookGuid, id);
    await prisma.gnucash_web_home_tasks.delete({ where: { id } });
}

/* ------------------------------------------------------------------ */
/* Service log                                                          */
/* ------------------------------------------------------------------ */

const SERVICE_ENTRY_INCLUDE = {
    task: { select: { name: true } },
    item: { select: { name: true } },
} as const;

export async function listServiceLog(
    bookGuid: string,
    filter: { taskId?: number; itemId?: number } = {},
): Promise<HomeServiceEntry[]> {
    const rows = await prisma.gnucash_web_home_service_log.findMany({
        where: {
            book_guid: bookGuid,
            ...(filter.taskId !== undefined ? { task_id: filter.taskId } : {}),
            ...(filter.itemId !== undefined ? { item_id: filter.itemId } : {}),
        },
        include: SERVICE_ENTRY_INCLUDE,
        orderBy: [{ service_date: 'desc' }, { id: 'desc' }],
    });
    return rows.map(mapServiceEntry);
}

/** Total maintenance cost for the given calendar year. */
export async function serviceCostForYear(bookGuid: string, year: number): Promise<number> {
    const rows = await prisma.gnucash_web_home_service_log.findMany({
        where: {
            book_guid: bookGuid,
            service_date: {
                gte: new Date(Date.UTC(year, 0, 1)),
                lt: new Date(Date.UTC(year + 1, 0, 1)),
            },
        },
        select: { cost: true },
    });
    return round2(rows.reduce((sum, r) => sum + (decimalToNumber(r.cost) ?? 0), 0));
}

export interface ServiceEntryInput {
    taskId?: number | null;
    itemId?: number | null;
    serviceDate?: string;
    cost?: number | null;
    vendor?: string | null;
    txnGuid?: string | null;
    notes?: string | null;
}

function validateVendor(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const vendor = value.trim();
    if (vendor.length > 255) throw new HomeValidationError('Vendor too long (max 255)');
    return vendor || null;
}

/**
 * Log a service. When linked to a task, the task's last_done advances to the
 * service date if that's newer than what's recorded (backfilled history never
 * rolls the schedule backwards).
 */
export async function createServiceEntry(
    bookGuid: string,
    input: ServiceEntryInput,
): Promise<HomeServiceEntry> {
    if (!input.serviceDate) throw new HomeValidationError('serviceDate is required');
    const serviceDate = parseOptionalDate(input.serviceDate, 'serviceDate');
    if (!serviceDate) throw new HomeValidationError('serviceDate must be YYYY-MM-DD');

    let task: Awaited<ReturnType<typeof getOwnedTask>> | null = null;
    if (input.taskId !== null && input.taskId !== undefined) {
        task = await getOwnedTask(bookGuid, input.taskId);
    }
    if (input.itemId !== null && input.itemId !== undefined) {
        await assertItemOwned(bookGuid, input.itemId);
    }

    const row = await prisma.gnucash_web_home_service_log.create({
        data: {
            book_guid: bookGuid,
            task_id: input.taskId ?? null,
            item_id: input.itemId ?? null,
            service_date: serviceDate,
            cost: parseOptionalValue(input.cost, 'cost'),
            vendor: validateVendor(input.vendor),
            txn_guid: parseOptionalGuid(input.txnGuid),
            notes: input.notes?.trim() || null,
        },
        include: SERVICE_ENTRY_INCLUDE,
    });

    if (task && (!task.last_done || serviceDate.getTime() > task.last_done.getTime())) {
        await prisma.gnucash_web_home_tasks.update({
            where: { id: task.id },
            data: { last_done: serviceDate, updated_at: new Date() },
        });
    }

    return mapServiceEntry(row);
}

async function getOwnedServiceEntry(bookGuid: string, id: number) {
    const row = await prisma.gnucash_web_home_service_log.findUnique({ where: { id } });
    if (!row || row.book_guid !== bookGuid) throw new HomeNotFoundError('Service entry not found');
    return row;
}

export async function updateServiceEntry(
    bookGuid: string,
    id: number,
    input: ServiceEntryInput,
): Promise<HomeServiceEntry> {
    await getOwnedServiceEntry(bookGuid, id);

    const data: {
        task_id?: number | null;
        item_id?: number | null;
        service_date?: Date;
        cost?: number | null;
        vendor?: string | null;
        txn_guid?: string | null;
        notes?: string | null;
    } = {};

    if (input.taskId !== undefined) {
        if (input.taskId !== null) await getOwnedTask(bookGuid, input.taskId);
        data.task_id = input.taskId;
    }
    if (input.itemId !== undefined) {
        if (input.itemId !== null) await assertItemOwned(bookGuid, input.itemId);
        data.item_id = input.itemId;
    }
    if (input.serviceDate !== undefined) {
        const d = parseOptionalDate(input.serviceDate, 'serviceDate');
        if (!d) throw new HomeValidationError('serviceDate must be YYYY-MM-DD');
        data.service_date = d;
    }
    if (input.cost !== undefined) data.cost = parseOptionalValue(input.cost, 'cost');
    if (input.vendor !== undefined) data.vendor = validateVendor(input.vendor);
    if (input.txnGuid !== undefined) data.txn_guid = parseOptionalGuid(input.txnGuid);
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

    const row = await prisma.gnucash_web_home_service_log.update({
        where: { id },
        data,
        include: SERVICE_ENTRY_INCLUDE,
    });
    return mapServiceEntry(row);
}

export async function deleteServiceEntry(bookGuid: string, id: number): Promise<void> {
    await getOwnedServiceEntry(bookGuid, id);
    await prisma.gnucash_web_home_service_log.delete({ where: { id } });
}

/* ------------------------------------------------------------------ */
/* Summary                                                              */
/* ------------------------------------------------------------------ */

export async function getHomeSummary(bookGuid: string): Promise<HomeSummary> {
    const today = new Date();
    const [rooms, items, tasks, costYtd] = await Promise.all([
        listRooms(bookGuid),
        prisma.gnucash_web_home_items.findMany({
            where: { book_guid: bookGuid },
            select: {
                id: true,
                room_id: true,
                name: true,
                est_value: true,
                warranty_expires: true,
            },
        }),
        listTasks(bookGuid),
        serviceCostForYear(bookGuid, today.getUTCFullYear()),
    ]);

    const roomSummaries = summarizeRooms(
        rooms,
        items.map((i) => ({ roomId: i.room_id, estValue: decimalToNumber(i.est_value) })),
    );

    const roomNames = new Map(rooms.map((r) => [r.id, r.name]));
    const warrantyInputs = items
        .filter((i) => i.warranty_expires !== null)
        .map((i) => ({
            itemId: i.id,
            itemName: i.name,
            roomId: i.room_id,
            roomName: roomNames.get(i.room_id) ?? 'Unknown room',
            warrantyExpires: toIsoDate(i.warranty_expires) as string,
        }));
    const { expired, expiringSoon } = bucketWarranties(warrantyInputs, today);

    return {
        rooms: roomSummaries,
        totalItems: items.length,
        totalValue: round2(roomSummaries.reduce((sum, r) => sum + r.totalValue, 0)),
        warrantyExpired: expired,
        warrantyExpiringSoon: expiringSoon,
        warrantyWarningDays: WARRANTY_WARNING_DAYS,
        tasksOverdue: tasks.filter((t) => t.status === 'overdue').length,
        tasksDueSoon: tasks.filter((t) => t.status === 'due_soon').length,
        maintenanceCostYtd: costYtd,
    };
}
