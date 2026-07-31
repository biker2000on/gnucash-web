import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const BOOK = 'book-a';
const BUDGET = 'b'.repeat(32);
const ACCOUNTS = ['a'.repeat(32)];

const {
    requireRoleMock,
    accountGuidsMock,
    generateDigestMock,
    generateYearInReviewMock,
    generateBudgetBalanceSheetMock,
} = vi.hoisted(() => ({
    requireRoleMock: vi.fn(),
    accountGuidsMock: vi.fn(),
    generateDigestMock: vi.fn(),
    generateYearInReviewMock: vi.fn(),
    generateBudgetBalanceSheetMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: accountGuidsMock }));
vi.mock('@/lib/digest', () => ({
    generateDigest: generateDigestMock,
    normalizeMonth: vi.fn((month?: string) => month ?? '2026-07'),
    digestToSummaryText: vi.fn(),
}));
vi.mock('@/lib/reports/year-in-review', () => ({ generateYearInReview: generateYearInReviewMock }));
vi.mock('@/lib/reports/budget-statements', () => ({ generateBudgetBalanceSheet: generateBudgetBalanceSheetMock }));

import { GET as getDigest } from '../tools/digest/route';
import { GET as getYearInReview } from '../reports/year-in-review/route';
import { GET as getBudgetBalanceSheet } from '../reports/budget-balance-sheet/route';

const request = (path: string): NextRequest => new Request(`http://localhost${path}`) as NextRequest;

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: BOOK, user: { id: 7 }, role: 'readonly' });
    accountGuidsMock.mockResolvedValue(ACCOUNTS);
});

describe('budget-related report route scope', () => {
    it('passes the authorized book GUID to the digest', async () => {
        generateDigestMock.mockResolvedValue({ month: '2026-07' });

        await getDigest(request('/api/tools/digest?month=2026-07'));

        expect(generateDigestMock).toHaveBeenCalledWith(BOOK, { month: '2026-07', aiUserId: 7 });
    });

    it.each([
        ['year-in-review', () => getYearInReview(request('/api/reports/year-in-review?year=2025')), generateYearInReviewMock, [BOOK, ACCOUNTS, 2025]],
        ['budget-balance-sheet', () => getBudgetBalanceSheet(request(`/api/reports/budget-balance-sheet?budget=${BUDGET}&period=2`)), generateBudgetBalanceSheetMock, [BOOK, ACCOUNTS, BUDGET, 2]],
    ] as const)('passes the authorized book and its account set to %s', async (_name, invoke, loader, args) => {
        loader.mockResolvedValue({});

        await invoke();

        expect(accountGuidsMock).toHaveBeenCalledWith(BOOK);
        expect(loader).toHaveBeenCalledWith(...args);
    });
});
