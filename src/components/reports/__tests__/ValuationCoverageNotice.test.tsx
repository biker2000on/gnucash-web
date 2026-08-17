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
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ValuationCoverage } from '@/lib/account-valuation';
import { ValuationCoverageNotice } from '../ValuationCoverageNotice';

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
        render(<ValuationCoverageNotice coverage={coverage({
            complete: false,
            unvaluedAccountCount: 1,
            gaps: [{
                commodityGuid: 'privco-guid',
                label: 'PRIVCO',
                reason: 'missing-security-price',
                message: 'PRIVCO excluded: no price path to USD as of 2026-08-17.',
            }],
            stalePrices: [STALE],
        })} />);

        expect(screen.getByText(/balance check cannot be assessed/i)).toBeTruthy();
        expect(screen.getByText(/PRIVCO excluded/)).toBeTruthy();
        expect(screen.getByText(STALE.message)).toBeTruthy();
        // An exclusion is the louder of the two.
        expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('renders nothing without a coverage record', () => {
        const { container } = render(<ValuationCoverageNotice coverage={undefined} />);
        expect(container).toBeEmptyDOMElement();
    });
});
