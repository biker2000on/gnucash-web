/**
 * Guard: delete paths must remove app slots with their objects.
 *
 * The slots table has no FK on obj_guid, so any path deleting a split or
 * transaction without also deleting its slots leaks orphans (897 orphaned
 * gnucash_web_generated rows were found in prod on 2026-08-04). These tests
 * drive the fixed paths against an in-memory slots store and assert the
 * slots of deleted objects are gone while slots of surviving objects stay.
 *
 * Covered paths:
 *  - DELETE /api/transactions/[guid]  (split + transaction slots)
 *  - PUT    /api/transactions/[guid]  (slots of splits dropped by the edit)
 *  - audit undo `delete_created`      (split + transaction slots)
 *  - audit undo `revert_update`       (slots of splits the revert removes)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TX = 't'.repeat(32);
const CUR = 'c'.repeat(32);
const ACCT = 'a'.repeat(32);
const SPLIT_KEEP = '1'.repeat(32);
const SPLIT_DROP = '2'.repeat(32);

interface SlotRow {
    obj_guid: string;
    name: string;
}

// In-memory slots store shared by prisma/tx mocks. deleteMany supports the
// only where-shape the fixed paths use: { obj_guid: { in: [...] } }.
const state = vi.hoisted(() => ({
    slotRows: [] as Array<{ obj_guid: string; name: string }>,
}));

const {
    prismaMock,
    txMock,
    requireRoleMock,
    assertNotLockedMock,
    validateTransactionMock,
    processMultiCurrencySplitsMock,
} = vi.hoisted(() => {
    const slotsDeleteMany = async ({ where }: { where: { obj_guid: { in?: string[] } | string } }) => {
        const objGuid = where.obj_guid;
        const guids = new Set(typeof objGuid === 'string' ? [objGuid] : (objGuid.in ?? []));
        const before = state.slotRows.length;
        state.slotRows = state.slotRows.filter((r) => !guids.has(r.obj_guid));
        return { count: before - state.slotRows.length };
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const txMock: any = {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(async () => 0),
        transactions: {
            findUnique: vi.fn(),
            update: vi.fn(async () => ({})),
            create: vi.fn(async () => ({})),
            delete: vi.fn(async () => ({})),
            deleteMany: vi.fn(async () => ({ count: 1 })),
        },
        splits: {
            findMany: vi.fn(async () => []),
            create: vi.fn(async () => ({})),
            deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        slots: {
            deleteMany: vi.fn(slotsDeleteMany),
        },
        lots: {
            findUnique: vi.fn(async () => null),
        },
    };

    const prismaMock: any = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock)),
        $queryRaw: vi.fn(async () => []),
        transactions: { findUnique: vi.fn(), findFirst: vi.fn() },
        accounts: { findMany: vi.fn(async () => []) },
        slots: { deleteMany: vi.fn(slotsDeleteMany) },
        gnucash_web_audit: {
            findUnique: vi.fn(),
            create: vi.fn(async () => ({})),
        },
        gnucash_web_transaction_meta: { findUnique: vi.fn(async () => null) },
    };

    return {
        prismaMock,
        txMock,
        requireRoleMock: vi.fn(),
        assertNotLockedMock: vi.fn(async () => undefined),
        validateTransactionMock: vi.fn(() => ({ valid: true, errors: [] })),
        processMultiCurrencySplitsMock: vi.fn(),
    };
});

vi.mock('@/lib/prisma', () => ({
    default: prismaMock,
    toDecimal: () => '0.00',
    generateGuid: () => 'f'.repeat(32),
}));
vi.mock('@/lib/auth', () => ({
    requireRole: requireRoleMock,
    getCurrentUser: vi.fn(async () => null),
}));
vi.mock('@/lib/book-scope', () => ({
    getBookAccountGuids: vi.fn(async () => [ACCT]),
    getActiveBookGuid: vi.fn(async () => 'book-1'),
}));
vi.mock('@/lib/cache', () => ({
    cacheInvalidateFrom: vi.fn(async () => undefined),
}));
vi.mock('@/lib/data-events', () => ({
    publishDataChange: vi.fn(async () => undefined),
    afterLedgerWrite: vi.fn(),
}));
vi.mock('@/lib/services/period-lock.service', () => ({
    assertNotLocked: assertNotLockedMock,
    PeriodLockedError: class PeriodLockedError extends Error {},
    periodLockedResponse: vi.fn(),
}));
vi.mock('@/lib/validation', () => ({
    validateTransaction: validateTransactionMock,
}));
vi.mock('@/lib/trading-accounts', () => ({
    processMultiCurrencySplits: processMultiCurrencySplitsMock,
}));
vi.mock('@/lib/gnucash', () => ({
    serializeBigInts: (x: unknown) => x,
}));

import { PUT, DELETE } from '@/app/api/transactions/[guid]/route';
import { undoAuditEntry } from '../services/audit.service';

function dbSplit(guid: string, lotGuid: string | null = null) {
    return {
        guid,
        tx_guid: TX,
        account_guid: ACCT,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: 100n,
        value_denom: 100n,
        quantity_num: 100n,
        quantity_denom: 100n,
        lot_guid: lotGuid,
        account: { name: 'Assets', commodity: { mnemonic: 'USD' } },
    };
}

function dbTxRow(splitGuids: string[]) {
    return {
        guid: TX,
        currency_guid: CUR,
        num: '',
        post_date: new Date('2026-05-01T00:00:00.000Z'),
        enter_date: null,
        description: 'guarded',
        splits: splitGuids.map((g) => dbSplit(g)),
    };
}

function snapSplit(guid: string) {
    return {
        guid,
        account_guid: ACCT,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: '100',
        value_denom: '100',
        quantity_num: '100',
        quantity_denom: '100',
        lot_guid: null,
    };
}

function snapshotOf(splitGuids: string[]) {
    return {
        snapshotVersion: 1,
        guid: TX,
        currency_guid: CUR,
        num: '',
        post_date: '2026-05-01T00:00:00.000Z',
        enter_date: null,
        description: 'guarded',
        splits: splitGuids.map(snapSplit),
    };
}

function slotNamesFor(objGuid: string): string[] {
    return state.slotRows.filter((r: SlotRow) => r.obj_guid === objGuid).map((r: SlotRow) => r.name);
}

beforeEach(() => {
    vi.clearAllMocks();
    // App slots on both splits and the transaction, plus an unrelated survivor.
    state.slotRows = [
        { obj_guid: SPLIT_KEEP, name: 'gnucash_web_generated' },
        { obj_guid: SPLIT_DROP, name: 'gnucash_web_generated' },
        { obj_guid: SPLIT_DROP, name: 'original_quantity_num' },
        { obj_guid: TX, name: 'gnucash_web_generated' },
        { obj_guid: 'unrelated-object', name: 'gnucash_web_generated' },
    ];
    requireRoleMock.mockResolvedValue({ bookGuid: 'book-1', role: 'edit' });
    txMock.$executeRaw.mockResolvedValue(0);
    assertNotLockedMock.mockResolvedValue(undefined);
});

describe('DELETE /api/transactions/[guid] removes slots with the transaction', () => {
    it('deletes slots of every split and of the transaction itself', async () => {
        txMock.$queryRaw.mockResolvedValue([
            { guid: TX, enter_date: null, post_date: new Date('2026-05-01'), description: 'guarded' },
        ]);
        txMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP, SPLIT_DROP]));
        txMock.splits.findMany.mockResolvedValue([{ guid: SPLIT_KEEP }, { guid: SPLIT_DROP }]);

        const request = {
            url: `http://localhost/api/transactions/${TX}?original_enter_date=null`,
        } as unknown as Request;
        const res = await DELETE(request, { params: Promise.resolve({ guid: TX }) });

        expect(res.status).toBe(200);
        expect(slotNamesFor(SPLIT_KEEP)).toEqual([]);
        expect(slotNamesFor(SPLIT_DROP)).toEqual([]);
        expect(slotNamesFor(TX)).toEqual([]);
        // Slots of unrelated objects survive.
        expect(slotNamesFor('unrelated-object')).toEqual(['gnucash_web_generated']);
    });
});

describe('PUT /api/transactions/[guid] removes slots of dropped splits only', () => {
    it('deletes slots for splits missing from the edited split set', async () => {
        txMock.$queryRaw.mockResolvedValue([
            { guid: TX, enter_date: null, post_date: new Date('2026-05-01') },
        ]);
        txMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP]));
        txMock.splits.findMany.mockResolvedValue([
            { ...dbSplit(SPLIT_KEEP) },
            { ...dbSplit(SPLIT_DROP) },
        ]);
        const editedSplits = [
            {
                guid: SPLIT_KEEP,
                account_guid: ACCT,
                memo: '',
                value_num: '100',
                value_denom: '100',
                quantity_num: '100',
                quantity_denom: '100',
            },
        ];
        processMultiCurrencySplitsMock.mockResolvedValue({ allSplits: editedSplits });

        const request = {
            json: async () => ({
                original_enter_date: null,
                currency_guid: CUR,
                description: 'guarded',
                post_date: '2026-05-01T00:00:00.000Z',
                splits: editedSplits,
            }),
        } as unknown as Request;
        prismaMock.accounts.findMany.mockResolvedValue([{ guid: ACCT }]);
        prismaMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP]));

        const res = await PUT(request, { params: Promise.resolve({ guid: TX }) });

        expect(res.status).toBe(200);
        // The dropped split's slots are gone...
        expect(slotNamesFor(SPLIT_DROP)).toEqual([]);
        // ...while the recreated same-guid split and the transaction keep theirs.
        expect(slotNamesFor(SPLIT_KEEP)).toEqual(['gnucash_web_generated']);
        expect(slotNamesFor(TX)).toEqual(['gnucash_web_generated']);
    });
});

describe('audit undo removes slots with the objects it deletes', () => {
    it('delete_created removes split and transaction slots', async () => {
        prismaMock.gnucash_web_audit.findUnique.mockResolvedValue({
            id: 7,
            book_guid: 'book-1',
            action: 'CREATE',
            entity_type: 'TRANSACTION',
            entity_guid: TX,
            old_values: null,
            new_values: snapshotOf([SPLIT_KEEP, SPLIT_DROP]),
        });
        prismaMock.$queryRaw.mockResolvedValue([]); // undone_at pre-check
        txMock.$queryRaw.mockResolvedValue([{ id: 7 }]); // claimUndo
        prismaMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP, SPLIT_DROP]));
        txMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP, SPLIT_DROP]));

        const result = await undoAuditEntry(7, 'book-1');

        expect(result.ok).toBe(true);
        expect(slotNamesFor(SPLIT_KEEP)).toEqual([]);
        expect(slotNamesFor(SPLIT_DROP)).toEqual([]);
        expect(slotNamesFor(TX)).toEqual([]);
        expect(slotNamesFor('unrelated-object')).toEqual(['gnucash_web_generated']);
    });

    it('revert_update removes slots of splits dropped by the revert, keeps restored ones', async () => {
        prismaMock.gnucash_web_audit.findUnique.mockResolvedValue({
            id: 8,
            book_guid: 'book-1',
            action: 'UPDATE',
            entity_type: 'TRANSACTION',
            entity_guid: TX,
            // Before-image had only SPLIT_KEEP; the update added SPLIT_DROP.
            old_values: snapshotOf([SPLIT_KEEP]),
            new_values: snapshotOf([SPLIT_KEEP, SPLIT_DROP]),
        });
        prismaMock.$queryRaw.mockResolvedValue([]);
        txMock.$queryRaw.mockResolvedValue([{ id: 8 }]);
        prismaMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP, SPLIT_DROP]));
        txMock.transactions.findUnique.mockResolvedValue(dbTxRow([SPLIT_KEEP, SPLIT_DROP]));
        txMock.splits.findMany.mockResolvedValue([{ guid: SPLIT_KEEP }, { guid: SPLIT_DROP }]);

        const result = await undoAuditEntry(8, 'book-1');

        expect(result.ok).toBe(true);
        // The split removed by the revert loses its slots...
        expect(slotNamesFor(SPLIT_DROP)).toEqual([]);
        // ...the restored same-guid split and the transaction keep theirs.
        expect(slotNamesFor(SPLIT_KEEP)).toEqual(['gnucash_web_generated']);
        expect(slotNamesFor(TX)).toEqual(['gnucash_web_generated']);
    });
});
