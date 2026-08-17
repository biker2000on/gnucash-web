/**
 * Price age on the holdings table.
 *
 * The report already carried `priceDate` down to the cell; nothing ever read
 * it, so a position last quoted in June rendered exactly like one quoted
 * yesterday. Market value and gain are computed from that quote, so the row has
 * to say when the quote is too old to stand for "current".
 *
 * Age is measured against the report's own as-of date, not the wall clock: a
 * statement pulled as of March 2020 is not stale for being about March 2020.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ReportType } from '@/lib/reports/types';
import type { InvestmentPortfolioData, PortfolioHolding } from '@/lib/reports/types';
import type { CostBasisCoverage } from '@/lib/commodities';

vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { PortfolioTable } from '../PortfolioTable';

const COMPLETE: CostBasisCoverage = { status: 'complete', coveredShares: 100 };

function holding(symbol: string, priceDate: string): PortfolioHolding {
    return {
        guid: `acct-${symbol}`,
        accountName: `Brokerage:${symbol}`,
        symbol,
        shares: 100,
        latestPrice: 120,
        priceDate,
        marketValue: 12000,
        costBasis: 10000,
        costBasisCoverage: COMPLETE,
        gain: 2000,
        gainPercent: 20,
    };
}

function report(holdings: PortfolioHolding[], endDate: string | null = '2026-08-17'): InvestmentPortfolioData {
    return {
        type: ReportType.INVESTMENT_PORTFOLIO,
        title: 'Investment Portfolio',
        generatedAt: '2026-08-17T13:00:00.000Z',
        filters: { startDate: null, endDate },
        holdings,
        totals: {
            marketValue: 12000 * holdings.length,
            costBasis: 10000 * holdings.length,
            costBasisCoverage: COMPLETE,
            gain: 2000 * holdings.length,
            gainPercent: 20,
        },
        showZeroShares: false,
    };
}

function rowFor(symbol: string): HTMLElement {
    return screen.getByText(symbol).closest('tr') as HTMLElement;
}

describe('PortfolioTable price staleness', () => {
    it('says nothing when every quote is from the last trading session', () => {
        // Friday's close, read on Monday.
        render(<PortfolioTable data={report([holding('AAPL', '2026-08-14')])} />);

        expect(screen.queryByText(/stale/i)).toBeNull();
    });

    it('says nothing about a quote sitting exactly on the bound', () => {
        render(<PortfolioTable data={report([holding('AAPL', '2026-08-10')])} />);

        expect(screen.queryByText(/stale/i)).toBeNull();
    });

    it('marks the row whose quote is past the bound', () => {
        render(<PortfolioTable data={report([holding('AAPL', '2026-06-01')])} />);

        expect(within(rowFor('AAPL')).getByText(/stale/i)).toBeTruthy();
    });

    it('marks only the stale rows and counts them once above the table', () => {
        render(<PortfolioTable data={report([
            holding('AAPL', '2026-08-14'),
            holding('MSFT', '2026-06-01'),
        ])} />);

        expect(within(rowFor('MSFT')).getByText(/stale/i)).toBeTruthy();
        expect(within(rowFor('AAPL')).queryByText(/stale/i)).toBeNull();
        expect(screen.getByText(/1 of 2 holdings/i)).toBeTruthy();
    });

    it('does not call a historical report stale for being historical', () => {
        // As-of 2020-03-31 with the newest quote from 2020-03-30.
        const data = report([holding('AAPL', '2020-03-30')], '2020-03-31');
        render(<PortfolioTable data={data} />);

        expect(screen.queryByText(/stale/i)).toBeNull();
    });

    it('says nothing about a holding with no price date at all', () => {
        // No quote is the unpriceable-holding problem, disclosed elsewhere.
        render(<PortfolioTable data={report([holding('AAPL', '')])} />);

        expect(screen.queryByText(/stale/i)).toBeNull();
    });
});
