/**
 * The statement-level valuation disclosure.
 *
 * Two different statements travel on the same coverage record and must not be
 * confused for one another:
 *
 *   - a GAP means a balance was left OUT of the total, so the balance check
 *     cannot be assessed;
 *   - a STALE PRICE means the balance IS in the total, priced from a quote old
 *     enough that the figure may no longer be current.
 *
 * A complete-but-stale statement therefore still has to say something. Silence
 * there is the whole defect this notice exists to close.
 *
 * "Says something" means two things that are easy to conflate: text on screen,
 * and text a screen reader announces. The panel below renders with its wording
 * already in place, which is precisely the shape that never announces when the
 * role is hand-rolled onto it — the node and its text enter the accessibility
 * tree in the same commit. So the announcement goes through the shared
 * `ErrorLiveRegion`, which mounts empty and publishes one commit later, and the
 * tests below check the ORDER of the DOM mutations rather than the final DOM,
 * because after the fact the two are indistinguishable.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ValuationCoverage } from '@/lib/account-valuation';
import { ValuationCoverageNotice } from '../ValuationCoverageNotice';

/** The visible warning panel: the outermost element the component renders. */
function panel(container: HTMLElement): HTMLElement {
    return container.firstElementChild as HTMLElement;
}

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
    commodityGuid: 'stock-guid',
    label: 'AAPL',
    priceDate: '2026-06-01',
    ageDays: 77,
    message: 'AAPL priced from a quote 77 days old (2026-06-01).',
};

function coverage(overrides: Partial<ValuationCoverage> = {}): ValuationCoverage {
    return {
        complete: true,
        unvaluedAccountCount: 0,
        gaps: [],
        stalePrices: [],
        ...overrides,
    };
}

const INCOMPLETE_AND_STALE: ValuationCoverage = {
    complete: false,
    unvaluedAccountCount: 1,
    gaps: [{
        commodityGuid: 'privco-guid',
        label: 'PRIVCO',
        reason: 'missing-security-price',
        message: 'PRIVCO excluded: no price path to USD as of 2026-08-17.',
    }],
    stalePrices: [STALE],
};

describe('ValuationCoverageNotice', () => {
    it('stays silent on a complete, freshly priced statement', () => {
        const { container } = render(<ValuationCoverageNotice coverage={coverage()} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('discloses a stale price even when nothing was excluded', () => {
        render(<ValuationCoverageNotice coverage={coverage({ stalePrices: [STALE] })} />);

        expect(screen.getByText(STALE.message)).toBeTruthy();
        expect(screen.getByRole('status')).toBeTruthy();
    });

    it('does not claim the balance check failed just because a price is old', () => {
        render(<ValuationCoverageNotice coverage={coverage({ stalePrices: [STALE] })} />);

        expect(screen.queryByText(/balance check cannot be assessed/i)).toBeNull();
    });

    it('still reports an exclusion, and reports both when both apply', () => {
        const { container } = render(<ValuationCoverageNotice coverage={INCOMPLETE_AND_STALE} />);
        const visible = panel(container);

        expect(visible.textContent).toMatch(/balance check cannot be assessed/i);
        expect(screen.getByText(/PRIVCO excluded/)).toBeTruthy();
        expect(screen.getByText(STALE.message)).toBeTruthy();
        // An exclusion is the louder of the two.
        expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('renders nothing without a coverage record', () => {
        const { container } = render(<ValuationCoverageNotice coverage={undefined} />);
        expect(container).toBeEmptyDOMElement();
    });

    describe('the announcement is routed, not hand-rolled', () => {
        it('leaves the visible panel with no role of its own', () => {
            // Two roles would announce the same thing twice; and a role on a
            // node that mounts holding its text announces nothing at all.
            const { container } = render(
                <ValuationCoverageNotice coverage={coverage({ stalePrices: [STALE] })} />,
            );

            expect(panel(container).getAttribute('role')).toBeNull();
            expect(screen.getByRole('status').className).toContain('sr-only');
        });

        it('mounts the region empty and fills it on a later commit', () => {
            // The defect this guards against is invisible once React has
            // settled: a region that mounted with its text and one that mounted
            // empty and was then updated are the same node with the same
            // textContent. Only the mutation order tells them apart, and the
            // mutation order is what a screen reader responds to.
            let region!: HTMLElement;
            const records = recordMutations(() => {
                render(<ValuationCoverageNotice coverage={coverage({ stalePrices: [STALE] })} />);
                region = screen.getByRole('status');
            });

            const inserted = insertionOf(records, region);
            expect(inserted, 'the region never entered the document').toBeGreaterThanOrEqual(0);
            expect(
                contentChangeOf(records, region, inserted),
                'the region arrived already holding its text — nothing is announced',
            ).toBeGreaterThan(inserted);
            expect(region.textContent).toMatch(/out-of-date quote/i);
        });

        it('announces assertively when a balance was excluded, politely when only old', () => {
            const { unmount } = render(
                <ValuationCoverageNotice coverage={coverage({ stalePrices: [STALE] })} />,
            );
            // Status, not alert: an old price qualifies a statement that still
            // holds together, so it must not cut across what is being read.
            expect(screen.queryByRole('alert')).toBeNull();
            expect(screen.getByRole('status')).toBeTruthy();
            unmount();

            render(<ValuationCoverageNotice coverage={INCOMPLETE_AND_STALE} />);
            expect(screen.getByRole('alert')).toBeTruthy();
        });
    });
});
