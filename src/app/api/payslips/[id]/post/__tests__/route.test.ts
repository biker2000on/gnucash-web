/**
 * POST /api/payslips/[id]/post — posting a payslip over a matched SimpleFin
 * deposit REPLACES that deposit's splits. When the deposit is already
 * reconciled the service refuses, and the route must surface that as a 423
 * naming the split rather than a generic 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    requireRoleMock,
    getPayslipMock,
    getMappingsForEmployerMock,
    postPayslipTransactionMock,
    cacheInvalidateFromMock,
    publishDataChangeMock,
} = vi.hoisted(() => ({
    requireRoleMock: vi.fn(),
    getPayslipMock: vi.fn(),
    getMappingsForEmployerMock: vi.fn(),
    postPayslipTransactionMock: vi.fn(),
    cacheInvalidateFromMock: vi.fn(),
    publishDataChangeMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/payslips', () => ({
    getPayslip: getPayslipMock,
    getMappingsForEmployer: getMappingsForEmployerMock,
}));
vi.mock('@/lib/services/payslip-post.service', () => {
    class PayslipPostConflictError extends Error {}
    return {
        postPayslipTransaction: postPayslipTransactionMock,
        PayslipPostConflictError,
    };
});
vi.mock('@/lib/services/period-lock.service', () => {
    class PeriodLockedError extends Error {}
    return { PeriodLockedError, periodLockedResponse: vi.fn() };
});
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: cacheInvalidateFromMock }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: publishDataChangeMock }));

import { POST } from '../route';
import { ReconciledSplitError } from '@/lib/services/reconciled-split.service';

const BOOK_GUID = 'b'.repeat(32);
const SPLIT_GUID = 's'.repeat(32);
const TX_GUID = 't'.repeat(32);

function postRequest(): Request {
    return new Request('http://localhost/api/payslips/7/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deposit_account_guid: 'd'.repeat(32),
            currency_guid: 'c'.repeat(32),
        }),
    });
}

const routeParams = { params: Promise.resolve({ id: '7' }) };

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({
        user: { id: 1, username: 'editor' },
        role: 'edit',
        bookGuid: BOOK_GUID,
    });
    getPayslipMock.mockResolvedValue({
        id: 7,
        status: 'pending',
        employer_name: 'Acme',
        net_pay: '1000',
        pay_date: new Date('2026-07-15T00:00:00.000Z'),
        line_items: [],
    });
    getMappingsForEmployerMock.mockResolvedValue([]);
    cacheInvalidateFromMock.mockResolvedValue(undefined);
});

describe('POST /api/payslips/[id]/post reconciled-split guard', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('423s when the matched deposit has a %s split', async (_label, state) => {
        postPayslipTransactionMock.mockRejectedValue(
            new ReconciledSplitError('replace this deposit with payslip detail', [{
                splitGuid: SPLIT_GUID,
                txGuid: TX_GUID,
                accountGuid: 'a'.repeat(32),
                accountName: 'Assets:Checking',
                reconcileState: state as 'y' | 'f',
            }]),
        );

        const response = await POST(postRequest(), routeParams);
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(SPLIT_GUID);
        expect(body.error).toContain('Assets:Checking');
        expect(body.error).toMatch(/unreconcile/i);
    });

    it('still posts normally when nothing is reconciled', async () => {
        postPayslipTransactionMock.mockResolvedValue(TX_GUID);

        const response = await POST(postRequest(), routeParams);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ transaction_guid: TX_GUID });
    });
});
