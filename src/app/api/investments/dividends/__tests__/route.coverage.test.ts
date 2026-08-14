/**
 * The dividend report, at the ROUTE level.
 *
 * Yield-on-cost is income divided by cost basis. The route used to copy
 * `holdings.costBasis` and drop its coverage, so a security whose basis covers
 * only part of the position had its FULL trailing-12-month income divided by a
 * PARTIAL basis — an overstated yield printed with no caveat.
 *
 * The ratio is now WITHHELD unless the basis covers the whole position.
 * Restricting the income to the covered fraction was rejected: it would assume
 * covered and uncovered shares were held for the same part of the year and
 * earned dividends in the same ratio, which any mid-year transfer, sale, DRIP,
 * or record date breaks. The income itself is known and still reported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock, requireRoleMock, getBookAccountGuidsMock,
    getAccountHoldingsMock, loadDividendPaymentsMock,
} = vi.hoisted(() => ({
    prismaMock: { accounts: { findMany: vi.fn() } },
    requireRoleMock: vi.fn(),
    getBookAccountGuidsMock: vi.fn(),
    getAccountHoldingsMock: vi.fn(),
    loadDividendPaymentsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ getBookAccountGuids: getBookAccountGuidsMock }));
vi.mock('@/lib/commodities', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/commodities')>();
    return { ...actual, getAccountHoldings: (...args: unknown[]) => getAccountHoldingsMock(...args) };
});
// Only the DB loader is stubbed; the summarizer under test is the real one.
vi.mock('@/lib/dividends', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/dividends')>();
    return { ...actual, loadDividendPayments: (...args: unknown[]) => loadDividendPaymentsMock(...args) };
});

import { GET } from '../route';
import type { CostBasisCoverage } from '@/lib/commodities';

const BROKER = 'acct-broker';
const AAPL = 'commodity-aapl';

type SecurityRow = {
    ticker: string;
    ttmIncome: number;
    costBasis: number | null;
    costBasisCoverage: CostBasisCoverage | null;
    yieldOnCost: number | null;
};

/** Four $100 quarterly dividends inside the trailing-12-month window. */
function payments() {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    return [30, 120, 210, 300].map((daysAgo, i) => ({
        transactionGuid: `tx-${i}`,
        date: new Date(now - daysAgo * day),
        amount: 100,
        ticker: 'AAPL',
        commodityGuid: AAPL,
        incomeAccountGuid: 'acct-income',
        incomeAccountName: 'Income:Dividends',
        investmentAccountGuid: BROKER,
        investmentAccountName: 'Brokerage:AAPL',
        description: 'AAPL dividend',
    }));
}

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: 'book-guid', role: 'readonly' });
    getBookAccountGuidsMock.mockResolvedValue([BROKER]);
    loadDividendPaymentsMock.mockResolvedValue(payments());
    prismaMock.accounts.findMany.mockResolvedValue([
        {
            guid: BROKER, name: 'AAPL', commodity_guid: AAPL,
            commodity: { guid: AAPL, mnemonic: 'AAPL' },
        },
    ]);
});

async function security(): Promise<SecurityRow> {
    const response = await GET(
        new Request('http://localhost/api/investments/dividends') as never,
    ) as unknown as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as { perSecurity: SecurityRow[] };
    return body.perSecurity[0];
}

describe('dividends route — cost-basis coverage', () => {
    it('withholds yield-on-cost under partial coverage and says why', async () => {
        // 200 shares, $10,000 of value, but the $5,000 basis covers only 150 of
        // them (75%). TTM income is $400.
        getAccountHoldingsMock.mockResolvedValue({
            shares: 200,
            costBasis: 5_000,
            costBasisCoverage: {
                status: 'partial', coveredShares: 150, uncoveredShares: 50,
                warnings: ['50 share(s) transferred in have no traceable cost basis in this book.'],
            },
            marketValue: 10_000,
            gainLoss: 2_500,
            gainLossPercent: 50,
            latestPrice: null,
        });

        const row = await security();
        expect(row.ttmIncome).toBe(400);
        expect(row.costBasis).toBe(5_000);
        expect(row.costBasisCoverage).toMatchObject({
            status: 'partial', coveredShares: 150, uncoveredShares: 50,
        });

        // BEFORE: $400 / $5,000 = 8.00%, the whole position's income measured
        // against three quarters of a basis.
        // AFTER: withheld. Which shares earned which of those four payments is
        // not in this data — a 75%-of-income estimate would be a fabricated
        // number wearing a percent sign.
        expect(row.yieldOnCost).toBeNull();
        // The income, which IS known, is untouched.
        expect(row.ttmIncome).toBe(400);
    });

    it('a fully covered security reports the yield it does today', async () => {
        getAccountHoldingsMock.mockResolvedValue({
            shares: 200,
            costBasis: 5_000,
            costBasisCoverage: { status: 'complete', coveredShares: 200 },
            marketValue: 10_000,
            gainLoss: 5_000,
            gainLossPercent: 100,
            latestPrice: null,
        });

        const row = await security();
        expect(row.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 200 });
        expect(row.yieldOnCost).toBeCloseTo(8, 6); // $400 / $5,000, unchanged
    });

    it('withholds the yield under unknown coverage too', async () => {
        getAccountHoldingsMock.mockResolvedValue({
            shares: 200,
            costBasis: 5_000,
            costBasisCoverage: { status: 'unknown', reason: 'Cost basis carry-over is off.' },
            marketValue: 10_000,
            gainLoss: 5_000,
            gainLossPercent: 100,
            latestPrice: null,
        });

        const row = await security();
        // The denominator's own completeness is unmeasured, so the ratio is not
        // derivable either.
        expect(row.yieldOnCost).toBeNull();
        expect(row.ttmIncome).toBe(400);
        expect(row.costBasisCoverage?.status).toBe('unknown');
    });
});
