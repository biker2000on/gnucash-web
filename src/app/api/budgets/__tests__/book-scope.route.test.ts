import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const BOOK_A = 'book-a';
const BUDGET_B = 'b'.repeat(32);
const ACCOUNT_C = 'c'.repeat(32);

const {
    requireRoleMock,
    listMock,
    loadActualsMock,
    estimateMock,
    envelopeViewMock,
    accountGuidsMock,
    isBudgetOwnedByBookMock,
    sourceBudgetFindUniqueMock,
    createWithAmountsMock,
} = vi.hoisted(() => ({
    requireRoleMock: vi.fn(),
    listMock: vi.fn(),
    loadActualsMock: vi.fn(),
    estimateMock: vi.fn(),
    envelopeViewMock: vi.fn(),
    accountGuidsMock: vi.fn(),
    isBudgetOwnedByBookMock: vi.fn(),
    sourceBudgetFindUniqueMock: vi.fn(),
    createWithAmountsMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/cache', () => ({ cacheInvalidateAllForBook: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/services/budget.service', () => ({
    BudgetService: { list: listMock, createWithAmounts: createWithAmountsMock },
    CreateBudgetSchema: { safeParse: vi.fn() },
}));
vi.mock('@/lib/budget-actuals', () => ({
    loadBudgetActuals: loadActualsMock,
    toActualsSummary: vi.fn(),
}));
vi.mock('@/lib/budget-estimate', () => ({
    computeBudgetEstimate: estimateMock,
    parseEstimateMethod: vi.fn(() => 'average'),
}));
vi.mock('@/lib/budget-envelope', () => ({
    getEnvelopeView: envelopeViewMock,
}));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: accountGuidsMock }));
vi.mock('@/lib/budget-ownership', () => ({ isBudgetOwnedByBook: isBudgetOwnedByBookMock }));
vi.mock('@/lib/prisma', () => ({
    default: { budgets: { findUnique: sourceBudgetFindUniqueMock } },
}));

import { GET as getBudgets } from '../route';
import { GET as getActuals } from '../[guid]/actuals/route';
import { GET as getEstimate } from '../[guid]/estimate/route';
import { GET as getEnvelopeView } from '../[guid]/envelopes/route';
import { POST as createScenario } from '../[guid]/scenario/route';

const routeParams = { params: Promise.resolve({ guid: BUDGET_B }) };
const request = (path: string): NextRequest => new Request(`http://localhost${path}`) as NextRequest;

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: BOOK_A, user: { id: 1 }, role: 'readonly' });
    accountGuidsMock.mockResolvedValue([ACCOUNT_C]);
});

describe('budget route book scope', () => {
    it.each([
        ['list', () => getBudgets(), listMock, [BOOK_A]],
        ['actuals', () => getActuals(request(`/api/budgets/${BUDGET_B}/actuals?asOf=2026-01-15`), routeParams), loadActualsMock, [BOOK_A, BUDGET_B, { asOf: '2026-01-15' }]],
        ['estimate', () => getEstimate(request(`/api/budgets/${BUDGET_B}/estimate?account_guid=${ACCOUNT_C}&months=12`), routeParams), estimateMock, [BOOK_A, BUDGET_B, ACCOUNT_C, 'average', 12]],
        ['envelopes', () => getEnvelopeView(request(`/api/budgets/${BUDGET_B}/envelopes?asOf=2026-01-15`), routeParams), envelopeViewMock, [BOOK_A, BUDGET_B, { asOf: '2026-01-15' }]],
    ] as const)('passes the authorized book to %s loader', async (_name, invoke, loader, args) => {
        loader.mockResolvedValue(loader === listMock ? [] : null);
        await invoke();
        expect(loader).toHaveBeenCalledWith(...args);
    });

    it('filters scenario source amounts to the authorized book before cloning', async () => {
        requireRoleMock.mockResolvedValue({ bookGuid: BOOK_A, user: { id: 1 }, role: 'edit' });
        isBudgetOwnedByBookMock.mockResolvedValue(true);
        sourceBudgetFindUniqueMock.mockResolvedValue({
            guid: BUDGET_B,
            name: 'Source',
            num_periods: 1,
            recurrences: [],
            amounts: [{ account_guid: ACCOUNT_C, period_num: 0, amount_num: 1250n, amount_denom: 100n }],
        });
        createWithAmountsMock.mockResolvedValue({ guid: 'd'.repeat(32) });

        await createScenario(
            new Request(`http://localhost/api/budgets/${BUDGET_B}/scenario`, {
                method: 'POST',
                body: JSON.stringify({ name: 'Copy', factor: 1 }),
            }) as NextRequest,
            routeParams,
        );

        expect(sourceBudgetFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
            include: expect.objectContaining({
                amounts: { where: { account_guid: { in: [ACCOUNT_C] } } },
            }),
        }));
        expect(createWithAmountsMock).toHaveBeenCalledWith(BOOK_A, expect.objectContaining({
            lines: [{ accountGuid: ACCOUNT_C, amounts: [12.5] }],
        }));
    });
});
