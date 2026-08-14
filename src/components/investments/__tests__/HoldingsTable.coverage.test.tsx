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
import { coverageCaveat, coveredSliceLabel, BASIS_CONSEQUENCE } from '../CostBasisCoverageMark';

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

        const [mark] = screen.getAllByLabelText('Cost basis covers only part of this position');
        expect(mark).toBeTruthy();

        // Hover reveals the sentence (DESIGN.md bans `title=`; this is the
        // shared Tooltip primitive, which also opens on focus and tap).
        fireEvent.click(mark);
        expect(screen.getByText(/covers 150 of 200 shares/)).toBeTruthy();
        expect(screen.getByText(/50 have no traceable basis/)).toBeTruthy();
        expect(screen.getByText(/Gain and gain % cover those shares only/)).toBeTruthy();
    });

    it('marks the gain cells themselves and names the slice without a hover', () => {
        render(<HoldingsTable holdings={[holding()]} />);

        // $4,000 is the gain on 150 of 200 shares, printed beside a 200-share
        // count and a $10,000 market value. Three cells carry a number derived
        // from the partial basis — cost basis, gain, gain % — and each is
        // marked; a marker on a neighbouring cell would not reach a reader
        // scanning the gain column.
        expect(screen.getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(3);
        // The slice is named in plain text, so it survives a user who never
        // opens a tooltip.
        expect(screen.getByText('covered gain · 150 of 200 shares')).toBeTruthy();
    });

    it('marks nothing on a fully covered holding — the normal case is unchanged', () => {
        render(<HoldingsTable holdings={[holding({ costBasis: 6_000, costBasisCoverage: COMPLETE })]} />);

        expect(screen.getByText('$6,000.00')).toBeTruthy();
        expect(screen.queryByLabelText('Cost basis covers only part of this position')).toBeNull();
        expect(screen.queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
        // No slice note, and the heading stays the plain whole-position one.
        expect(screen.queryByText(/covered gain/)).toBeNull();
    });

    it('marks an unverified basis differently from a measured shortfall', () => {
        render(<HoldingsTable holdings={[holding({
            costBasisCoverage: { status: 'unknown', reason: 'Cost basis carry-over is off.' },
        })]} />);

        const [mark] = screen.getAllByLabelText('Cost-basis coverage is unverified');
        fireEvent.click(mark);
        expect(screen.getByText(/Cost-basis coverage is unverified/)).toBeTruthy();
        expect(screen.getByText(/may be overstated by whatever basis is missing/)).toBeTruthy();
        expect(screen.getByText('basis coverage unverified')).toBeTruthy();
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
        // Cost basis, gain and gain % on the consolidated row.
        expect(screen.getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(3);
        fireEvent.click(screen.getByText('AAPL'));
        // Plus the same three on the partial sub-account; the covered one adds none.
        expect(screen.getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(6);
    });
});

describe('coverageCaveat', () => {
    it('says nothing at all under complete coverage', () => {
        expect(coverageCaveat(COMPLETE, BASIS_CONSEQUENCE)).toBeNull();
        expect(coveredSliceLabel(COMPLETE)).toBeNull();
    });

    it('quotes the covered, total and uncovered share counts', () => {
        const caveat = coverageCaveat(PARTIAL, BASIS_CONSEQUENCE)!;
        expect(caveat).toContain('covers 150 of 200 shares');
        expect(caveat).toContain('50 have no traceable basis');
        // The pool's own warning is passed through, dates and all.
        expect(caveat).toContain('transferred in on 2021-01-01');
        expect(coveredSliceLabel(PARTIAL)).toBe('covered gain · 150 of 200 shares');
    });
});
