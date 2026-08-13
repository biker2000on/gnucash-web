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
        splits: { findMany: vi.fn(), update: vi.fn() },
        gnucash_web_tags: { findMany: vi.fn() },
        gnucash_web_transaction_tags: { deleteMany: vi.fn(), createMany: vi.fn() },
        $transaction: vi.fn(),
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
        expect(prismaMock.splits.update).not.toHaveBeenCalled();
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
        expect(prismaMock.splits.update).toHaveBeenCalledWith({
            where: { guid: COUNTER_SPLIT },
            data: { account_guid: TARGET_ACCOUNT },
        });
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
        expect(prismaMock.transactions.update).toHaveBeenCalledWith({
            where: { guid: TX_GUID },
            data: { description: 'King Soopers', enter_date: expect.any(Date) },
        });
    });
});
