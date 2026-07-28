/**
 * Route tests for POST /api/splits/bulk/move — canonical lock ordering.
 *
 * The deadlock-safe ordering shared by every split-writing path is:
 * lock the parent TRANSACTION rows first (ordered by guid, FOR UPDATE),
 * then write the splits, then bump enter_date on the already-locked rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    withPeriodLockCheckMock,
    assertNotLockedMock,
    cacheInvalidateFromMock,
    publishDataChangeMock,
} = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn() },
        splits: { findMany: vi.fn(), updateMany: vi.fn() },
        transactions: { updateMany: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    withPeriodLockCheckMock: vi.fn(),
    assertNotLockedMock: vi.fn(),
    cacheInvalidateFromMock: vi.fn(),
    publishDataChangeMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
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

import { POST } from '../route';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SPLIT_1 = 'split000000000000000000000000001';
const SPLIT_2 = 'split000000000000000000000000002';
const SPLIT_3 = 'split000000000000000000000000003';
// Deliberately out of sorted order so the sort is observable.
const TX_B = 'transaction00000000000000000000b';
const TX_A = 'transaction00000000000000000000a';
const TARGET_ACCOUNT = 'account0000000000000000000target';
const COMMODITY = 'commodity00000000000000000000usd';
const BOOK_GUID = 'book0000000000000000000000000001';
const POST_DATE = new Date('2026-07-01T00:00:00.000Z');

function moveRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost/api/splits/bulk/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function sqlText(call: unknown[]): string {
    return (call[0] as TemplateStringsArray).join('?');
}

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({
        user: { id: 1, username: 'editor' },
        role: 'edit',
        bookGuid: BOOK_GUID,
    });
    prismaMock.accounts.findUnique.mockResolvedValue({
        guid: TARGET_ACCOUNT,
        commodity_guid: COMMODITY,
    });
    // Pre-transaction validation read (with account + transaction includes).
    prismaMock.splits.findMany.mockResolvedValue([
        {
            guid: SPLIT_1, tx_guid: TX_B,
            account: { commodity_guid: COMMODITY },
            transaction: { post_date: POST_DATE },
        },
        {
            guid: SPLIT_2, tx_guid: TX_A,
            account: { commodity_guid: COMMODITY },
            transaction: { post_date: POST_DATE },
        },
        {
            guid: SPLIT_3, tx_guid: TX_A,
            account: { commodity_guid: COMMODITY },
            transaction: { post_date: POST_DATE },
        },
    ]);
    withPeriodLockCheckMock.mockResolvedValue(null);
    assertNotLockedMock.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.splits.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.transactions.updateMany.mockResolvedValue({ count: 2 });
    cacheInvalidateFromMock.mockResolvedValue(undefined);
});

describe('POST /api/splits/bulk/move canonical lock order', () => {
    it('locks parent TRANSACTION rows (ordered) BEFORE writing splits, then bumps enter_date', async () => {
        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1, SPLIT_2, SPLIT_3],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, updated: 3 });

        // The lock query targets transactions rows, deterministically ordered.
        const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
            (call: unknown[]) => sqlText(call).includes('FOR UPDATE'),
        );
        expect(lockCalls).toHaveLength(1);
        const lockSql = sqlText(lockCalls[0]);
        expect(lockSql).toContain('FROM transactions');
        expect(lockSql).toContain('ORDER BY guid');
        expect(lockSql).not.toContain('FROM splits');
        // Distinct parent tx guids, sorted (canonical, deterministic order).
        expect(lockCalls[0][1]).toEqual([TX_A, TX_B]);

        // Ordering: transactions-row lock → splits write → enter_date bump.
        const lockOrder = prismaMock.$queryRaw.mock.invocationCallOrder[0];
        const splitsWriteOrder = prismaMock.splits.updateMany.mock.invocationCallOrder[0];
        const bumpOrder = prismaMock.transactions.updateMany.mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(splitsWriteOrder);
        expect(splitsWriteOrder).toBeLessThan(bumpOrder);

        // The bump targets exactly the locked transactions.
        expect(prismaMock.transactions.updateMany).toHaveBeenCalledWith({
            where: { guid: { in: [TX_A, TX_B] } },
            data: { enter_date: expect.any(Date) },
        });
    });

    it('rejects a currency mismatch before opening the transaction', async () => {
        prismaMock.splits.findMany.mockResolvedValue([
            {
                guid: SPLIT_1, tx_guid: TX_A,
                account: { commodity_guid: 'commodity000000000000000000other' },
                transaction: { post_date: POST_DATE },
            },
        ]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));

        expect(response.status).toBe(400);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });
});
