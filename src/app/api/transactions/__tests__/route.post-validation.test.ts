/**
 * Route test for POST /api/transactions — a rejected create must return a
 * reason the client can actually read.
 *
 * Before the fix this route answered `{ errors: [...] }` with no `error`
 * string while the ledger's journal-save path discarded the body entirely, so
 * the user saw a bare "Failed to save" and the real reason existed only in a
 * server-side console.error. These tests assert the response now matches the
 * shape PUT /api/transactions/[guid] has always used, and that the shared
 * client helper pulls the reason out of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, requireRoleMock, withPeriodLockCheckMock } = vi.hoisted(() => ({
    prismaMock: {
        transactions: { findMany: vi.fn(), create: vi.fn() },
        splits: { findMany: vi.fn(), create: vi.fn() },
        accounts: { findMany: vi.fn() },
        commodities: { findUnique: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    withPeriodLockCheckMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: prismaMock,
    toDecimal: vi.fn(() => '0.00'),
    generateGuid: vi.fn(() => 'f'.repeat(32)),
}));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/services/audit.service', () => ({
    logAudit: vi.fn(),
    snapshotTransactionByGuid: vi.fn(),
}));
vi.mock('@/lib/trading-accounts', () => ({ processMultiCurrencySplits: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({
    getAccountGuidsForBook: vi.fn(),
    getBookAccountGuids: vi.fn(),
    getActiveBookGuid: vi.fn(),
}));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/services/period-lock.service', () => {
    class PeriodLockedError extends Error {
        readonly code = 'PERIOD_LOCKED';
        constructor(readonly lockDate: string) {
            super(`Period locked: transactions on or before ${lockDate} are closed`);
        }
    }
    return {
        PeriodLockedError,
        withPeriodLockCheck: withPeriodLockCheckMock,
        assertNotLocked: vi.fn(),
        periodLockedResponse: vi.fn(),
    };
});

// NOTE: @/lib/validation is deliberately NOT mocked — the point of the test is
// that the real validator's message reaches the client.

import { POST } from '../route';
import { readErrorBody } from '@/lib/api-error';

const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);
const CURRENCY = 'd'.repeat(32);
const BOOK_GUID = 'c'.repeat(32);

function postRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Two splits that do not sum to zero — off by five cents. */
const unbalancedBody = {
    currency_guid: CURRENCY,
    post_date: '2026-07-15',
    description: 'Groceries',
    splits: [
        { account_guid: ACCOUNT_A, value_num: 10000, value_denom: 100 },
        { account_guid: ACCOUNT_B, value_num: -9995, value_denom: 100 },
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: BOOK_GUID, role: 'edit' });
    withPeriodLockCheckMock.mockResolvedValue(null);
});

describe('POST /api/transactions — validation failure payload', () => {
    it('returns an `error` summary string, not only `errors`', async () => {
        const response = await POST(postRequest(unbalancedBody));
        expect(response.status).toBe(400);

        const body = await response.json();
        expect(typeof body.error).toBe('string');
        expect(body.error).not.toBe('');
        expect(body.error).toContain('Splits must sum to zero');
    });

    it('keeps the per-field `errors` array for form-level highlighting', async () => {
        const response = await POST(postRequest(unbalancedBody));
        const body = await response.json();

        expect(Array.isArray(body.errors)).toBe(true);
        expect(body.errors[0]).toMatchObject({ field: 'splits' });
        expect(body.error).toBe(body.errors.map((item: { message: string }) => item.message).join('; '));
    });

    it('gives the shared client helper a real reason to show the user', async () => {
        const response = await POST(postRequest(unbalancedBody));
        const shown = await readErrorBody(response, 'Failed to save');

        expect(shown).not.toBe('Failed to save');
        expect(shown).toContain('Splits must sum to zero');
    });

    it('surfaces every missing-field reason at once', async () => {
        const response = await POST(postRequest({
            currency_guid: '',
            post_date: '',
            description: '',
            splits: [{ account_guid: ACCOUNT_A, value_num: 100, value_denom: 100 }],
        }));
        expect(response.status).toBe(400);

        const shown = await readErrorBody(response, 'Failed to save');
        expect(shown).toContain('Currency is required');
        expect(shown).toContain('Post date is required');
        expect(shown).toContain('Description is required');
        expect(shown).toContain('At least 2 splits are required');
    });

    it('does not touch the database when validation fails', async () => {
        await POST(postRequest(unbalancedBody));
        expect(prismaMock.accounts.findMany).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
});
