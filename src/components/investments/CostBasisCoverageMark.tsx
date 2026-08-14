'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import type { CostBasisCoverage } from '@/lib/commodities';

function formatShares(shares: number): string {
    return shares.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * The sentence a reader needs next to a basis that does not describe the whole
 * position. Exported so tests (and non-tooltip surfaces) can assert the wording
 * without rendering a portal.
 */
export function coverageCaveat(coverage: CostBasisCoverage): string | null {
    switch (coverage.status) {
        case 'complete':
            return null;
        case 'partial': {
            const total = coverage.coveredShares + coverage.uncoveredShares;
            return (
                `Cost basis covers ${formatShares(coverage.coveredShares)} of ${formatShares(total)} shares. ` +
                `${formatShares(coverage.uncoveredShares)} have no traceable basis in this book, so gain and gain % ` +
                `are the covered shares' only.` +
                (coverage.warnings.length > 0 ? ` ${coverage.warnings.join(' ')}` : '')
            );
        }
        case 'unknown':
            return `Cost-basis coverage is unverified, so the gain may be overstated. ${coverage.reason}`;
    }
}

/**
 * Inline caveat marker for a cost basis that is partial or of unverified
 * coverage — the honest partial number stays visible and this says what it
 * leaves out, rather than blanking a cell the user can still learn from.
 *
 * Renders nothing under complete coverage, which is most holdings.
 *
 * Per DESIGN.md: the shared `Tooltip` primitive (hover, keyboard focus, and
 * tap; `title=` attributes are banned), `--warning` for a measured shortfall and
 * `--foreground-muted` for an unverified one, no decoration beyond the glyph.
 */
export function CostBasisCoverageMark({
    coverage,
    className = '',
}: {
    coverage: CostBasisCoverage;
    className?: string;
}) {
    const caveat = coverageCaveat(coverage);
    if (!caveat) return null;

    const tone = coverage.status === 'partial' ? 'text-warning' : 'text-foreground-muted';

    return (
        <Tooltip
            content={caveat}
            ariaLabel={
                coverage.status === 'partial'
                    ? 'Cost basis covers only part of this position'
                    : 'Cost-basis coverage is unverified'
            }
            className={`align-baseline ${className}`}
        >
            <span aria-hidden="true" className={`ml-1 text-sm font-medium ${tone}`}>
                *
            </span>
        </Tooltip>
    );
}
