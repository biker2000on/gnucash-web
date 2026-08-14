'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import type { CostBasisCoverage } from '@/lib/commodities';

function formatShares(shares: number): string {
    return shares.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * What the coverage means for the particular number being marked.
 *
 * Required at every call site rather than defaulted, because the consequence
 * is not the same everywhere: a partial basis narrows the gain to a nameable
 * slice, but it makes yield-on-cost underivable outright.
 */
export interface CoverageConsequence {
    partial: string;
    unknown: string;
}

/** For a cost basis and the gain figures computed against it. */
export const BASIS_CONSEQUENCE: CoverageConsequence = {
    partial: "Gain and gain % cover those shares only; the rest have no basis to compare against.",
    unknown: 'Any gain computed from it may be overstated by whatever basis is missing.',
};

/** For yield-on-cost, which is withheld rather than estimated. See dividends.ts. */
export const YIELD_CONSEQUENCE: CoverageConsequence = {
    partial: 'Yield on cost is not shown: dividend income cannot be attributed to the covered shares alone without knowing when each share was held.',
    unknown: 'Yield on cost is not shown: it would divide income by a basis of unverified completeness.',
};

/**
 * The sentence a reader needs next to a number whose basis does not describe
 * the whole position. Exported so tests (and non-tooltip surfaces) can assert
 * the wording without rendering a portal.
 */
export function coverageCaveat(
    coverage: CostBasisCoverage,
    consequence: CoverageConsequence,
): string | null {
    switch (coverage.status) {
        case 'complete':
            return null;
        case 'partial': {
            const total = coverage.coveredShares + coverage.uncoveredShares;
            return (
                `Cost basis covers ${formatShares(coverage.coveredShares)} of ${formatShares(total)} shares. ` +
                `${formatShares(coverage.uncoveredShares)} have no traceable basis in this book. ` +
                consequence.partial +
                (coverage.warnings.length > 0 ? ` ${coverage.warnings.join(' ')}` : '')
            );
        }
        case 'unknown':
            return `Cost-basis coverage is unverified. ${coverage.reason} ${consequence.unknown}`;
    }
}

/**
 * The slice a gain figure actually describes, as a label that reads without a
 * tooltip — the caveat cannot depend on the user hovering anything.
 */
export function coveredSliceLabel(coverage: CostBasisCoverage): string | null {
    switch (coverage.status) {
        case 'complete':
            return null;
        case 'partial': {
            const total = coverage.coveredShares + coverage.uncoveredShares;
            return `covered gain · ${formatShares(coverage.coveredShares)} of ${formatShares(total)} shares`;
        }
        case 'unknown':
            return 'basis coverage unverified';
    }
}

/** Heading for a gain figure: names the slice instead of implying the whole position. */
export function gainHeading(coverage: CostBasisCoverage, whole = 'Gain/Loss'): string {
    return coverage.status === 'complete' ? whole : 'Covered Gain';
}

/**
 * Inline caveat marker for a number whose cost basis is partial or of
 * unverified coverage — the honest partial number stays visible and this says
 * what it leaves out, rather than blanking a cell the user can still learn
 * from.
 *
 * Renders nothing under complete coverage, which is most holdings.
 *
 * Per DESIGN.md: the shared `Tooltip` primitive (hover, keyboard focus, and
 * tap; `title=` attributes are banned), `--warning` for a measured shortfall and
 * `--foreground-muted` for an unverified one, no decoration beyond the glyph.
 */
export function CostBasisCoverageMark({
    coverage,
    consequence,
    className = '',
}: {
    coverage: CostBasisCoverage;
    consequence: CoverageConsequence;
    className?: string;
}) {
    const caveat = coverageCaveat(coverage, consequence);
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

/**
 * The slice label rendered under a gain figure. Always visible: a user who
 * never opens the tooltip must still not read a covered gain as the whole
 * position's.
 */
export function CoveredSliceNote({
    coverage,
    className = '',
}: {
    coverage: CostBasisCoverage;
    className?: string;
}) {
    const label = coveredSliceLabel(coverage);
    if (!label) return null;
    return <div className={`text-xs font-normal text-foreground-muted ${className}`}>{label}</div>;
}
