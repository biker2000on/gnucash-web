/**
 * The dashboard's valuation banner, and — the part a source-list check cannot
 * see — whether it actually announces.
 *
 * KPIGrid is listed in ANNOUNCING_SURFACES (error-live-regions.test.tsx), but
 * that check reads the FILE: it proves `<ErrorLiveRegion>` is imported and that
 * no `role` was hand-rolled onto the visible panel. It cannot prove the
 * announcement happens, because the distinction is invisible in the settled
 * DOM — a region that mounted holding its text and one that mounted empty and
 * was then filled are the same node with the same `textContent`. Only the ORDER
 * of the DOM mutations tells them apart, and the order is what a screen reader
 * responds to.
 *
 * So this file tests the behaviour, the way ValuationCoverageNotice does. The
 * old `role="alert"` on the panel itself passed a source check too, and
 * announced only in the narrow case where an already-mounted banner's contents
 * changed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import KPIGrid from '../KPIGrid';

/** Every DOM mutation under `document.body` while `run()` executes, in order. */
function recordMutations(run: () => void): MutationRecord[] {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver(rs => records.push(...rs));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
        run();
        records.push(...observer.takeRecords());
    } finally {
        observer.disconnect();
    }
    return records;
}

/** Index of the record that put `node` into the document, or -1. */
function insertionOf(records: MutationRecord[], node: Node): number {
    return records.findIndex(r =>
        Array.from(r.addedNodes).some(added => added === node || added.contains(node)),
    );
}

/** Index of the first record after `after` that changed the contents of `node`. */
function contentChangeOf(records: MutationRecord[], node: Node, after = -1): number {
    return records.findIndex(
        (r, i) => i > after && (r.target === node || node.contains(r.target)),
    );
}

const STALE = {
    commodityGuid: 'btc-guid',
    label: 'BTC',
    priceDate: '2026-08-10',
    ageDays: 7,
    message: 'BTC valued from a quote 7 days old (2026-08-10); prices older than 3 days may not '
        + 'reflect current value.',
};

const GAP = {
    commodityGuid: 'privco-guid',
    label: 'PRIVCO',
    reason: 'missing-security-price',
    message: 'PRIVCO excluded: no price path to USD as of 2026-08-17.',
};

function kpis(coverage?: {
    complete: boolean;
    unvaluedAccountCount: number;
    gaps: typeof GAP[];
    stalePrices?: typeof STALE[];
}) {
    return {
        netWorth: 250_000,
        netWorthChange: 1_200,
        netWorthChangePercent: 0.5,
        totalIncome: 8_000,
        totalExpenses: 5_000,
        savingsRate: 37.5,
        topExpenseCategory: 'Groceries',
        topExpenseAmount: 900,
        investmentValue: 180_000,
        coverage,
        changeCoverage: coverage
            ? { ...coverage, comparable: true }
            : undefined,
    };
}

const STALE_ONLY = kpis({
    complete: true,
    unvaluedAccountCount: 0,
    gaps: [],
    stalePrices: [STALE],
});

const INCOMPLETE_AND_STALE = kpis({
    complete: false,
    unvaluedAccountCount: 1,
    gaps: [GAP],
    stalePrices: [STALE],
});

describe('KPIGrid valuation banner', () => {
    it('stays silent when everything is valued from current quotes', () => {
        render(<KPIGrid data={kpis({
            complete: true, unvaluedAccountCount: 0, gaps: [], stalePrices: [],
        })} loading={false} />);

        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('discloses an old quote even when nothing was excluded', () => {
        const { container } = render(<KPIGrid data={STALE_ONLY} loading={false} />);

        expect(screen.getByText(STALE.message)).toBeTruthy();
        // Twice over: once visibly, once in the live region that speaks it.
        expect(container.textContent).toContain('These totals use out-of-date prices');
    });

    it('qualifies the figures the old quote fed, without shrinking them', () => {
        // The money IS in the total -- the caveat says the number may have
        // moved, not that anything was left out.
        render(<KPIGrid data={STALE_ONLY} loading={false} />);

        expect(screen.getAllByText(/Priced from out-of-date quotes/).length).toBeGreaterThan(0);
        expect(screen.queryByText(/excludes/)).toBeNull();
    });

    it('says who can clear it and how', () => {
        // Nothing on the dashboard fetches a price, and a book without the
        // daily worker schedule only gets one when someone asks for it.
        render(<KPIGrid data={STALE_ONLY} loading={false} />);

        expect(screen.getByText(/Refresh All Prices/)).toBeTruthy();
    });

    describe('the announcement is routed, not hand-rolled', () => {
        it('leaves the visible banner with no role of its own', () => {
            // Two roles announce the same thing twice; a role on a node that
            // mounts holding its text announces nothing at all.
            const { container } = render(<KPIGrid data={STALE_ONLY} loading={false} />);
            const banner = container.firstElementChild as HTMLElement;

            expect(banner.getAttribute('role')).toBeNull();
            expect(screen.getByRole('status').className).toContain('sr-only');
        });

        it('mounts the region empty and fills it on a later commit', () => {
            // The behaviour a source-list check cannot see. After React has
            // settled, the broken and the working version are the same node
            // with the same text; only the mutation sequence differs, and the
            // sequence is what assistive technology reacts to.
            let region!: HTMLElement;
            const records = recordMutations(() => {
                render(<KPIGrid data={STALE_ONLY} loading={false} />);
                region = screen.getByRole('status');
            });

            const inserted = insertionOf(records, region);
            expect(inserted, 'the region never entered the document').toBeGreaterThanOrEqual(0);
            expect(
                contentChangeOf(records, region, inserted),
                'the region arrived already holding its text — nothing is announced',
            ).toBeGreaterThan(inserted);
            expect(region.textContent).toMatch(/out-of-date prices/i);
        });

        it('announces the same words the banner shows', () => {
            // Heading and announcement come from one value precisely so a
            // screen-reader user and a sighted user are told the same thing.
            const { container } = render(<KPIGrid data={STALE_ONLY} loading={false} />);
            const banner = container.firstElementChild as HTMLElement;
            const visibleHeading = banner.querySelector('.font-medium');

            expect(visibleHeading?.textContent).toBe('These totals use out-of-date prices');
            expect(screen.getByRole('status').textContent).toBe(visibleHeading?.textContent);
        });

        it('interrupts for a missing balance, waits for a pause for an old price', () => {
            const { unmount } = render(<KPIGrid data={STALE_ONLY} loading={false} />);
            // Status, not alert: the total still holds together.
            expect(screen.queryByRole('alert')).toBeNull();
            expect(screen.getByRole('status')).toBeTruthy();
            unmount();

            render(<KPIGrid data={INCOMPLETE_AND_STALE} loading={false} />);
            expect(screen.getByRole('alert')).toBeTruthy();
        });

        it('still announces on the later commit when a balance was excluded', () => {
            // The assertive path has the same mount-with-the-message hazard as
            // the polite one, and it is the one that matters most.
            let region!: HTMLElement;
            const records = recordMutations(() => {
                render(<KPIGrid data={INCOMPLETE_AND_STALE} loading={false} />);
                region = screen.getByRole('alert');
            });

            const inserted = insertionOf(records, region);
            expect(inserted).toBeGreaterThanOrEqual(0);
            expect(contentChangeOf(records, region, inserted)).toBeGreaterThan(inserted);
            expect(region.textContent).toMatch(/incomplete/i);
        });
    });
});
