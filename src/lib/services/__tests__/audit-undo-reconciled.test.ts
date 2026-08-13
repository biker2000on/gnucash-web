/**
 * Reconciled/frozen split guard on the audit-undo write paths.
 *
 * Undo is a live ledger mutation: `revert_update` rewrites every split (amount
 * and account) plus the post date, and `delete_created` deletes the whole
 * transaction. Both must refuse when a split is reconciled ('y') or frozen
 * ('f') TODAY, whatever the archived snapshot said.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    getCurrentUserMock,
    getActiveBookGuidMock,
    assertNotLockedMock,
    afterLedgerWriteMock,
} = vi.hoisted(() => ({
    prismaMock: {
        gnucash_web_audit: { findUnique: vi.fn(), create: vi.fn() },
        transactions: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
        splits: { create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
        slots: { deleteMany: vi.fn() },
        lots: { findUnique: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
    getCurrentUserMock: vi.fn(),
    getActiveBookGuidMock: vi.fn(),
    assertNotLockedMock: vi.fn(),
    afterLedgerWriteMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock('@/lib/book-scope', () => ({ getActiveBookGuid: getActiveBookGuidMock }));
vi.mock('@/lib/services/period-lock.service', () => ({
    assertNotLocked: assertNotLockedMock,
}));
vi.mock('@/lib/data-events', () => ({ afterLedgerWrite: afterLedgerWriteMock }));

import { undoAuditEntry, snapshotTransactionByGuid } from '../audit.service';
import { ReconciledSplitError } from '../reconciled-split.service';

const BOOK_GUID = 'b'.repeat(32);
const TX_GUID = 't'.repeat(32);
const SPLIT_1 = 's1'.padEnd(32, '0');
const SPLIT_2 = 's2'.padEnd(32, '0');
const AUDIT_ID = 42;

/** A live transaction row as Prisma returns it (splits included). */
function dbTransaction(reconcileState: string) {
    return {
        guid: TX_GUID,
        currency_guid: 'c'.repeat(32),
        num: '',
        post_date: new Date('2026-05-01T00:00:00.000Z'),
        enter_date: new Date('2026-05-01T12:00:00.000Z'),
        description: 'Groceries',
        splits: [
            {
                guid: SPLIT_1,
                account_guid: 'x'.repeat(32),
                memo: '', action: '',
                reconcile_state: reconcileState,
                reconcile_date: null,
                value_num: -5000n, value_denom: 100n,
                quantity_num: -5000n, quantity_denom: 100n,
                lot_guid: null,
            },
            {
                guid: SPLIT_2,
                account_guid: 'y'.repeat(32),
                memo: '', action: '',
                reconcile_state: 'n',
                reconcile_date: null,
                value_num: 5000n, value_denom: 100n,
                quantity_num: 5000n, quantity_denom: 100n,
                lot_guid: null,
            },
        ],
    };
}

/** The snapshot the service derives from a live row (used as `new_values`). */
async function snapshotOf(reconcileState: string) {
    prismaMock.transactions.findUnique.mockResolvedValueOnce(dbTransaction(reconcileState));
    const snap = await snapshotTransactionByGuid(TX_GUID);
    return snap!;
}

function seedAuditEntry(entry: Record<string, unknown>) {
    prismaMock.gnucash_web_audit.findUnique.mockResolvedValue({
        id: AUDIT_ID,
        book_guid: BOOK_GUID,
        entity_type: 'TRANSACTION',
        entity_guid: TX_GUID,
        ...entry,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue({ id: 1 });
    getActiveBookGuidMock.mockResolvedValue(BOOK_GUID);
    assertNotLockedMock.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
    // $queryRaw serves two callers: the "already undone?" pre-check (must find
    // nothing) and claimUndo's UPDATE ... RETURNING id (must win the claim).
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('UPDATE gnucash_web_audit')) return Promise.resolve([{ id: AUDIT_ID }]);
        return Promise.resolve([]);
    });
    prismaMock.lots.findUnique.mockResolvedValue(null);
    prismaMock.splits.findMany.mockResolvedValue([]);
    prismaMock.splits.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.splits.create.mockResolvedValue({});
    prismaMock.slots.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.transactions.create.mockResolvedValue({});
    prismaMock.transactions.delete.mockResolvedValue({});
    prismaMock.transactions.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.gnucash_web_audit.create.mockResolvedValue({});
});

describe('undoAuditEntry — revert_update', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('refuses to revert onto a %s split, writing nothing', async (_label, state) => {
        const live = await snapshotOf(state);
        // old_values = the before-image to revert TO; new_values must match the
        // live state or the pre-existing drift check fires first.
        seedAuditEntry({
            action: 'UPDATE',
            old_values: { ...live, description: 'Old description' },
            new_values: live,
        });
        prismaMock.transactions.findUnique.mockResolvedValue(dbTransaction(state));

        const attempt = undoAuditEntry(AUDIT_ID, BOOK_GUID);
        await expect(attempt).rejects.toBeInstanceOf(ReconciledSplitError);
        await attempt.catch((err: ReconciledSplitError) => {
            expect(err.message).toContain(SPLIT_1);
            expect(err.message).toMatch(/revert this transaction/i);
        });

        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.transactions.create).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still reverts when the splits are %s', async (_label, state) => {
        const live = await snapshotOf(state);
        seedAuditEntry({
            action: 'UPDATE',
            old_values: { ...live, description: 'Old description' },
            new_values: live,
        });
        prismaMock.transactions.findUnique.mockResolvedValue(dbTransaction(state));

        const result = await undoAuditEntry(AUDIT_ID, BOOK_GUID);

        expect(result.ok).toBe(true);
        expect(prismaMock.splits.deleteMany).toHaveBeenCalled();
        expect(prismaMock.transactions.create).toHaveBeenCalled();
    });
});

describe('undoAuditEntry — delete_created', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('refuses to delete a transaction with a %s split', async (_label, state) => {
        seedAuditEntry({ action: 'CREATE', old_values: null, new_values: null });
        prismaMock.transactions.findUnique.mockResolvedValue(dbTransaction(state));

        const attempt = undoAuditEntry(AUDIT_ID, BOOK_GUID);
        await expect(attempt).rejects.toBeInstanceOf(ReconciledSplitError);
        await attempt.catch((err: ReconciledSplitError) => {
            expect(err.message).toContain(SPLIT_1);
            expect(err.message).toMatch(/delete this transaction/i);
        });

        expect(prismaMock.transactions.delete).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.slots.deleteMany).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still deletes a created transaction whose splits are %s', async (_label, state) => {
        seedAuditEntry({ action: 'CREATE', old_values: null, new_values: null });
        prismaMock.transactions.findUnique.mockResolvedValue(dbTransaction(state));

        const result = await undoAuditEntry(AUDIT_ID, BOOK_GUID);

        expect(result.ok).toBe(true);
        expect(prismaMock.transactions.delete).toHaveBeenCalledWith({ where: { guid: TX_GUID } });
    });
});
