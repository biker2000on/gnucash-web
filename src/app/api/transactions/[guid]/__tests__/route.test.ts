/**
 * Route tests for /api/transactions/[guid] PUT + DELETE — mandatory
 * in-transaction optimistic concurrency (original_enter_date token) and the
 * reconciled/frozen split guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    validateTransactionMock,
    logAuditMock,
    snapshotTransactionByGuidMock,
    processMultiCurrencySplitsMock,
    getAccountGuidsForBookMock,
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
        slots: { deleteMany: vi.fn() },
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
        getAccountGuidsForBookMock: vi.fn(),
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
    getAccountGuidsForBook: getAccountGuidsForBookMock,
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
const FOREIGN_ACCOUNT = 'e'.repeat(32);
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
    const accountRows = [{ guid: ACCOUNT_A }, { guid: ACCOUNT_B }, { guid: FOREIGN_ACCOUNT }];
    // Deliberately honour the production `where` clause. A constant array
    // would let a scope assertion pass even if the route stopped scoping.
    prismaMock.accounts.findMany.mockImplementation(async ({ where }: { where: { guid?: { in?: string[] } } }) => {
        const wanted = where.guid?.in;
        return wanted ? accountRows.filter(row => wanted.includes(row.guid)) : accountRows;
    });
    getAccountGuidsForBookMock.mockResolvedValue([ACCOUNT_A, ACCOUNT_B]);
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
    prismaMock.slots.deleteMany.mockResolvedValue({ count: 0 });
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
            { bypassCache: true, client: prismaMock },
        );
        // The before-image snapshot ran ON THE TRANSACTION CLIENT (same
        // connection as the row lock), not on a second pool connection.
        expect(snapshotTransactionByGuidMock).toHaveBeenNthCalledWith(1, TX_GUID, prismaMock);
    });

    it('leaves transaction meta (incl. the preserved import payee) untouched on edit', async () => {
        const response = await PUT(
            putRequest({
                ...validBody,
                original_enter_date: CURRENT_ENTER_DATE.toISOString(),
            }),
            routeParams,
        );
        expect(response.status).toBe(200);
        // The edit path must never write gnucash_web_transaction_meta:
        // original_description is set once at import time, and a rename
        // (description edit) has to leave it intact. The prisma mock has no
        // meta model at all, so any model access would throw; raw writes are
        // asserted empty here.
        expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
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

describe('PUT /api/transactions/[guid] book scope', () => {
    it.each([
        ['a foreign account', [FOREIGN_ACCOUNT, FOREIGN_ACCOUNT]],
        ['a mixed in-book and foreign account request', [ACCOUNT_A, FOREIGN_ACCOUNT]],
    ])('404s on %s before any mutation', async (_label, accountGuids) => {
        const response = await PUT(putRequest({
            ...validBody,
            splits: validBody.splits.map((split, index) => ({
                ...split,
                account_guid: accountGuids[index],
            })),
            original_enter_date: CURRENT_ENTER_DATE.toISOString(),
        }), routeParams);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('One or more accounts not found in this book');
        expect(body.error).not.toContain(FOREIGN_ACCOUNT);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.transactions.update).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.splits.create).not.toHaveBeenCalled();
    });

    it('deduplicates repeated in-book account guids before validating scope', async () => {
        const response = await PUT(putRequest({
            ...validBody,
            splits: validBody.splits.map(split => ({ ...split, account_guid: ACCOUNT_A })),
            original_enter_date: CURRENT_ENTER_DATE.toISOString(),
        }), routeParams);

        expect(response.status).toBe(200);
        expect(getAccountGuidsForBookMock).toHaveBeenCalledWith(BOOK_GUID);
        expect(prismaMock.transactions.update).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the caller book has no accounts', async () => {
        getAccountGuidsForBookMock.mockResolvedValue([]);

        const response = await PUT(putRequest({
            ...validBody,
            original_enter_date: CURRENT_ENTER_DATE.toISOString(),
        }), routeParams);

        expect(response.status).toBe(404);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.transactions.update).not.toHaveBeenCalled();
    });

    it('does not lock or mutate a foreign transaction addressed by the path guid', async () => {
        // This fake honours the lock query's book predicate. If the predicate
        // is reverted, the same mutable foreign row is returned and the route
        // proceeds to its transaction/split writes.
        prismaMock.$queryRaw.mockImplementation(async (query: TemplateStringsArray | { strings?: TemplateStringsArray }) => {
            const sql = Array.isArray(query)
                ? query.join('?')
                : (query as { strings?: TemplateStringsArray }).strings?.join('?') ?? '';
            return sql.includes('account_guid = ANY') ? [] : [{
                guid: TX_GUID,
                enter_date: CURRENT_ENTER_DATE,
                post_date: POST_DATE,
            }];
        });

        const response = await PUT(putRequest({
            ...validBody,
            original_enter_date: CURRENT_ENTER_DATE.toISOString(),
        }), routeParams);

        expect(response.status).toBe(404);
        expect(prismaMock.transactions.update).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
    });
});

/**
 * A live split row as the route reads it inside the DB transaction (PUT reads
 * with an account include; DELETE selects the same fields).
 */
function liveSplit(reconcileState: string, guid = 's'.repeat(32)) {
    return {
        guid,
        tx_guid: TX_GUID,
        account_guid: ACCOUNT_A,
        memo: '',
        action: '',
        reconcile_state: reconcileState,
        reconcile_date: null,
        value_num: 100n,
        value_denom: 100n,
        quantity_num: 100n,
        quantity_denom: 100n,
        lot_guid: null,
        account: { name: 'Assets:Checking' },
    };
}

describe('PUT /api/transactions/[guid] reconciled-split guard', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('423s on a %s split and writes nothing', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue([liveSplit(state)]);

        const response = await PUT(
            putRequest({ ...validBody, original_enter_date: CURRENT_ENTER_DATE.toISOString() }),
            routeParams,
        );
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain('s'.repeat(32));
        expect(body.error).toContain('Assets:Checking');
        expect(body.error).toMatch(/unreconcile/i);
        // The guard fires before ANY write in the transaction.
        expect(prismaMock.transactions.update).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.splits.create).not.toHaveBeenCalled();
        expect(logAuditMock).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still edits a %s split normally', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue([liveSplit(state)]);

        const response = await PUT(
            putRequest({ ...validBody, original_enter_date: CURRENT_ENTER_DATE.toISOString() }),
            routeParams,
        );

        expect(response.status).toBe(200);
        expect(prismaMock.transactions.update).toHaveBeenCalled();
        expect(prismaMock.splits.create).toHaveBeenCalled();
    });
});

describe('DELETE /api/transactions/[guid] reconciled-split guard', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('423s on a %s split and destroys nothing', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue([liveSplit(state)]);

        const response = await DELETE(
            deleteRequest(`?original_enter_date=${encodeURIComponent(CURRENT_ENTER_DATE.toISOString())}`),
            routeParams,
        );
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain('s'.repeat(32));
        expect(body.error).toMatch(/delete this transaction/i);
        // Nothing destroyed — not the splits, not the transaction, and not the
        // SimpleFin dedup meta (which the route rewrites before the deletes).
        expect(prismaMock.transactions.delete).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.slots.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
        expect(logAuditMock).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still deletes a %s split normally', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue([liveSplit(state)]);

        const response = await DELETE(
            deleteRequest(`?original_enter_date=${encodeURIComponent(CURRENT_ENTER_DATE.toISOString())}`),
            routeParams,
        );

        expect(response.status).toBe(200);
        expect(prismaMock.transactions.delete).toHaveBeenCalled();
    });
});

describe('DELETE /api/transactions/[guid] book scope', () => {
    it('does not delete a foreign transaction addressed by the path guid', async () => {
        prismaMock.$queryRaw.mockImplementation(async (query: TemplateStringsArray | { strings?: TemplateStringsArray }) => {
            const sql = Array.isArray(query)
                ? query.join('?')
                : (query as { strings?: TemplateStringsArray }).strings?.join('?') ?? '';
            return sql.includes('account_guid = ANY') ? [] : [{
                guid: TX_GUID,
                enter_date: CURRENT_ENTER_DATE,
                post_date: POST_DATE,
                description: 'Foreign transaction',
            }];
        });

        const response = await DELETE(
            deleteRequest(`?original_enter_date=${encodeURIComponent(CURRENT_ENTER_DATE.toISOString())}`),
            routeParams,
        );

        expect(response.status).toBe(404);
        expect(prismaMock.transactions.delete).not.toHaveBeenCalled();
        expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
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

    it('refuses to delete without a token (428, same contract as PUT)', async () => {
        const response = await DELETE(deleteRequest(), routeParams);
        const body = await response.json();
        expect(response.status).toBe(428);
        expect(body.code).toBe('original_enter_date_required');
        expect(prismaMock.transactions.delete).not.toHaveBeenCalled();
    });
});
