/**
 * Route tests for /api/transactions/[guid] PUT + DELETE — mandatory
 * in-transaction optimistic concurrency (original_enter_date token).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    validateTransactionMock,
    logAuditMock,
    snapshotTransactionByGuidMock,
    processMultiCurrencySplitsMock,
    getBookAccountGuidsMock,
    getActiveBookGuidMock,
    cacheInvalidateFromMock,
    assertNotLockedMock,
} = vi.hoisted(() => {
    const prisma = {
        transactions: {
            findUnique: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
        },
        splits: {
            findMany: vi.fn(),
            deleteMany: vi.fn(),
            create: vi.fn(),
            count: vi.fn(),
        },
        accounts: { findMany: vi.fn() },
        commodities: { findUnique: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
    };
    return {
        prismaMock: prisma,
        requireRoleMock: vi.fn(),
        validateTransactionMock: vi.fn(),
        logAuditMock: vi.fn(),
        snapshotTransactionByGuidMock: vi.fn(),
        processMultiCurrencySplitsMock: vi.fn(),
        getBookAccountGuidsMock: vi.fn(),
        getActiveBookGuidMock: vi.fn(),
        cacheInvalidateFromMock: vi.fn(),
        assertNotLockedMock: vi.fn(),
    };
});

vi.mock('@/lib/prisma', () => ({
    default: prismaMock,
    toDecimal: vi.fn(() => '0.00'),
    generateGuid: vi.fn(() => 'f'.repeat(32)),
}));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/validation', () => ({ validateTransaction: validateTransactionMock }));
vi.mock('@/lib/services/audit.service', () => ({
    logAudit: logAuditMock,
    snapshotTransactionByGuid: snapshotTransactionByGuidMock,
}));
vi.mock('@/lib/trading-accounts', () => ({
    processMultiCurrencySplits: processMultiCurrencySplitsMock,
}));
vi.mock('@/lib/book-scope', () => ({
    getBookAccountGuids: getBookAccountGuidsMock,
    getActiveBookGuid: getActiveBookGuidMock,
}));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: cacheInvalidateFromMock }));
vi.mock('@/lib/services/period-lock.service', () => {
    class PeriodLockedError extends Error {
        readonly code = 'PERIOD_LOCKED';
        constructor(readonly lockDate: string) {
            super(`Period locked: transactions on or before ${lockDate} are closed`);
        }
    }
    return {
        PeriodLockedError,
        assertNotLocked: assertNotLockedMock,
        periodLockedResponse: vi.fn(),
    };
});

import { PUT, DELETE } from '../route';

const TX_GUID = 't'.repeat(32);
const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);
const BOOK_GUID = 'c'.repeat(32);
const CURRENT_ENTER_DATE = new Date('2026-07-01T10:00:00.000Z');
const POST_DATE = new Date('2026-07-15T12:00:00.000Z');

const validBody = {
    currency_guid: 'd'.repeat(32),
    post_date: '2026-07-15',
    description: 'Updated description',
    splits: [
        {
            account_guid: ACCOUNT_A,
            value_num: 100, value_denom: 100,
            quantity_num: 100, quantity_denom: 100,
        },
        {
            account_guid: ACCOUNT_B,
            value_num: -100, value_denom: 100,
            quantity_num: -100, quantity_denom: 100,
        },
    ],
};

function putRequest(body: Record<string, unknown>): Request {
    return new Request(`http://localhost/api/transactions/${TX_GUID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function deleteRequest(query = ''): Request {
    return new Request(`http://localhost/api/transactions/${TX_GUID}${query}`, {
        method: 'DELETE',
    });
}

const routeParams = { params: Promise.resolve({ guid: TX_GUID }) };

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({
        user: { id: 1, username: 'editor' },
        role: 'edit',
        bookGuid: BOOK_GUID,
    });
    validateTransactionMock.mockReturnValue({ valid: true, errors: [] });
    prismaMock.accounts.findMany.mockResolvedValue([
        { guid: ACCOUNT_A },
        { guid: ACCOUNT_B },
    ]);
    // Interactive transaction: run the callback against the same mock client.
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
    // Row lock read
    prismaMock.$queryRaw.mockResolvedValue([{
        guid: TX_GUID,
        enter_date: CURRENT_ENTER_DATE,
        post_date: POST_DATE,
        description: 'Old description',
    }]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.splits.findMany.mockResolvedValue([]);
    prismaMock.splits.count.mockResolvedValue(2);
    prismaMock.splits.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.splits.create.mockResolvedValue({});
    prismaMock.transactions.update.mockResolvedValue({});
    prismaMock.transactions.delete.mockResolvedValue({});
    prismaMock.transactions.findUnique.mockResolvedValue({
        guid: TX_GUID,
        currency_guid: validBody.currency_guid,
        num: '',
        post_date: POST_DATE,
        enter_date: new Date('2026-07-28T00:00:00.000Z'),
        description: validBody.description,
        splits: [],
    });
    processMultiCurrencySplitsMock.mockImplementation(async (splits: unknown[]) => ({
        allSplits: splits,
        isMultiCurrency: false,
    }));
    snapshotTransactionByGuidMock.mockResolvedValue({ description: 'Old description' });
    logAuditMock.mockResolvedValue(undefined);
    getActiveBookGuidMock.mockResolvedValue(BOOK_GUID);
    cacheInvalidateFromMock.mockResolvedValue(undefined);
    assertNotLockedMock.mockResolvedValue(undefined);
});

describe('PUT /api/transactions/[guid] optimistic concurrency', () => {
    it('428s when original_enter_date is missing, without touching the DB', async () => {
        const response = await PUT(putRequest({ ...validBody }), routeParams);
        const body = await response.json();

        expect(response.status).toBe(428);
        expect(body.code).toBe('original_enter_date_required');
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('400s on a malformed original_enter_date', async () => {
        const response = await PUT(
            putRequest({ ...validBody, original_enter_date: 'not-a-date' }),
            routeParams,
        );
        expect(response.status).toBe(400);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('409s with code "conflict" when the row was modified since the client read it', async () => {
        const response = await PUT(
            putRequest({
                ...validBody,
                original_enter_date: '2026-06-01T00:00:00.000Z', // stale token
            }),
            routeParams,
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body).toEqual({
            error: 'Transaction was modified by another user',
            code: 'conflict',
        });
        // Nothing was written
        expect(prismaMock.transactions.update).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
    });

    it('updates when the token matches, bumps enter_date, and returns the new enter_date', async () => {
        const response = await PUT(
            putRequest({
                ...validBody,
                original_enter_date: CURRENT_ENTER_DATE.toISOString(),
            }),
            routeParams,
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        // The version check ran against a FOR UPDATE row lock inside the tx
        const lockSql = prismaMock.$queryRaw.mock.calls
            .map((call: unknown[]) => (call[0] as TemplateStringsArray).join('?'))
            .join('\n');
        expect(lockSql).toContain('FOR UPDATE');
        // enter_date always bumped to a fresh timestamp
        const updateData = prismaMock.transactions.update.mock.calls[0][0].data;
        expect(updateData.enter_date).toBeInstanceOf(Date);
        expect(updateData.enter_date.getTime()).toBeGreaterThan(CURRENT_ENTER_DATE.getTime());
        // New enter_date returned so the client can chain edits
        expect(body.enter_date).toBe('2026-07-28T00:00:00.000Z');
        // Authoritative period-lock check ran with the cache bypassed
        expect(assertNotLockedMock).toHaveBeenCalledWith(
            BOOK_GUID,
            expect.any(Array),
            { bypassCache: true },
        );
        // The before-image snapshot ran ON THE TRANSACTION CLIENT (same
        // connection as the row lock), not on a second pool connection.
        expect(snapshotTransactionByGuidMock).toHaveBeenNthCalledWith(1, TX_GUID, prismaMock);
    });

    it('accepts an explicit null token when the row has no enter_date', async () => {
        prismaMock.$queryRaw.mockResolvedValue([{
            guid: TX_GUID, enter_date: null, post_date: POST_DATE,
        }]);

        const response = await PUT(
            putRequest({ ...validBody, original_enter_date: null }),
            routeParams,
        );
        expect(response.status).toBe(200);
    });

    it('404s when the transaction no longer exists', async () => {
        prismaMock.$queryRaw.mockResolvedValue([]);
        const response = await PUT(
            putRequest({ ...validBody, original_enter_date: CURRENT_ENTER_DATE.toISOString() }),
            routeParams,
        );
        expect(response.status).toBe(404);
    });
});

describe('DELETE /api/transactions/[guid] optimistic concurrency', () => {
    it('409s when the provided token no longer matches', async () => {
        const response = await DELETE(
            deleteRequest(`?original_enter_date=${encodeURIComponent('2026-06-01T00:00:00.000Z')}`),
            routeParams,
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.code).toBe('conflict');
        expect(prismaMock.transactions.delete).not.toHaveBeenCalled();
        // Extension meta untouched on conflict
        expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    });

    it('deletes when the token matches, with meta cleanup inside the transaction', async () => {
        const response = await DELETE(
            deleteRequest(`?original_enter_date=${encodeURIComponent(CURRENT_ENTER_DATE.toISOString())}`),
            routeParams,
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, deleted: TX_GUID });
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        // SimpleFin meta preservation + non-SimpleFin cleanup both ran in-tx
        const metaSql = prismaMock.$executeRaw.mock.calls
            .map((call: unknown[]) => (call[0] as TemplateStringsArray).join('?'))
            .join('\n');
        expect(metaSql).toContain('gnucash_web_transaction_meta');
        expect(prismaMock.splits.deleteMany).toHaveBeenCalled();
        expect(prismaMock.transactions.delete).toHaveBeenCalled();
        expect(logAuditMock).toHaveBeenCalledWith(
            'DELETE', 'TRANSACTION', TX_GUID, expect.anything(), null,
        );
        // The before-image snapshot ran ON THE TRANSACTION CLIENT (same
        // connection as the row lock), not on a second pool connection.
        expect(snapshotTransactionByGuidMock).toHaveBeenCalledWith(TX_GUID, prismaMock);
    });

    it('still deletes without a token (token is optional on DELETE)', async () => {
        const response = await DELETE(deleteRequest(), routeParams);
        expect(response.status).toBe(200);
        expect(prismaMock.transactions.delete).toHaveBeenCalled();
    });
});
