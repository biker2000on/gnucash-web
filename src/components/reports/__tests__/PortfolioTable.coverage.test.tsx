/**
 * The investment portfolio report table.
 *
 * Its basis is summed from raw split values with no transfer tracing, so every
 * row is equally unverified. That is stated ONCE, in an always-visible caption
 * above the table, rather than as N repeated markers or — the failure this
 * replaces — a tooltip on a column header that a reader scrolls straight past.
 * A row states its own coverage whenever it says something different from the
 * caption, compared by meaning rather than by discriminant tag.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    it('discloses the unverified basis in visible text, with nothing to hover', () => {
        render(<PortfolioTable data={report(UNKNOWN)} />);

        // The caption is rendered text, not tooltip content: no hover, no
        // focus, no click — a reader scrolled past the header still sees it.
        const caption = screen.getByText(/^All rows —/);
        expect(caption.textContent).toContain('Cost-basis coverage is unverified');
        expect(caption.textContent).toContain('may be overstated by whatever basis is missing');

        // The gain header says what the number is rather than "Gain/Loss".
        // "Covered Gain" would be wrong here: nothing was measured as covered.
        expect(screen.getByText('Gain (basis unverified)')).toBeTruthy();
        expect(screen.queryByText('Covered Gain')).toBeNull();

        // The headers themselves carry no hover-only marker; the totals row,
        // being a distinct number, keeps its own.
        for (const header of screen.getAllByRole('columnheader')) {
            expect(within(header).queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
        }
        expect(screen.getAllByLabelText('Cost-basis coverage is unverified')).toHaveLength(3);
        expect(screen.getByText('basis coverage unverified')).toBeTruthy();
    });

    it('does not repeat the marker down every data row when the caption already says it', () => {
        render(<PortfolioTable data={report(UNKNOWN)} />);

        const row = screen.getByText('Brokerage:AAPL').closest('tr')!;
        expect(within(row).queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
    });

    it('marks a row whose coverage disagrees with the caption', () => {
        // A measurably partial row inside an unverified table must not hide
        // behind the caption: partial is a different claim from unverified.
        render(<PortfolioTable data={report(PARTIAL, UNKNOWN)} />);

        const row = screen.getByText('Brokerage:AAPL').closest('tr')!;
        expect(within(row).getAllByLabelText('Cost basis covers only part of this position')).toHaveLength(3);
        expect(within(row).getByText('covered gain · 150 of 200 shares')).toBeTruthy();
    });

    it('marks partial rows that share a status but describe different positions', () => {
        // Both rows are "partial" and so is the aggregate, so a status-only
        // comparison leaves both unmarked under a caption written from the
        // aggregate — which describes 160 of 1,100 shares and therefore
        // describes neither row. 150-of-200 and 10-of-900 are different claims.
        const data = report(PARTIAL, {
            status: 'partial', coveredShares: 160, uncoveredShares: 940, warnings: [],
        });
        data.holdings = [
            data.holdings[0],
            {
                ...data.holdings[0],
                guid: 'acct-msft',
                accountName: 'Brokerage:MSFT',
                symbol: 'MSFT',
                costBasisCoverage: {
                    status: 'partial', coveredShares: 10, uncoveredShares: 890, warnings: [],
                },
            },
        ];
        render(<PortfolioTable data={data} />);

        // No single caption can speak for them, so each row states its own.
        const aapl = screen.getByText('Brokerage:AAPL').closest('tr')!;
        const msft = screen.getByText('Brokerage:MSFT').closest('tr')!;
        expect(within(aapl).getByText('covered gain · 150 of 200 shares')).toBeTruthy();
        expect(within(msft).getByText('covered gain · 10 of 900 shares')).toBeTruthy();
        expect(screen.queryByText(/^All rows —/)).toBeNull();
        expect(screen.getByText(/Rows whose cost basis does not cover their whole position are marked/)).toBeTruthy();
    });

    it('a fully covered report renders exactly as it did before', () => {
        render(<PortfolioTable data={report(COMPLETE)} />);

        expect(screen.getByText('Gain/Loss')).toBeTruthy();
        expect(screen.queryByLabelText('Cost-basis coverage is unverified')).toBeNull();
        expect(screen.queryByLabelText('Cost basis covers only part of this position')).toBeNull();
        expect(screen.queryByText(/basis coverage unverified/)).toBeNull();
        // No caption either: there is nothing to disclose.
        expect(screen.queryByText(/^All rows —/)).toBeNull();
    });
});
