/**
 * The investment portfolio REPORT (reports/investment_portfolio), which is a
 * separate surface from the investments pages.
 *
 * It sums raw split values with no transfer tracing, so its basis cannot claim
 * completeness — it already said so to `calculateGainLoss` and then dropped the
 * statement on the floor, handing the table a bare number to render as a
 * complete cost basis. Its totals also recomputed
 * `totalMarketValue - totalCostBasis`, the same subtraction that made the
 * account view disagree with its own rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, getBaseCurrencyMock, sumSplitsByAccountMock } = vi.hoisted(() => ({
    prismaMock: { accounts: { findMany: vi.fn() }, $queryRaw: vi.fn() },
    getBaseCurrencyMock: vi.fn(),
    sumSplitsByAccountMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/currency', () => ({ getBaseCurrency: getBaseCurrencyMock }));
vi.mock('@/lib/reports/utils', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/reports/utils')>();
    return { ...actual, sumSplitsByAccount: (...args: unknown[]) => sumSplitsByAccountMock(...args) };
});

import { generateInvestmentPortfolio } from '../investment-portfolio';

const AAPL_ACCT = 'acct-aapl';
const MSFT_ACCT = 'acct-msft';
const AAPL = 'commodity-aapl';
const MSFT = 'commodity-msft';

beforeEach(() => {
    vi.clearAllMocks();
    getBaseCurrencyMock.mockResolvedValue({ guid: 'commodity-usd', mnemonic: 'USD' });
    prismaMock.accounts.findMany.mockResolvedValue([
        {
            guid: AAPL_ACCT, name: 'Brokerage:AAPL', account_type: 'STOCK', commodity_guid: AAPL,
            commodity: { mnemonic: 'AAPL', fullname: 'Apple Inc.' },
        },
        {
            guid: MSFT_ACCT, name: 'Brokerage:MSFT', account_type: 'STOCK', commodity_guid: MSFT,
            commodity: { mnemonic: 'MSFT', fullname: 'Microsoft Corp.' },
        },
    ]);
    // 200 AAPL costing $3,500 and 100 MSFT costing $2,000.
    sumSplitsByAccountMock.mockResolvedValue(new Map([
        [AAPL_ACCT, { quantity: 200, value: 3_500 }],
        [MSFT_ACCT, { quantity: 100, value: 2_000 }],
    ]));
    // $50 a share for both: $10,000 and $5,000 of market value.
    prismaMock.$queryRaw.mockResolvedValue([
        { commodity_guid: AAPL, date: new Date('2026-08-14'), value_num: 500_000n, value_denom: 10_000n },
        { commodity_guid: MSFT, date: new Date('2026-08-14'), value_num: 500_000n, value_denom: 10_000n },
    ]);
});

describe('generateInvestmentPortfolio — cost-basis coverage', () => {
    it('carries the unverified coverage onto every holding and the totals', async () => {
        const report = await generateInvestmentPortfolio({ startDate: null, endDate: null });

        expect(report.holdings).toHaveLength(2);
        for (const holding of report.holdings) {
            // Untraced split-value sums: an in-kind transfer-in would have
            // entered at its $0 split value, so completeness is unmeasured.
            expect(holding.costBasisCoverage.status).toBe('unknown');
        }
        expect(report.totals.costBasisCoverage.status).toBe('unknown');
        // No covered-share count to misread as a measured slice.
        expect('coveredShares' in report.totals.costBasisCoverage).toBe(false);
    });

    it('sums the per-holding gains for the totals row', async () => {
        const report = await generateInvestmentPortfolio({ startDate: null, endDate: null });

        expect(report.totals.marketValue).toBeCloseTo(15_000, 6);
        expect(report.totals.costBasis).toBeCloseTo(5_500, 6);
        // $6,500 + $3,000. Under unknown coverage each row's gain is its whole
        // position's, so this equals the old subtraction to the cent — the
        // point is that the total is now the sum of the rows displayed above
        // it whatever their coverage, instead of agreeing only by luck.
        expect(report.totals.gain).toBeCloseTo(9_500, 6);
        expect(report.totals.gain).toBeCloseTo(
            report.holdings.reduce((sum, h) => sum + h.gain, 0), 6,
        );
        expect(report.totals.gainPercent).toBeCloseTo(172.7272727, 5);
    });

    it('an empty report totals to zero rather than to unknown coverage', async () => {
        sumSplitsByAccountMock.mockResolvedValue(new Map());
        const report = await generateInvestmentPortfolio({ startDate: null, endDate: null });

        expect(report.holdings).toHaveLength(0);
        expect(report.totals).toMatchObject({ marketValue: 0, costBasis: 0, gain: 0, gainPercent: 0 });
        expect(report.totals.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 0 });
    });
});
