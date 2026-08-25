/**
 * SCOPE OF THESE ORDERING TESTS (read before trusting them)
 *
 * They assert the ORDER in which statements are issued against a mocked
 * Prisma client: that the `FOR UPDATE` lock statement is emitted before the
 * reconcile-state read, and the read before the write. That is exactly the
 * regression that has now recurred twice, so it is worth pinning.
 *
 * They do NOT prove:
 *   - that PostgreSQL actually acquires or holds the row lock (a no-op
 *     $queryRaw would satisfy every assertion here);
 *   - that a concurrent reconcile really blocks on it;
 *   - rollback behaviour, or that the canonical guid ordering prevents a real
 *     deadlock.
 *
 * Proving those needs two real database transactions and a barrier. This repo
 * has no real-database test harness (no TEST_DATABASE_URL, no postgres service
 * in docker-compose.yml, no testcontainers, and every prisma-touching test
 * mocks the client), and building one is out of scope here — it is filed as a
 * separate follow-up.
 */
/**
 * Route tests for PATCH /api/transactions/bulk — the reconciled/frozen split
 * guard on the recategorize operation (which re-books a split to another
 * account).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    getBookAccountGuidsMock,
    getActiveBookGuidMock,
    cacheInvalidateFromMock,
    publishDataChangeMock,
    withPeriodLockCheckMock,
    assertNotLockedMock,
} = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn() },
        transactions: { findMany: vi.fn(), update: vi.fn() },
        splits: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
        gnucash_web_tags: { findMany: vi.fn() },
        gnucash_web_transaction_tags: { deleteMany: vi.fn(), createMany: vi.fn() },
        $transaction: vi.fn(),
        // Canonical parent-transaction FOR UPDATE lock.
        $queryRaw: vi.fn(),
        // The batch's enter_date stamp, computed by the database above the
        // beez change feed's watermark (src/lib/enter-date.ts).
        $executeRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getBookAccountGuidsMock: vi.fn(),
    getActiveBookGuidMock: vi.fn(),
    cacheInvalidateFromMock: vi.fn(),
    publishDataChangeMock: vi.fn(),
    withPeriodLockCheckMock: vi.fn(),
    assertNotLockedMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
    // PATCH here still scopes with the session-derived getBookAccountGuids while
    // its single-transaction siblings have moved to the caller's-book variant.
    // Delegating means that migration cannot silently 404 these fixtures.
    getAccountGuidsForBook: vi.fn(() => getBookAccountGuidsMock()),
    getBookAccountGuids: getBookAccountGuidsMock,
    getActiveBookGuid: getActiveBookGuidMock,
}));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: cacheInvalidateFromMock }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: publishDataChangeMock }));
vi.mock('@/lib/services/period-lock.service', () => {
    class PeriodLockedError extends Error {
        readonly code = 'PERIOD_LOCKED';
    }
    return {
        PeriodLockedError,
        withPeriodLockCheck: withPeriodLockCheckMock,
        assertNotLocked: assertNotLockedMock,
        periodLockedResponse: vi.fn(),
    };
});

import { PATCH } from '../route';

const TX_GUID = 'transaction000000000000000000001';
const ANCHOR_SPLIT = 'split000000000000000000000anchor';
const COUNTER_SPLIT = 'split00000000000000000000counter';
const ANCHOR_ACCOUNT = 'account000000000000000000checking';
const COUNTER_ACCOUNT = 'account0000000000000000imbalance';
const TARGET_ACCOUNT = 'account000000000000000000grocery';
const COMMODITY = 'commodity00000000000000000000usd';
const BOOK_GUID = 'book0000000000000000000000000001';
const POST_DATE = new Date('2026-07-01T00:00:00.000Z');

function patchRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost/api/transactions/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** The pre-transaction snapshot the route plans the recategorize from. */
function txRow() {
    return {
        guid: TX_GUID,
        post_date: POST_DATE,
        description: 'KING SOOPERS',
        splits: [
            {
                guid: ANCHOR_SPLIT,
                account_guid: ANCHOR_ACCOUNT,
                account: {
                    guid: ANCHOR_ACCOUNT, name: 'Checking',
                    account_type: 'BANK', commodity_guid: COMMODITY,
                },
            },
            {
                guid: COUNTER_SPLIT,
                account_guid: COUNTER_ACCOUNT,
                account: {
                    guid: COUNTER_ACCOUNT, name: 'Imbalance-USD',
                    account_type: 'EXPENSE', commodity_guid: COMMODITY,
                },
            },
        ],
    };
}

/** The in-transaction live-state read of the same splits. */
function liveSplits(counterState: string) {
    return [
        {
            guid: ANCHOR_SPLIT, tx_guid: TX_GUID, account_guid: ANCHOR_ACCOUNT,
            reconcile_state: 'n', account: { name: 'Checking' },
        },
        {
            guid: COUNTER_SPLIT, tx_guid: TX_GUID, account_guid: COUNTER_ACCOUNT,
            reconcile_state: counterState, account: { name: 'Imbalance-USD' },
        },
    ];
}

const recategorizeBody = {
    transactionGuids: [TX_GUID],
    anchorAccountGuid: ANCHOR_ACCOUNT,
    set: { recategorize: { toAccountGuid: TARGET_ACCOUNT } },
};

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({
        user: { id: 1, username: 'editor' },
        role: 'edit',
        bookGuid: BOOK_GUID,
    });
    getBookAccountGuidsMock.mockResolvedValue([
        ANCHOR_ACCOUNT, COUNTER_ACCOUNT, TARGET_ACCOUNT,
    ]);
    getActiveBookGuidMock.mockResolvedValue(BOOK_GUID);
    prismaMock.accounts.findUnique.mockResolvedValue({
        guid: TARGET_ACCOUNT, commodity_guid: COMMODITY,
    });
    prismaMock.transactions.findMany.mockResolvedValue([txRow()]);
    prismaMock.transactions.update.mockResolvedValue({});
    prismaMock.splits.update.mockResolvedValue({});
    prismaMock.splits.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(1);
    withPeriodLockCheckMock.mockResolvedValue(null);
    assertNotLockedMock.mockResolvedValue(undefined);
    cacheInvalidateFromMock.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
});

describe('PATCH /api/transactions/bulk reconciled-split guard', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('423s when the counter-split is %s, and rolls the batch back', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue(liveSplits(state));

        const response = await PATCH(patchRequest(recategorizeBody));
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(COUNTER_SPLIT);
        expect(body.error).toContain('Imbalance-USD');
        expect(body.error).toMatch(/unreconcile/i);
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.transactions.update).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still recategorizes a %s counter-split', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue(liveSplits(state));

        const response = await PATCH(patchRequest(recategorizeBody));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.updated).toBe(1);
        // Belt and braces: the protected states are in the predicate too.
        expect(prismaMock.splits.updateMany).toHaveBeenCalledWith({
            where: {
                guid: COUNTER_SPLIT,
                reconcile_state: { notIn: ['y', 'f'] },
            },
            data: { account_guid: TARGET_ACCOUNT },
        });
    });

    /* TOCTOU. Opening a Prisma transaction takes no row locks — under READ
       COMMITTED a plain SELECT lets a concurrent reconcile commit between the
       guard's read and the write. These tests pin the lock/check/write
       ordering and the predicate backstop that close that window. */

    it('locks every targeted transaction FOR UPDATE before reading any split state', async () => {
        prismaMock.splits.findMany.mockResolvedValue(liveSplits('n'));

        await PATCH(patchRequest(recategorizeBody));

        const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
            (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'),
        );
        expect(lockCalls).toHaveLength(1);
        const sql = (lockCalls[0][0] as TemplateStringsArray).join('?');
        expect(sql).toContain('FROM transactions');
        expect(sql).toContain('ORDER BY guid');
        expect(lockCalls[0][1]).toEqual([TX_GUID]);

        // lock → reconcile-state read → split write, in that order.
        const lockOrder = prismaMock.$queryRaw.mock.invocationCallOrder[0];
        const readOrder = prismaMock.splits.findMany.mock.invocationCallOrder[0];
        const writeOrder = prismaMock.splits.updateMany.mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(readOrder);
        expect(readOrder).toBeLessThan(writeOrder);
    });

    it('locks the whole batch in one ordered statement, not per-row in iteration order', async () => {
        // Per-row locking in caller-supplied order is an ABBA deadlock with a
        // concurrent bulk edit of the same set in the opposite order.
        const TX_2 = 'transaction000000000000000000002';
        prismaMock.transactions.findMany.mockResolvedValue([txRow()]);
        prismaMock.splits.findMany.mockResolvedValue(liveSplits('n'));

        await PATCH(patchRequest({
            // Deliberately unsorted so the sort is observable.
            transactionGuids: [TX_2, TX_GUID],
            anchorAccountGuid: ANCHOR_ACCOUNT,
            set: { recategorize: { toAccountGuid: TARGET_ACCOUNT } },
        }));

        const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
            (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'),
        );
        expect(lockCalls).toHaveLength(1);
        expect(lockCalls[0][1]).toEqual([TX_GUID, TX_2].sort());
    });

    it('423s when the split is reconciled only by the time the write runs', async () => {
        // Model the losing interleaving: the guard's read still sees 'n'
        // (stale), but the write's own predicate excludes the row, so
        // updateMany reports zero. That must surface as the standard 423, not
        // as a silent skip reported as success.
        prismaMock.splits.findMany.mockResolvedValue(liveSplits('n'));
        prismaMock.splits.updateMany.mockResolvedValue({ count: 0 });

        const response = await PATCH(patchRequest(recategorizeBody));
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(COUNTER_SPLIT);
    });

    it('reads reconcile state INSIDE the transaction, not from the planning snapshot', async () => {
        prismaMock.splits.findMany.mockResolvedValue(liveSplits('y'));

        await PATCH(patchRequest(recategorizeBody));

        expect(prismaMock.splits.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tx_guid: { in: [TX_GUID] } },
            select: expect.objectContaining({ reconcile_state: true }),
        }));
    });

    it('leaves description-only edits of a reconciled transaction alone', async () => {
        // No recategorize → no split is re-booked, so the guard must not fire
        // and no reconcile-state lookup is needed.
        prismaMock.splits.findMany.mockResolvedValue(liveSplits('y'));

        const response = await PATCH(patchRequest({
            transactionGuids: [TX_GUID],
            set: { description: 'King Soopers' },
        }));

        expect(response.status).toBe(200);
        // No app-clock enter_date literal rides along with the description:
        // that column is the beez change feed's ordering key AND this app's
        // optimistic-lock token, and a `new Date()` from this host can land
        // below a cursor the feed already issued or inside the millisecond a
        // stale editor still names (src/lib/enter-date.ts).
        expect(prismaMock.transactions.update).toHaveBeenCalledWith({
            where: { guid: TX_GUID },
            data: { description: 'King Soopers' },
        });
        // The stamp is one database-side statement for the whole batch.
        expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
        const stampCall = prismaMock.$executeRaw.mock.calls[0];
        expect((stampCall[0] as TemplateStringsArray).join('?')).toContain('SET enter_date');
        expect((stampCall[1] as { sql: string }).sql).toContain('clock_timestamp()');
        expect(stampCall[2]).toEqual([TX_GUID]);
    });
});
