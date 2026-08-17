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

function holding(
    symbol: string,
    priceDate: string,
    commodityNamespace: string | null = 'NASDAQ',
    priceWeekendQuoteDays = 0,
): PortfolioHolding {
    return {
        guid: `acct-${symbol}`,
        accountName: `Brokerage:${symbol}`,
        symbol,
        shares: 100,
        latestPrice: 120,
        priceDate,
        commodityNamespace,
        priceWeekendQuoteDays,
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

    /**
     * The weekend that excuses a listed security's four-day-old quote does not
     * exist for a market that trades through it. Holding both to one bound
     * means either crying wolf on the equity or going quiet on the crypto, and
     * quiet is the expensive one.
     */
    describe('the bound follows the instrument, not the table', () => {
        it("calls a continuous quote stale on a gap an equity's calendar explains", () => {
            render(<PortfolioTable data={report([
                holding('AAPL', '2026-08-13'),
                holding('BTC', '2026-08-13', 'CRYPTO'),
            ])} />);

            expect(within(rowFor('BTC')).getByText(/stale/i)).toBeTruthy();
            expect(within(rowFor('AAPL')).queryByText(/stale/i)).toBeNull();
            expect(screen.getByText(/1 of 2 holdings/i)).toBeTruthy();
        });

        it('stays quiet across the weekend a manual refresher was away for', () => {
            // Friday's refresh read on Monday: the ordinary case for a book
            // without the daily worker schedule, and the one a two-day bound
            // greeted with a warning the reader could not have prevented.
            render(<PortfolioTable data={report([holding('BTC', '2026-08-14', 'CRYPTO')])} />);

            expect(screen.queryByText(/stale/i)).toBeNull();
        });

        it('falls back to the looser bound when the payload carries no namespace', () => {
            // A report cached before the namespace travelled with the holding.
            render(<PortfolioTable data={report([holding('AAPL', '2026-08-13', null)])} />);

            expect(screen.queryByText(/stale/i)).toBeNull();
        });

        /**
         * `commodities.namespace` is a free-text column, the commodities API
         * accepts any string on creation, and the settings field offers
         * suggestions rather than an enum — so `=== 'CRYPTO'` would have left
         * every imported or hand-filed crypto holding on the equity bound.
         */
        it('marks crypto filed under a namespace nobody anticipated', () => {
            render(<PortfolioTable data={report([
                // Namespace is a wallet name; the price history is what says
                // this venue never closes.
                holding('BTC', '2026-08-13', 'Ledger Nano X', 3),
            ])} />);

            expect(within(rowFor('BTC')).getByText(/stale/i)).toBeTruthy();
        });

        it('marks crypto whose namespace merely spells it differently', () => {
            for (const ns of ['Cryptocurrency', 'Coinbase', 'crypto:BTC']) {
                const { unmount } = render(
                    <PortfolioTable data={report([holding('XYZ', '2026-08-13', ns)])} />,
                );
                expect(screen.getByText(/stale/i), ns).toBeTruthy();
                unmount();
            }
        });

        it('does not re-bound a spot-crypto ETF that trades on an exchange', () => {
            // Ticker is not the point: this one closes for the weekend, so the
            // mnemonic is never consulted.
            render(<PortfolioTable data={report([holding('BTC', '2026-08-13', 'NASDAQ')])} />);

            expect(screen.queryByText(/stale/i)).toBeNull();
        });
    });

    /**
     * A mixed table has to explain itself on the row. Otherwise a four-day-old
     * BTC row marked stale sits beside a four-day-old equity row that is not,
     * with nothing on either saying why — which reads as arbitrary, or as a bug.
     */
    describe('each marked row states its own age and bound', () => {
        it('prints the age and the limit that was applied', () => {
            render(<PortfolioTable data={report([
                holding('AAPL', '2026-06-01'),
                holding('BTC', '2026-06-01', 'CRYPTO'),
            ])} />);

            // 77 days old either way; the limits differ, and both are visible.
            expect(within(rowFor('AAPL')).getByText(/77d old, limit 7d/)).toBeTruthy();
            expect(within(rowFor('BTC')).getByText(/77d old, limit 3d/)).toBeTruthy();
        });

        it('gives assistive technology the sentence, not the abbreviation', () => {
            render(<PortfolioTable data={report([holding('BTC', '2026-06-01', 'CRYPTO')])} />);

            const spoken = within(rowFor('BTC')).getByText(/valued from a quote 77 days old/);
            expect(spoken.textContent).toContain('2026-06-01');
            expect(spoken.textContent).toContain('older than 3 days');
            // The compact form is hidden from screen readers so the two are not
            // read one after the other.
            expect(spoken.className).toContain('sr-only');
        });

        it('points at the refresh that would fix it, on a present-day report', () => {
            // Nothing on this page fetches a price, and a book without the
            // daily worker schedule only gets one when someone asks. A warning
            // that recurs and cannot be acted on is the one that gets ignored.
            render(<PortfolioTable data={report([holding('BTC', '2026-06-01', 'CRYPTO')])} />);

            expect(screen.getByText(/Refresh All Prices/)).toBeTruthy();
        });

        it('does not offer a refresh for a report about the past', () => {
            // Fetching today's price does nothing for a statement drawn as of
            // 2020; the newest quote that existed then is the right one.
            render(<PortfolioTable data={report([holding('BTC', '2019-01-02', 'CRYPTO')], '2020-03-31')} />);

            expect(screen.queryByText(/Refresh All Prices/)).toBeNull();
            expect(screen.getByText(/newest quotes that existed on the report date/)).toBeTruthy();
        });
    });
});
