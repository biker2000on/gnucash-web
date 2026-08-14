/**
 * The investment portfolio report table.
 *
 * Its basis is summed from raw split values with no transfer tracing, so every
 * row is equally unverified. The hint therefore sits in the column headers —
 * DESIGN.md's rule for a hint that would otherwise repeat down a column — with
 * the gain header naming what the number is, plus markers on the totals row. A
 * row is marked individually only when its coverage disagrees with its column.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ReportType } from '@/lib/reports/types';
import type { InvestmentPortfolioData } from '@/lib/reports/types';
import type { CostBasisCoverage } from '@/lib/commodities';

vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { PortfolioTable } from '../PortfolioTable';

const UNKNOWN: CostBasisCoverage = {
    status: 'unknown',
    reason: 'Cost basis carry-over is off.',
};
const COMPLETE: CostBasisCoverage = { status: 'complete', coveredShares: 200 };
const PARTIAL: CostBasisCoverage = {
    status: 'partial', coveredShares: 150, uncoveredShares: 50, warnings: [],
};

function report(
    holdingCoverage: CostBasisCoverage,
    totalsCoverage: CostBasisCoverage = holdingCoverage,
): InvestmentPortfolioData {
    return {
        type: ReportType.INVESTMENT_PORTFOLIO,
        title: 'Investment Portfolio',
        generatedAt: '2026-08-14T00:00:00.000Z',
        filters: { startDate: null, endDate: null },
        holdings: [{
            guid: 'acct-aapl',
            accountName: 'Brokerage:AAPL',
            symbol: 'AAPL',
            shares: 200,
            latestPrice: 50,
            priceDate: '2026-08-14',
            marketValue: 10_000,
            costBasis: 3_500,
            costBasisCoverage: holdingCoverage,
            gain: 6_500,
            gainPercent: 185.71,
        }],
        totals: {
            marketValue: 10_000,
            costBasis: 3_500,
            costBasisCoverage: totalsCoverage,
            gain: 6_500,
            gainPercent: 185.71,
        },
        showZeroShares: false,
    };
}

describe('PortfolioTable — cost-basis coverage', () => {
    it('states the unverified basis in the headers and on the totals row', () => {
        render(<PortfolioTable data={report(UNKNOWN)} />);

        // The gain header says what the number is rather than "Gain/Loss".
        // "Covered Gain" would be wrong here: nothing was measured as covered.
        expect(screen.getByText('Gain (basis unverified)')).toBeTruthy();
        expect(screen.queryByText('Covered Gain')).toBeNull();

        // Cost Basis, gain and Gain % headers, plus the three totals cells.
        const marks = screen.getAllByLabelText('Cost-basis coverage is unverified');
        expect(marks).toHaveLength(6);

        fireEvent.click(marks[0]);
        expect(screen.getByText(/Cost-basis coverage is unverified/)).toBeTruthy();
        expect(screen.getByText(/may be overstated by whatever basis is missing/)).toBeTruthy();
        // Named in visible text on the totals row too, not only in the tooltip.
        expect(screen.getByText('basis coverage unverified')).toBeTruthy();
    });

    it('does not repeat the marker down every data row when the column already says it', () => {
        render(<PortfolioTable data={report(UNKNOWN)} />);

        const row = screen.getByText('Brokerage:AAPL').closest('tr')!;
        expect(within(row).queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
    });

    it('marks a row whose coverage disagrees with its column', () => {
        // A row that is measurably partial inside an unverified column must not
        // hide behind the header: partial is a different claim from unverified.
        render(<PortfolioTable data={report(PARTIAL, UNKNOWN)} />);

        const row = screen.getByText('Brokerage:AAPL').closest('tr')!;
        expect(within(row).getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(3);
        expect(within(row).getByText('covered gain · 150 of 200 shares')).toBeTruthy();
    });

    it('a fully covered report renders exactly as it did before', () => {
        render(<PortfolioTable data={report(COMPLETE)} />);

        expect(screen.getByText('Gain/Loss')).toBeTruthy();
        expect(screen.queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
        expect(screen.queryByLabelText('Cost basis covers only part of this position')).toBeNull();
        expect(screen.queryByText(/basis coverage unverified/)).toBeNull();
    });
});
