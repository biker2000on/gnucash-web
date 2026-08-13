import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    getAccountGuidsForBookMock,
    lockTransactionsForUpdateMock,
    publishDataChangeMock,
} = vi.hoisted(() => ({
    prismaMock: {
        splits: { findMany: vi.fn(), updateMany: vi.fn() },
        transactions: { updateMany: vi.fn() },
        $transaction: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getAccountGuidsForBookMock: vi.fn(),
    lockTransactionsForUpdateMock: vi.fn(),
    publishDataChangeMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: getAccountGuidsForBookMock }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: publishDataChangeMock }));
vi.mock('@/lib/services/reconciled-split.service', () => ({
    lockTransactionsForUpdate: lockTransactionsForUpdateMock,
}));

import { POST } from '../route';

const BOOK_A = 'book-a';
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';
const SPLIT_A = 'split-a';
const SPLIT_B = 'split-b';
const TX_A = 'transaction-a';
const TX_B = 'transaction-b';

type SplitRow = {
    guid: string;
    account_guid: string;
    tx_guid: string;
    reconcile_state: 'n' | 'c' | 'y';
    reconcile_date: Date | null;
};

let rows: SplitRow[];

function request(splits: string[]): Request {
    return new Request('http://localhost/api/splits/bulk/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splits, reconcile_state: 'y', reconcile_date: '2026-08-01' }),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    rows = [
        { guid: SPLIT_A, account_guid: ACCOUNT_A, tx_guid: TX_A, reconcile_state: 'n', reconcile_date: null },
        { guid: SPLIT_B, account_guid: ACCOUNT_B, tx_guid: TX_B, reconcile_state: 'n', reconcile_date: null },
    ];
    requireRoleMock.mockResolvedValue({
        user: { id: 1 }, role: 'edit', bookGuid: BOOK_A,
    });
    getAccountGuidsForBookMock.mockResolvedValue([ACCOUNT_A]);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
    prismaMock.splits.findMany.mockImplementation(async ({ where }: { where: { guid: { in: string[] }; account_guid?: { in: string[] } } }) => {
        const allowedAccounts = where.account_guid?.in;
        return rows
            .filter(row => where.guid.in.includes(row.guid))
            .filter(row => !allowedAccounts || allowedAccounts.includes(row.account_guid))
            .map(row => ({ guid: row.guid, tx_guid: row.tx_guid }));
    });
    prismaMock.splits.updateMany.mockImplementation(async ({ where, data }: {
        where: { guid: { in: string[] }; account_guid?: { in: string[] } };
        data: Pick<SplitRow, 'reconcile_state' | 'reconcile_date'>;
    }) => {
        const allowedAccounts = where.account_guid?.in;
        const matches = rows.filter(row =>
            where.guid.in.includes(row.guid)
            && (!allowedAccounts || allowedAccounts.includes(row.account_guid))
        );
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
    });
    prismaMock.transactions.updateMany.mockResolvedValue({ count: 1 });
    lockTransactionsForUpdateMock.mockResolvedValue(undefined);
});

describe('POST /api/splits/bulk/reconcile book scope', () => {
    it('reconciles a fully in-book batch', async () => {
        const response = await POST(request([SPLIT_A]));

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true, updated: 1, reconcile_state: 'y' });
        expect(rows.find(row => row.guid === SPLIT_A)).toMatchObject({ reconcile_state: 'y' });
        expect(getAccountGuidsForBookMock).toHaveBeenCalledWith(BOOK_A);
        expect(prismaMock.splits.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { guid: { in: [SPLIT_A] }, account_guid: { in: [ACCOUNT_A] } },
        }));
    });

    it('fails closed when the caller book resolves to no accounts', async () => {
        getAccountGuidsForBookMock.mockResolvedValue([]);

        const response = await POST(request([SPLIT_A]));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'One or more splits not found in this book' });
        expect(prismaMock.splits.findMany).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an out-of-book split without modifying its row', async () => {
        const response = await POST(request([SPLIT_B]));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'One or more splits not found in this book' });
        expect(rows.find(row => row.guid === SPLIT_B)).toMatchObject({ reconcile_state: 'n', reconcile_date: null });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a mixed batch atomically without changing either row', async () => {
        const response = await POST(request([SPLIT_A, SPLIT_B]));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'One or more splits not found in this book' });
        expect(rows).toEqual([
            expect.objectContaining({ guid: SPLIT_A, reconcile_state: 'n', reconcile_date: null }),
            expect.objectContaining({ guid: SPLIT_B, reconcile_state: 'n', reconcile_date: null }),
        ]);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });

    it('returns the scoped 404 through the catch when the locked re-read is short', async () => {
        prismaMock.splits.findMany
            .mockResolvedValueOnce([{ guid: SPLIT_A }])
            .mockResolvedValueOnce([]);

        const response = await POST(request([SPLIT_A]));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'One or more splits not found in this book' });
        expect(prismaMock.$transaction).toHaveBeenCalledOnce();
        expect(lockTransactionsForUpdateMock).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });

    it('returns the scoped 404 through the catch when the scoped write is short', async () => {
        prismaMock.splits.updateMany.mockResolvedValueOnce({ count: 0 });

        const response = await POST(request([SPLIT_A]));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'One or more splits not found in this book' });
        expect(prismaMock.$transaction).toHaveBeenCalledOnce();
        expect(lockTransactionsForUpdateMock).toHaveBeenCalledWith([TX_A], prismaMock);
        expect(prismaMock.transactions.updateMany).not.toHaveBeenCalled();
    });
});
