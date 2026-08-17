/**
 * Browser-safe, pure helpers for investment holding coverage and gains.
 *
 * This module must have ZERO imports and contain only pure functions. It is
 * shared by server-side valuation code and Client Components; importing a
 * database, service, or Node-only module here can pull the Postgres driver
 * into the browser bundle and break `next build`.
 */

export interface PriceData {
    guid: string;
    date: Date;
    value: number;
    source: string | null;
}

/**
 * How much of a holding the reported cost basis actually describes.
 *
 * Tri-state, mirroring the investment ledger route
 * (`src/app/api/accounts/[guid]/transactions/route.ts`): a covered-share count
 * when coverage is known and complete, that count plus an uncovered count when
 * it is partial, and neither when coverage cannot be determined at all.
 *
 * It is a DISCRIMINATED UNION rather than an `uncoveredShares: number | null`
 * field on purpose. A null passes through `Number(null) === 0` and reads as
 * "every share has a basis" — the exact false claim this type exists to
 * prevent. `uncoveredShares` lives only on the `partial` member, so no consumer
 * can reach (or accidentally arithmetic its way past) it without first
 * narrowing on `status`.
 */
export type CostBasisCoverage =
    | { status: 'complete'; coveredShares: number }
    | { status: 'partial'; coveredShares: number; uncoveredShares: number; warnings: string[] }
    | { status: 'unknown'; reason: string };

export function combineCoverage(parts: CostBasisCoverage[]): CostBasisCoverage {
    if (parts.length === 0) return { status: 'complete', coveredShares: 0 };

    let coveredShares = 0;
    let uncoveredShares = 0;
    const warnings: string[] = [];
    for (const part of parts) {
        if (part.status === 'unknown') return part;
        coveredShares += part.coveredShares;
        if (part.status === 'partial') {
            uncoveredShares += part.uncoveredShares;
            for (const warning of part.warnings) {
                if (!warnings.includes(warning)) warnings.push(warning);
            }
        }
    }

    return uncoveredShares > 0
        ? { status: 'partial', coveredShares, uncoveredShares, warnings }
        : { status: 'complete', coveredShares };
}

/**
 * Do two coverages make the SAME statement?
 *
 * Not `a.status === b.status`: two partial coverages can both be "partial"
 * while saying entirely different things — "150 of 200 shares" and "10 of 900
 * shares" are not interchangeable, and a surface that discloses one aggregate
 * statement on behalf of rows matched only on the discriminant tag silently
 * misdescribes every row whose counts differ.
 *
 * `complete` carries nothing to state, so two completes always agree.
 */
export function sameCoverageStatement(a: CostBasisCoverage, b: CostBasisCoverage): boolean {
    if (a.status !== b.status) return false;
    if (a.status === 'partial' && b.status === 'partial') {
        return a.coveredShares === b.coveredShares && a.uncoveredShares === b.uncoveredShares;
    }
    if (a.status === 'unknown' && b.status === 'unknown') {
        return a.reason === b.reason;
    }
    return true;
}

export interface HoldingTotalsInput {
    costBasis: number;
    costBasisCoverage: CostBasisCoverage;
    marketValue: number;
    gainLoss: number;
}

export interface HoldingsTotals {
    totalValue: number;
    totalCostBasis: number;
    totalCostBasisCoverage: CostBasisCoverage;
    totalGainLoss: number;
    totalGainLossPercent: number;
}

/**
 * Total a set of holdings without undoing their coverage.
 *
 * `totalGainLoss` SUMS the per-holding gains. Recomputing it as
 * `totalValue - totalCostBasis` is the defect in aggregate form: each holding's
 * gain is already restricted to the shares its basis covers, and that
 * subtraction puts every uncovered share's full market value straight back in
 * — so a total would disagree with the sum of the rows displayed beneath it.
 */
export function totalHoldings(holdings: HoldingTotalsInput[]): HoldingsTotals {
    let totalValue = 0;
    let totalCostBasis = 0;
    let totalGainLoss = 0;
    for (const holding of holdings) {
        totalValue += holding.marketValue;
        totalCostBasis += holding.costBasis;
        totalGainLoss += holding.gainLoss;
    }
    return {
        totalValue,
        totalCostBasis,
        totalCostBasisCoverage: combineCoverage(holdings.map(h => h.costBasisCoverage)),
        totalGainLoss,
        totalGainLossPercent: calculateGainLossPercent(totalGainLoss, totalCostBasis),
    };
}

export interface HoldingsData {
    shares: number;
    costBasis: number;
    costBasisCoverage: CostBasisCoverage;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
    latestPrice: PriceData | null;
}

export interface GainInput {
    shares: number;
    pricePerShare: number;
    costBasis: number;
    coverage: CostBasisCoverage;
}

/**
 * Unrealized gain of the shares the cost basis actually covers.
 *
 * The coverage argument is required rather than optional because the naive
 * `marketValue - costBasis` is wrong precisely when nobody remembered to check:
 * under partial coverage it subtracts the basis of SOME shares from the market
 * value of ALL of them, overstating the gain by the full market value of every
 * uncovered share (a $0-basis share reads as pure profit).
 *
 * So the market value is restricted to the same shares the basis describes:
 *
 *  - `complete` — every share is covered; unchanged from a plain
 *    `marketValue - costBasis`.
 *  - `partial` — `coveredShares x price - costBasis`. Both sides now describe
 *    the same shares, which is a statement that is exactly true, rather than a
 *    blank cell (the uncovered shares' own gain is unknowable, not zero) or an
 *    inflated one. Callers must surface the uncovered count alongside it.
 *  - `unknown` — the full position, because there is no covered subset to
 *    restrict to. The number is the best available and may be overstated by
 *    whatever basis is missing, so callers must render it with the caveat.
 */
export function calculateGainLoss({ shares, pricePerShare, costBasis, coverage }: GainInput): number {
    const valuedShares = coverage.status === 'partial' ? coverage.coveredShares : shares;
    // Deliberately inlined: calculateMarketValue lives in a prisma-importing module;
    // importing it here drags the Postgres driver into the browser bundle and breaks `next build`.
    return valuedShares * pricePerShare - costBasis;
}

export function calculateGainLossPercent(gainLoss: number, costBasis: number): number {
    if (costBasis === 0) return 0;
    return (gainLoss / Math.abs(costBasis)) * 100;
}
