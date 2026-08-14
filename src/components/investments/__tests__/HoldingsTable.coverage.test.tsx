/**
 * The holdings table's cost-basis cells.
 *
 * A partial basis stays visible — withholding a number the user can still learn
 * from would be its own dishonesty — but it no longer renders as a plain,
 * complete "Cost Basis". The caveat names the shares it leaves out and says the
 * gain columns are the covered shares' only.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CostBasisCoverage } from '@/lib/commodities';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { HoldingsTable } from '../HoldingsTable';
import { coverageCaveat } from '../CostBasisCoverageMark';

const PARTIAL: CostBasisCoverage = {
    status: 'partial',
    coveredShares: 150,
    uncoveredShares: 50,
    warnings: ['50 of 100 share(s) transferred in on 2021-01-01 have no traceable cost basis in this book.'],
};
const COMPLETE: CostBasisCoverage = { status: 'complete', coveredShares: 200 };

function holding(overrides: Partial<Parameters<typeof HoldingsTable>[0]['holdings'][number]> = {}) {
    return {
        accountGuid: 'acct-a',
        accountName: 'Brokerage:AAPL',
        symbol: 'AAPL',
        shares: 200,
        costBasis: 3_500,
        costBasisCoverage: PARTIAL,
        marketValue: 10_000,
        gainLoss: 4_000,
        gainLossPercent: 114.29,
        ...overrides,
    };
}

describe('HoldingsTable — cost-basis coverage', () => {
    it('shows the partial basis AND a caveat naming the uncovered shares', () => {
        render(<HoldingsTable holdings={[holding()]} />);

        // The number itself is not withheld.
        expect(screen.getByText('$3,500.00')).toBeTruthy();

        const mark = screen.getByLabelText('Cost basis covers only part of this position');
        expect(mark).toBeTruthy();

        // Hover reveals the sentence (DESIGN.md bans `title=`; this is the
        // shared Tooltip primitive, which also opens on focus and tap).
        fireEvent.click(mark);
        expect(screen.getByText(/covers 150 of 200 shares/)).toBeTruthy();
        expect(screen.getByText(/50 have no traceable basis/)).toBeTruthy();
        expect(screen.getByText(/gain and gain % are the covered shares' only/)).toBeTruthy();
    });

    it('marks nothing on a fully covered holding — the normal case is unchanged', () => {
        render(<HoldingsTable holdings={[holding({ costBasis: 6_000, costBasisCoverage: COMPLETE })]} />);

        expect(screen.getByText('$6,000.00')).toBeTruthy();
        expect(screen.queryByLabelText('Cost basis covers only part of this position')).toBeNull();
        expect(screen.queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
    });

    it('marks an unverified basis differently from a measured shortfall', () => {
        render(<HoldingsTable holdings={[holding({
            costBasisCoverage: { status: 'unknown', reason: 'Cost basis carry-over is off.' },
        })]} />);

        const mark = screen.getByLabelText('Cost-basis coverage is unverified');
        fireEvent.click(mark);
        expect(screen.getByText(/coverage is unverified, so the gain may be overstated/)).toBeTruthy();
    });

    it('caveats the consolidated row and each account under it', () => {
        render(
            <HoldingsTable
                holdings={[holding()]}
                consolidatedHoldings={[{
                    commodityGuid: 'commodity-aapl',
                    symbol: 'AAPL',
                    fullname: 'Apple Inc.',
                    totalShares: 300,
                    totalCostBasis: 5_500,
                    totalCostBasisCoverage: PARTIAL,
                    totalMarketValue: 15_000,
                    totalGainLoss: 7_000,
                    totalGainLossPercent: 127.27,
                    latestPrice: 50,
                    priceDate: '2026-08-14',
                    accounts: [
                        {
                            accountGuid: 'acct-a', accountName: 'A', accountPath: 'Assets:A',
                            shares: 200, costBasis: 3_500, costBasisCoverage: PARTIAL,
                            marketValue: 10_000, gainLoss: 4_000, gainLossPercent: 114.29,
                        },
                        {
                            accountGuid: 'acct-b', accountName: 'B', accountPath: 'Assets:B',
                            shares: 100, costBasis: 2_000, costBasisCoverage: COMPLETE,
                            marketValue: 5_000, gainLoss: 3_000, gainLossPercent: 150,
                        },
                    ],
                }]}
            />,
        );

        // The consolidated row carries the pooled caveat; expanding it shows
        // one caveat on the partial account and none on the covered one.
        expect(screen.getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(1);
        fireEvent.click(screen.getByText('AAPL'));
        expect(screen.getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(2);
    });
});

describe('coverageCaveat', () => {
    it('says nothing at all under complete coverage', () => {
        expect(coverageCaveat(COMPLETE)).toBeNull();
    });

    it('quotes the covered, total and uncovered share counts', () => {
        expect(coverageCaveat(PARTIAL)).toContain('covers 150 of 200 shares');
        expect(coverageCaveat(PARTIAL)).toContain('50 have no traceable basis');
        // The pool's own warning is passed through, dates and all.
        expect(coverageCaveat(PARTIAL)).toContain('transferred in on 2021-01-01');
    });
});
