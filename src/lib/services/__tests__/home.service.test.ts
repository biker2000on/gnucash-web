/**
 * Home module — next-due computation (cadence, never-done, seasons),
 * summary math (room subtotals, warranty windows), and the service-log
 * side effect that advances a task's last_done.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { roomsModel, itemsModel, tasksModel, serviceLogModel, storageMock } = vi.hoisted(() => ({
    roomsModel: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
        aggregate: vi.fn(),
        create: vi.fn(),
        createMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    itemsModel: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    tasksModel: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        createMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    serviceLogModel: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    storageMock: {
        put: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        getUrl: vi.fn(),
    },
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_home_rooms: roomsModel,
        gnucash_web_home_items: itemsModel,
        gnucash_web_home_tasks: tasksModel,
        gnucash_web_home_service_log: serviceLogModel,
        gnucash_web_receipts: { findUnique: vi.fn() },
    },
}));

vi.mock('@/lib/storage/storage-backend', () => ({
    getStorageBackend: vi.fn(async () => storageMock),
    generateStorageKey: vi.fn(() => '2026/07/uuid.jpg'),
}));

vi.mock('@/lib/services/document-intake', () => ({
    RECEIPT_MAX_FILE_SIZE: 10 * 1024 * 1024,
    sanitizeFilename: (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200),
    detectReceiptMimeType: (buffer: Buffer) => {
        if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
        if (buffer[0] === 0x25 && buffer[1] === 0x50) return 'application/pdf';
        return null;
    },
}));

import {
    addMonthsClamped,
    computeNextDue,
    computeTaskStatus,
    seasonLabel,
    isValidSeason,
    daysUntil,
    summarizeRooms,
    bucketWarranties,
    seedDefaultRooms,
    createServiceEntry,
    setItemPhoto,
    DEFAULT_ROOMS,
    MAINTENANCE_TEMPLATE,
    HomeValidationError,
} from '../home.service';

const BOOK = 'b'.repeat(32);
const TODAY = new Date('2026-07-16T12:00:00.000Z');

beforeEach(() => {
    vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* Next-due computation                                                 */
/* ------------------------------------------------------------------ */

describe('addMonthsClamped', () => {
    it('adds whole months', () => {
        expect(addMonthsClamped(new Date('2026-01-15T00:00:00Z'), 3).toISOString().slice(0, 10))
            .toBe('2026-04-15');
    });

    it('clamps to month-end (Jan 31 + 1mo = Feb 28)', () => {
        expect(addMonthsClamped(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10))
            .toBe('2026-02-28');
    });

    it('clamps to Feb 29 in leap years', () => {
        expect(addMonthsClamped(new Date('2028-01-31T00:00:00Z'), 1).toISOString().slice(0, 10))
            .toBe('2028-02-29');
    });

    it('crosses year boundaries', () => {
        expect(addMonthsClamped(new Date('2026-11-10T00:00:00Z'), 3).toISOString().slice(0, 10))
            .toBe('2027-02-10');
    });
});

describe('computeNextDue', () => {
    it('cadence: last_done + cadence_months', () => {
        const next = computeNextDue(
            { cadenceMonths: 3, season: null, lastDone: '2026-05-01' },
            TODAY,
        );
        expect(next?.toISOString().slice(0, 10)).toBe('2026-08-01');
    });

    it('cadence with never-done returns null', () => {
        expect(computeNextDue({ cadenceMonths: 3, season: null, lastDone: null }, TODAY)).toBeNull();
    });

    it('cadence wins over season when both are set', () => {
        const next = computeNextDue(
            { cadenceMonths: 6, season: 'spring+fall', lastDone: '2026-04-05' },
            TODAY,
        );
        expect(next?.toISOString().slice(0, 10)).toBe('2026-10-05');
    });

    it('season-only: next anchor strictly after last_done', () => {
        // Sump pump tested Apr 2026 → next spring anchor is Apr 1 2027.
        const next = computeNextDue(
            { cadenceMonths: null, season: 'spring', lastDone: '2026-04-01' },
            TODAY,
        );
        expect(next?.toISOString().slice(0, 10)).toBe('2027-04-01');
    });

    it('season-only never-done: next upcoming anchor on/after today', () => {
        // Today is Jul 16 2026 → fall anchor Oct 1 2026.
        const next = computeNextDue(
            { cadenceMonths: null, season: 'fall', lastDone: null },
            TODAY,
        );
        expect(next?.toISOString().slice(0, 10)).toBe('2026-10-01');
    });

    it('season combo picks the nearest anchor', () => {
        const next = computeNextDue(
            { cadenceMonths: null, season: 'spring+fall', lastDone: '2026-04-10' },
            TODAY,
        );
        expect(next?.toISOString().slice(0, 10)).toBe('2026-10-01');
    });

    it('no cadence and no season returns null', () => {
        expect(computeNextDue({ cadenceMonths: null, season: null, lastDone: '2026-01-01' }, TODAY))
            .toBeNull();
    });
});

describe('computeTaskStatus', () => {
    it('overdue when next due is in the past', () => {
        expect(computeTaskStatus(new Date('2026-07-01T00:00:00Z'), true, TODAY)).toBe('overdue');
    });

    it('due_soon within 30 days (inclusive)', () => {
        expect(computeTaskStatus(new Date('2026-07-16T00:00:00Z'), true, TODAY)).toBe('due_soon');
        expect(computeTaskStatus(new Date('2026-08-15T00:00:00Z'), true, TODAY)).toBe('due_soon');
    });

    it('later beyond 30 days', () => {
        expect(computeTaskStatus(new Date('2026-08-16T00:00:00Z'), true, TODAY)).toBe('later');
    });

    it('never-done scheduled task surfaces as due_soon', () => {
        expect(computeTaskStatus(null, true, TODAY)).toBe('due_soon');
    });

    it('unscheduled task without a due date', () => {
        expect(computeTaskStatus(null, false, TODAY)).toBe('unscheduled');
    });
});

describe('season labels', () => {
    it('formats single seasons', () => {
        expect(seasonLabel('spring')).toBe('Spring');
        expect(seasonLabel('fall')).toBe('Fall');
    });

    it('formats combos', () => {
        expect(seasonLabel('spring+fall')).toBe('Spring + Fall');
    });

    it('null and junk pass through as null', () => {
        expect(seasonLabel(null)).toBeNull();
        expect(seasonLabel('monsoon')).toBeNull();
    });

    it('validates season strings', () => {
        expect(isValidSeason('spring')).toBe(true);
        expect(isValidSeason('spring+fall')).toBe(true);
        expect(isValidSeason('spring+monsoon')).toBe(false);
        expect(isValidSeason('')).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* Summary math                                                         */
/* ------------------------------------------------------------------ */

describe('summarizeRooms', () => {
    const rooms = [
        { id: 1, name: 'Kitchen', sortOrder: 0 },
        { id: 2, name: 'Garage', sortOrder: 1 },
        { id: 3, name: 'Office', sortOrder: 2 },
    ];

    it('counts and subtotals per room, null values count as items worth 0', () => {
        const items = [
            { roomId: 1, estValue: 1200.5 },
            { roomId: 1, estValue: 99.99 },
            { roomId: 1, estValue: null },
            { roomId: 2, estValue: 450 },
        ];
        const result = summarizeRooms(rooms, items);
        expect(result).toEqual([
            { id: 1, name: 'Kitchen', sortOrder: 0, itemCount: 3, totalValue: 1300.49 },
            { id: 2, name: 'Garage', sortOrder: 1, itemCount: 1, totalValue: 450 },
            { id: 3, name: 'Office', sortOrder: 2, itemCount: 0, totalValue: 0 },
        ]);
    });

    it('rounds floating point sums to cents', () => {
        const result = summarizeRooms(
            [rooms[0]],
            [
                { roomId: 1, estValue: 0.1 },
                { roomId: 1, estValue: 0.2 },
            ],
        );
        expect(result[0].totalValue).toBe(0.3);
    });
});

describe('warranty windows', () => {
    const alert = (id: number, expires: string) => ({
        itemId: id,
        itemName: `Item ${id}`,
        roomId: 1,
        roomName: 'Kitchen',
        warrantyExpires: expires,
    });

    it('buckets expired vs expiring within 90 days, ignores far-future', () => {
        const { expired, expiringSoon } = bucketWarranties(
            [
                alert(1, '2026-07-01'), // 15 days ago → expired
                alert(2, '2026-07-16'), // today → expiring soon (0)
                alert(3, '2026-10-14'), // 90 days out → expiring soon
                alert(4, '2026-10-15'), // 91 days out → neither
            ],
            TODAY,
        );
        expect(expired.map((a) => a.itemId)).toEqual([1]);
        expect(expired[0].daysUntil).toBe(-15);
        expect(expiringSoon.map((a) => a.itemId)).toEqual([2, 3]);
        expect(expiringSoon[1].daysUntil).toBe(90);
    });

    it('daysUntil is negative in the past, null without a date', () => {
        expect(daysUntil('2026-07-10', TODAY)).toBe(-6);
        expect(daysUntil('2026-07-26', TODAY)).toBe(10);
        expect(daysUntil(null, TODAY)).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Seeding + service-log side effects                                   */
/* ------------------------------------------------------------------ */

describe('seedDefaultRooms', () => {
    it('creates the default set only when the book has zero rooms', async () => {
        roomsModel.count.mockResolvedValue(0);
        roomsModel.createMany.mockResolvedValue({ count: DEFAULT_ROOMS.length });
        roomsModel.findMany.mockResolvedValue(
            DEFAULT_ROOMS.map((name, i) => ({
                id: i + 1,
                book_guid: BOOK,
                name,
                sort_order: i,
            })),
        );

        const rooms = await seedDefaultRooms(BOOK);
        expect(roomsModel.createMany).toHaveBeenCalledTimes(1);
        expect(rooms.map((r) => r.name)).toEqual([...DEFAULT_ROOMS]);
    });

    it('is a no-op when rooms already exist', async () => {
        roomsModel.count.mockResolvedValue(3);
        roomsModel.findMany.mockResolvedValue([]);
        await seedDefaultRooms(BOOK);
        expect(roomsModel.createMany).not.toHaveBeenCalled();
    });
});

describe('maintenance template', () => {
    it('covers the standard tasks with sane cadences', () => {
        const byName = new Map(MAINTENANCE_TEMPLATE.map((t) => [t.name, t]));
        expect(byName.get('Replace HVAC filter')?.cadenceMonths).toBe(3);
        expect(byName.get('Clean gutters')?.season).toBe('spring+fall');
        expect(byName.get('Test sump pump')?.season).toBe('spring');
        expect(byName.get('Winterize outdoor faucets')?.season).toBe('fall');
        expect(MAINTENANCE_TEMPLATE).toHaveLength(10);
    });
});

describe('createServiceEntry', () => {
    const taskRow = (lastDone: Date | null) => ({
        id: 7,
        book_guid: BOOK,
        name: 'Replace HVAC filter',
        cadence_months: 3,
        season: null,
        item_id: null,
        last_done: lastDone,
        active: true,
        notes: null,
    });

    const createdRow = {
        id: 99,
        book_guid: BOOK,
        task_id: 7,
        item_id: null,
        service_date: new Date('2026-07-10T00:00:00Z'),
        cost: 25.5,
        vendor: 'Self',
        txn_guid: null,
        notes: null,
        task: { name: 'Replace HVAC filter' },
        item: null,
    };

    it('advances the linked task last_done when the service date is newer', async () => {
        tasksModel.findUnique.mockResolvedValue(taskRow(new Date('2026-04-01T00:00:00Z')));
        serviceLogModel.create.mockResolvedValue(createdRow);

        const entry = await createServiceEntry(BOOK, {
            taskId: 7,
            serviceDate: '2026-07-10',
            cost: 25.5,
            vendor: 'Self',
        });

        expect(entry.serviceDate).toBe('2026-07-10');
        expect(entry.cost).toBe(25.5);
        expect(tasksModel.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 7 },
                data: expect.objectContaining({ last_done: new Date('2026-07-10T00:00:00Z') }),
            }),
        );
    });

    it('never rolls last_done backwards for backfilled history', async () => {
        tasksModel.findUnique.mockResolvedValue(taskRow(new Date('2026-07-12T00:00:00Z')));
        serviceLogModel.create.mockResolvedValue(createdRow);

        await createServiceEntry(BOOK, { taskId: 7, serviceDate: '2026-07-10' });
        expect(tasksModel.update).not.toHaveBeenCalled();
    });

    it('rejects a task from another book', async () => {
        tasksModel.findUnique.mockResolvedValue({ ...taskRow(null), book_guid: 'x'.repeat(32) });
        await expect(
            createServiceEntry(BOOK, { taskId: 7, serviceDate: '2026-07-10' }),
        ).rejects.toThrow('Task not found');
    });

    it('requires a valid service date', async () => {
        await expect(createServiceEntry(BOOK, { serviceDate: '07/10/2026' })).rejects.toThrow(
            HomeValidationError,
        );
        await expect(createServiceEntry(BOOK, {})).rejects.toThrow('serviceDate is required');
    });
});

describe('setItemPhoto', () => {
    const itemRow = {
        id: 5,
        book_guid: BOOK,
        room_id: 1,
        name: 'TV',
        category: 'electronics',
        est_value: 800,
        purchase_date: null,
        receipt_id: null,
        photo_key: null,
        warranty_expires: null,
        serial: null,
        notes: null,
    };

    it('rejects non-image files (PDF magic bytes)', async () => {
        itemsModel.findUnique.mockResolvedValue(itemRow);
        await expect(
            setItemPhoto(BOOK, 5, { buffer: Buffer.from('%PDF-1.4'), filename: 'doc.pdf' }),
        ).rejects.toThrow('Unsupported photo type');
        expect(storageMock.put).not.toHaveBeenCalled();
    });

    it('stores JPEGs under the home-items/ prefix', async () => {
        itemsModel.findUnique.mockResolvedValue(itemRow);
        itemsModel.update.mockResolvedValue({
            ...itemRow,
            photo_key: 'home-items/2026/07/uuid.jpg',
        });

        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
        const item = await setItemPhoto(BOOK, 5, { buffer: jpeg, filename: 'tv.jpg' });

        expect(storageMock.put).toHaveBeenCalledWith(
            'home-items/2026/07/uuid.jpg',
            jpeg,
            'image/jpeg',
        );
        expect(item.hasPhoto).toBe(true);
    });
});
