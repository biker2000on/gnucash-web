/**
 * Renewals & Contracts tracker
 *
 * Tracks things that renew on a date — insurance policies, vehicle
 * registrations, domains, memberships, service contracts — with a reminder
 * lead time. Rows live in gnucash_web_renewals (book-scoped).
 *
 * - "Renewed" advances renewal_date forward by cadence_months (repeatedly,
 *   until the date is in the future) and clears any dismissal.
 * - "Dismiss until" suppresses reminders through a date without moving the
 *   renewal.
 * - "Pull from subscriptions" imports recurring charges detected by the
 *   subscriptions tool (monthly/quarterly/annual series only) as renewal
 *   candidates, skipping names already tracked.
 *
 * Reminder dedupe: the daily worker creates at most one notification per
 * (user, renewal, renewal_date) via source='renewals' +
 * source_id='renewal:<id>:<renewal_date>'. Advancing the date changes the
 * source id, so the next cycle notifies again — re-runs never re-notify the
 * same cycle.
 */

import prisma from '@/lib/prisma';
import type { RecurringSeries } from '@/lib/recurring-detection';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type RenewalSource = 'manual' | 'subscription';

export interface Renewal {
    id: number;
    bookGuid: string;
    name: string;
    /** ISO YYYY-MM-DD */
    renewalDate: string;
    amount: number | null;
    cadenceMonths: number;
    remindDays: number;
    source: string;
    notes: string | null;
    /** ISO YYYY-MM-DD or null */
    dismissedUntil: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface RenewalInput {
    name: string;
    renewalDate: string;
    amount?: number | null;
    cadenceMonths?: number;
    remindDays?: number;
    notes?: string | null;
}

export interface RenewalCandidate {
    name: string;
    renewalDate: string;
    amount: number;
    cadenceMonths: number;
    remindDays: number;
    notes: string;
}

export class RenewalError extends Error {
    constructor(message: string, public status: number = 400) {
        super(message);
        this.name = 'RenewalError';
    }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* Pure date math (exported for tests)                                  */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** Today's date as ISO YYYY-MM-DD (UTC). */
export function todayIso(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

/**
 * Add calendar months to an ISO date, clamping to the target month's last
 * day (2026-01-31 + 1 month = 2026-02-28).
 */
export function addMonthsClamped(iso: string, months: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const monthIndex = m - 1 + months;
    const ty = y + Math.floor(monthIndex / 12);
    const tm = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return `${ty}-${pad2(tm + 1)}-${pad2(Math.min(d, lastDay))}`;
}

/**
 * Move a renewal date forward by its cadence. If the result is still not in
 * the future (long-overdue renewals), keep advancing until it is — a renewal
 * marked "renewed" should always land on the NEXT upcoming date.
 */
export function advanceRenewalDate(currentIso: string, cadenceMonths: number, today: string): string {
    const cadence = Math.max(1, Math.round(cadenceMonths));
    let next = addMonthsClamped(currentIso, cadence);
    let guard = 0;
    while (next <= today && guard++ < 600) {
        next = addMonthsClamped(next, cadence);
    }
    return next;
}

/** Whole days from today until the date (negative = overdue). */
export function daysUntil(dateIso: string, today: string): number {
    const target = Date.UTC(
        Number(dateIso.slice(0, 4)), Number(dateIso.slice(5, 7)) - 1, Number(dateIso.slice(8, 10)),
    );
    const base = Date.UTC(
        Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)),
    );
    return Math.round((target - base) / 86_400_000);
}

/**
 * Reminder window rule: a renewal is due for a reminder when today is within
 * remind_days of the renewal date (including overdue), unless it has been
 * dismissed through today.
 */
export function isReminderDue(
    renewal: { renewalDate: string; remindDays: number; dismissedUntil: string | null },
    today: string,
): boolean {
    if (renewal.dismissedUntil && renewal.dismissedUntil >= today) return false;
    return daysUntil(renewal.renewalDate, today) <= renewal.remindDays;
}

/** Notification dedupe key: one reminder per (renewal, cycle). */
export function renewalReminderSourceId(id: number, renewalDateIso: string): string {
    return `renewal:${id}:${renewalDateIso}`;
}

/* ------------------------------------------------------------------ */
/* Subscription import mapping (pure, exported for tests)               */
/* ------------------------------------------------------------------ */

/** Map a detected cadence to months; weekly series don't fit a monthly cadence. */
export function subscriptionCadenceToMonths(cadence: RecurringSeries['cadence']): number | null {
    switch (cadence) {
        case 'monthly': return 1;
        case 'quarterly': return 3;
        case 'annual': return 12;
        default: return null; // weekly — too fine-grained for a renewals tracker
    }
}

/** Sensible reminder lead by cadence: short for monthly, long for annual. */
export function defaultRemindDays(cadenceMonths: number): number {
    if (cadenceMonths >= 12) return 30;
    if (cadenceMonths >= 3) return 14;
    return 7;
}

/**
 * Turn a detected recurring-charge series into a renewal candidate, or null
 * when the series doesn't fit (weekly cadence, stopped series). The renewal
 * date is the series' next expected charge, advanced into the future when
 * detection lags.
 */
export function subscriptionToRenewalCandidate(
    series: Pick<RecurringSeries, 'merchantLabel' | 'cadence' | 'status' | 'nextExpected' | 'currentAmount' | 'accountName'>,
    today: string,
): RenewalCandidate | null {
    if (series.status === 'stopped') return null;
    const cadenceMonths = subscriptionCadenceToMonths(series.cadence);
    if (cadenceMonths === null) return null;

    const renewalDate = series.nextExpected > today
        ? series.nextExpected
        : advanceRenewalDate(series.nextExpected, cadenceMonths, today);

    return {
        name: series.merchantLabel,
        renewalDate,
        amount: Math.round(series.currentAmount * 100) / 100,
        cadenceMonths,
        remindDays: defaultRemindDays(cadenceMonths),
        notes: series.accountName ? `Detected from spending (${series.accountName})` : 'Detected from spending',
    };
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                          */
/* ------------------------------------------------------------------ */

type RenewalRow = {
    id: number;
    book_guid: string;
    name: string;
    renewal_date: Date;
    amount: unknown;
    cadence_months: number;
    remind_days: number;
    source: string;
    notes: string | null;
    dismissed_until: Date | null;
    created_at: Date;
    updated_at: Date;
};

function isoOf(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function mapRenewal(row: RenewalRow): Renewal {
    const amount = row.amount == null ? null : Number(row.amount);
    return {
        id: row.id,
        bookGuid: row.book_guid,
        name: row.name,
        renewalDate: isoOf(row.renewal_date),
        amount: amount != null && Number.isFinite(amount) ? amount : null,
        cadenceMonths: row.cadence_months,
        remindDays: row.remind_days,
        source: row.source,
        notes: row.notes,
        dismissedUntil: row.dismissed_until ? isoOf(row.dismissed_until) : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

function toDbDate(iso: string): Date {
    return new Date(`${iso}T00:00:00Z`);
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export function parseRenewalInput(body: unknown, { partial = false } = {}): Partial<RenewalInput> {
    const b = (body ?? {}) as Record<string, unknown>;
    const out: Partial<RenewalInput> = {};

    if (b.name !== undefined || !partial) {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name.length === 0 || name.length > 255) throw new RenewalError('Name is required (max 255 chars)');
        out.name = name;
    }
    if (b.renewalDate !== undefined || !partial) {
        const date = typeof b.renewalDate === 'string' ? b.renewalDate : '';
        if (!ISO_DATE_RE.test(date)) throw new RenewalError('Renewal date must be YYYY-MM-DD');
        out.renewalDate = date;
    }
    if (b.amount !== undefined) {
        if (b.amount === null || b.amount === '') {
            out.amount = null;
        } else {
            const n = Number(b.amount);
            if (!Number.isFinite(n) || n < 0) throw new RenewalError('Amount must be zero or more');
            out.amount = Math.round(n * 100) / 100;
        }
    }
    if (b.cadenceMonths !== undefined) {
        const n = Number(b.cadenceMonths);
        if (!Number.isInteger(n) || n < 1 || n > 120) throw new RenewalError('Cadence must be 1-120 months');
        out.cadenceMonths = n;
    }
    if (b.remindDays !== undefined) {
        const n = Number(b.remindDays);
        if (!Number.isInteger(n) || n < 0 || n > 365) throw new RenewalError('Remind days must be 0-365');
        out.remindDays = n;
    }
    if (b.notes !== undefined) {
        out.notes = typeof b.notes === 'string' && b.notes.trim() !== '' ? b.notes.trim() : null;
    }
    return out;
}

export async function listRenewals(bookGuid: string): Promise<Renewal[]> {
    const rows = await prisma.gnucash_web_renewals.findMany({
        where: { book_guid: bookGuid },
        orderBy: [{ renewal_date: 'asc' }, { name: 'asc' }],
    });
    return rows.map(r => mapRenewal(r as unknown as RenewalRow));
}

export async function createRenewal(bookGuid: string, input: Partial<RenewalInput>, source: RenewalSource = 'manual'): Promise<Renewal> {
    if (!input.name || !input.renewalDate) throw new RenewalError('Name and renewal date are required');
    const row = await prisma.gnucash_web_renewals.create({
        data: {
            book_guid: bookGuid,
            name: input.name,
            renewal_date: toDbDate(input.renewalDate),
            amount: input.amount ?? null,
            cadence_months: input.cadenceMonths ?? 12,
            remind_days: input.remindDays ?? 30,
            source,
            notes: input.notes ?? null,
        },
    });
    return mapRenewal(row as unknown as RenewalRow);
}

export async function updateRenewal(bookGuid: string, id: number, input: Partial<RenewalInput>): Promise<Renewal | null> {
    const existing = await prisma.gnucash_web_renewals.findFirst({ where: { id, book_guid: bookGuid } });
    if (!existing) return null;

    const data: Record<string, unknown> = { updated_at: new Date() };
    if (input.name !== undefined) data.name = input.name;
    if (input.renewalDate !== undefined) {
        data.renewal_date = toDbDate(input.renewalDate!);
        // A hand-edited date starts a fresh cycle — stale dismissals shouldn't
        // suppress its reminders.
        data.dismissed_until = null;
    }
    if (input.amount !== undefined) data.amount = input.amount;
    if (input.cadenceMonths !== undefined) data.cadence_months = input.cadenceMonths;
    if (input.remindDays !== undefined) data.remind_days = input.remindDays;
    if (input.notes !== undefined) data.notes = input.notes;

    const row = await prisma.gnucash_web_renewals.update({ where: { id }, data });
    return mapRenewal(row as unknown as RenewalRow);
}

export async function deleteRenewal(bookGuid: string, id: number): Promise<boolean> {
    const deleted = await prisma.gnucash_web_renewals.deleteMany({ where: { id, book_guid: bookGuid } });
    return deleted.count > 0;
}

/** Mark renewed: advance the date by the cadence and clear any dismissal. */
export async function markRenewalRenewed(bookGuid: string, id: number, today = todayIso()): Promise<Renewal | null> {
    const existing = await prisma.gnucash_web_renewals.findFirst({ where: { id, book_guid: bookGuid } });
    if (!existing) return null;
    const next = advanceRenewalDate(isoOf(existing.renewal_date), existing.cadence_months, today);
    const row = await prisma.gnucash_web_renewals.update({
        where: { id },
        data: { renewal_date: toDbDate(next), dismissed_until: null, updated_at: new Date() },
    });
    return mapRenewal(row as unknown as RenewalRow);
}

/** Suppress reminders through the given date (must be today or later). */
export async function dismissRenewalUntil(bookGuid: string, id: number, untilIso: string): Promise<Renewal | null> {
    if (!ISO_DATE_RE.test(untilIso)) throw new RenewalError('Dismiss-until must be YYYY-MM-DD');
    if (untilIso < todayIso()) throw new RenewalError('Dismiss-until must be today or later');
    const existing = await prisma.gnucash_web_renewals.findFirst({ where: { id, book_guid: bookGuid } });
    if (!existing) return null;
    const row = await prisma.gnucash_web_renewals.update({
        where: { id },
        data: { dismissed_until: toDbDate(untilIso), updated_at: new Date() },
    });
    return mapRenewal(row as unknown as RenewalRow);
}

/* ------------------------------------------------------------------ */
/* Import from subscriptions                                            */
/* ------------------------------------------------------------------ */

export interface ImportResult {
    imported: Renewal[];
    skippedExisting: number;
    candidates: number;
}

/**
 * Detect recurring charges from spending and import the monthly/quarterly/
 * annual ones as renewals (source 'subscription'), skipping series whose
 * name matches an existing renewal in the book (case-insensitive).
 */
export async function importRenewalsFromSubscriptions(
    bookGuid: string,
    bookAccountGuids: string[],
    today = todayIso(),
): Promise<ImportResult> {
    const { detectRecurringCharges } = await import('@/lib/recurring-detection');
    const detection = await detectRecurringCharges(bookAccountGuids, { months: 24, minOccurrences: 3 });

    const existing = await listRenewals(bookGuid);
    const existingNames = new Set(existing.map(r => r.name.trim().toLowerCase()));

    const imported: Renewal[] = [];
    let skippedExisting = 0;
    let candidates = 0;

    for (const series of detection.series) {
        const candidate = subscriptionToRenewalCandidate(series, today);
        if (!candidate) continue;
        candidates++;
        const nameKey = candidate.name.trim().toLowerCase();
        if (existingNames.has(nameKey)) {
            skippedExisting++;
            continue;
        }
        existingNames.add(nameKey);
        imported.push(await createRenewal(bookGuid, candidate, 'subscription'));
    }

    return { imported, skippedExisting, candidates };
}
