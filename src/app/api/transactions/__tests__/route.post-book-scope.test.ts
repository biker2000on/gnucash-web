import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    getAccountGuidsForBookMock,
    validateTransactionMock,
    withPeriodLockCheckMock,
    processMultiCurrencySplitsMock,
    buildAccountPathMapMock,
} = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findMany: vi.fn() },
        transactions: { create: vi.fn(), findUnique: vi.fn() },
        splits: { create: vi.fn() },
        $transaction: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getAccountGuidsForBookMock: vi.fn(),
    validateTransactionMock: vi.fn(),
    withPeriodLockCheckMock: vi.fn(),
    processMultiCurrencySplitsMock: vi.fn(),
    buildAccountPathMapMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: prismaMock,
    toDecimal: vi.fn(() => '0.00'),
    generateGuid: vi.fn(() => 'f'.repeat(32)),
}));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
    getAccountGuidsForBook: getAccountGuidsForBookMock,
    getBookAccountGuids: vi.fn(),
    getActiveBookGuid: vi.fn(),
}));
vi.mock('@/lib/validation', () => ({
    validateTransaction: validateTransactionMock,
    summarizeValidationErrors: vi.fn(() => 'invalid'),
}));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: vi.fn(), snapshotTransactionByGuid: vi.fn() }));
vi.mock('@/lib/trading-accounts', () => ({ processMultiCurrencySplits: processMultiCurrencySplitsMock }));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/reports/utils', () => ({ buildAccountPathMap: buildAccountPathMapMock }));
vi.mock('@/lib/tags', () => ({ parseSearchQuery: vi.fn(), }));
vi.mock('@/lib/services/tag.service', () => ({ getTagsForTransactions: vi.fn() }));
vi.mock('@/lib/transaction-notes', () => ({ writeTransactionNotes: vi.fn() }));
vi.mock('@/lib/services/period-lock.service', () => ({
    withPeriodLockCheck: withPeriodLockCheckMock,
    assertNotLocked: vi.fn(),
    PeriodLockedError: class PeriodLockedError extends Error {},
    periodLockedResponse: vi.fn(),
}));

import { POST } from '../route';

const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);
const FOREIGN_ACCOUNT = 'e'.repeat(32);
const BOOK_GUID = 'c'.repeat(32);

function request(accountGuids: string[]): Request {
    return new Request('http://localhost/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            currency_guid: 'd'.repeat(32),
            post_date: '2026-07-15',
            description: 'Scoped test',
            splits: accountGuids.map((account_guid, index) => ({
                account_guid,
                value_num: index === 0 ? 100 : -100,
                value_denom: 100,
                quantity_num: index === 0 ? 100 : -100,
                quantity_denom: 100,
            })),
        }),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    const createdSplits: Array<Record<string, unknown>> = [];
    const accountRows = [{ guid: ACCOUNT_A }, { guid: ACCOUNT_B }, { guid: FOREIGN_ACCOUNT }];
    // This is intentionally a mutable-row-store fake, not a canned result:
    // reverting the scope fix makes the vulnerable existence-only lookup
    // return the foreign row and lets the write proceed.
    prismaMock.accounts.findMany.mockImplementation(async ({ where }: { where: { guid?: { in?: string[] } } }) => {
        const wanted = where.guid?.in;
        return wanted ? accountRows.filter(row => wanted.includes(row.guid)) : accountRows;
    });
    requireRoleMock.mockResolvedValue({ bookGuid: BOOK_GUID, role: 'edit' });
    getAccountGuidsForBookMock.mockResolvedValue([ACCOUNT_A, ACCOUNT_B]);
    validateTransactionMock.mockReturnValue({ valid: true, errors: [] });
    withPeriodLockCheckMock.mockResolvedValue(null);
    processMultiCurrencySplitsMock.mockImplementation(async (splits: unknown[]) => ({
        allSplits: splits,
        isMultiCurrency: false,
    }));
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
    prismaMock.transactions.create.mockResolvedValue({});
    prismaMock.splits.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        createdSplits.push({
            ...data,
            account: { name: 'Scoped account', commodity: { mnemonic: 'USD' } },
        });
    });
    prismaMock.transactions.findUnique.mockImplementation(async () => ({
        guid: 'f'.repeat(32),
        currency_guid: 'd'.repeat(32),
        num: '',
        post_date: new Date('2026-07-15T00:00:00.000Z'),
        enter_date: new Date('2026-07-15T00:00:00.000Z'),
        description: 'Scoped test',
        splits: createdSplits,
    }));
    buildAccountPathMapMock.mockResolvedValue(new Map());
});

describe('POST /api/transactions book scope', () => {
    it.each([
        ['a foreign account', [FOREIGN_ACCOUNT, FOREIGN_ACCOUNT]],
        ['a mixed in-book and foreign account request', [ACCOUNT_A, FOREIGN_ACCOUNT]],
    ])('atomically rejects %s without exposing the guid', async (_label, accounts) => {
        const response = await POST(request(accounts));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body).toEqual({ error: 'One or more accounts not found in this book' });
        expect(JSON.stringify(body)).not.toContain(FOREIGN_ACCOUNT);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.transactions.create).not.toHaveBeenCalled();
        expect(prismaMock.splits.create).not.toHaveBeenCalled();
    });

    it('fails closed when the session-derived book scope is empty', async () => {
        getAccountGuidsForBookMock.mockResolvedValue([]);

        const response = await POST(request([ACCOUNT_A, ACCOUNT_B]));

        expect(response.status).toBe(404);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.transactions.create).not.toHaveBeenCalled();
    });

    it('deduplicates repeated in-book account guids before scope validation', async () => {
        // A duplicate has one distinct account GUID, so it must not be
        // rejected by a cardinality comparison against two input splits.
        const response = await POST(request([ACCOUNT_A, ACCOUNT_A]));

        expect(response.status).toBe(201);
        expect(getAccountGuidsForBookMock).toHaveBeenCalledWith(BOOK_GUID);
    });
});
