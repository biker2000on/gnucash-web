'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import type { CostBasisCoverage, PositionSide } from '@/lib/holdings-coverage';
import { positionSideBasisLabel } from '@/lib/holdings-coverage';

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

/**
 * Heading for a gain figure.
 *
 * The three states get three headings, because they are three different
 * numbers. Only `partial` is a covered slice: `calculateGainLoss` values the
 * covered shares there. Under `unknown` it values the WHOLE position and the
 * result may be overstated by whatever basis is missing — calling that a
 * "Covered Gain" would claim a measured slice that was never measured.
 */
export function gainHeading(coverage: CostBasisCoverage, whole = 'Gain/Loss'): string {
    switch (coverage.status) {
        case 'complete':
            return whole;
        case 'partial':
            return 'Covered Gain';
        case 'unknown':
            return 'Gain (basis unverified)';
    }
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
 * The sentence a reader needs next to a basis that is PROCEEDS rather than cost.
 *
 * Exported so tests and non-tooltip surfaces can assert the wording without
 * rendering a portal, matching `coverageCaveat`.
 */
export function shortPositionCaveat(side: PositionSide | undefined): string | null {
    switch (side) {
        case 'short':
            return (
                'This position is short: the shares were sold before they were owned. ' +
                'The figure shown is the proceeds received for them, not a purchase cost, ' +
                'and the gain is those proceeds minus what it would cost to buy the shares ' +
                'back at today’s price — so the position gains when the price falls. ' +
                'Gain or loss on a short sale is short-term regardless of how long the ' +
                'position is held (IRS Pub. 550, “Short Sales”).'
            );
        case 'mixed':
            return (
                'This total combines long and short legs. Its basis adds money spent on the ' +
                'long shares to money received for the short ones, so it is not a purchase ' +
                'cost; open the row to read each account on its own.'
            );
        default:
            return null;
    }
}

/**
 * Inline marker for a basis that is a short position's proceeds.
 *
 * Deliberately a different glyph and tone from `CostBasisCoverageMark`: the two
 * say different things and can appear on the same number. Coverage is about how
 * much of a position the basis describes; this is about what the basis IS. A
 * shared `*` would collapse them into one unreadable footnote.
 *
 * Renders nothing for a long or flat position, which is nearly every row.
 */
export function ShortPositionMark({
    positionSide,
    className = '',
}: {
    positionSide: PositionSide | undefined;
    className?: string;
}) {
    const caveat = shortPositionCaveat(positionSide);
    if (!caveat) return null;

    return (
        <Tooltip
            content={caveat}
            ariaLabel={
                positionSide === 'short'
                    ? 'This basis is short-sale proceeds, not a purchase cost'
                    : 'This total combines long and short legs'
            }
            className={`align-baseline ${className}`}
        >
            <span aria-hidden="true" className="ml-1 text-sm font-medium text-warning">
                &#8595;
            </span>
        </Tooltip>
    );
}

/**
 * The always-visible label under a short basis.
 *
 * Same rule as `CoveredSliceNote`: a reader who never opens a tooltip must not
 * take proceeds for a cost. Renders nothing for a long or flat position.
 */
export function ShortBasisNote({
    positionSide,
    className = '',
}: {
    positionSide: PositionSide | undefined;
    className?: string;
}) {
    const label = positionSideBasisLabel(positionSide);
    if (!label) return null;
    return <div className={`text-xs font-normal text-foreground-muted ${className}`}>{label}</div>;
}

/**
 * An always-visible, table-level statement of coverage.
 *
 * For a table whose rows all say the same thing, this is what replaces N
 * repeated markers — NOT a tooltip on the column header. A reader who has
 * scrolled the header off screen, or who never hovers anything, must still see
 * that the numbers in front of them carry a caveat; DESIGN.md's put-it-in-the-
 * header rule is about repeated abbreviations, not about financial disclosures.
 *
 * Renders nothing under complete coverage.
 */
export function CoverageCaption({
    coverage,
    consequence,
    scope = 'All rows',
    className = '',
}: {
    coverage: CostBasisCoverage;
    consequence: CoverageConsequence;
    /** What the statement applies to, e.g. "All rows". */
    scope?: string;
    className?: string;
}) {
    const caveat = coverageCaveat(coverage, consequence);
    if (!caveat) return null;

    const tone = coverage.status === 'partial' ? 'text-warning' : 'text-foreground-muted';

    return (
        <p className={`text-xs ${tone} ${className}`}>
            {scope} — {caveat}
        </p>
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
