/**
 * Browser-safe helpers for investment holding coverage and gains.
 *
 * This module deliberately has no imports. It is shared by server-side
 * valuation code and Client Components, so it must remain free of database,
 * service, and Node-only dependencies.
 */

export interface PriceData {
    guid: string;
    date: Date;
    value: number;
    source: string | null;
}

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

export function calculateGainLoss({ shares, pricePerShare, costBasis, coverage }: GainInput): number {
    const valuedShares = coverage.status === 'partial' ? coverage.coveredShares : shares;
    return valuedShares * pricePerShare - costBasis;
}

export function calculateGainLossPercent(gainLoss: number, costBasis: number): number {
    if (costBasis === 0) return 0;
    return (gainLoss / Math.abs(costBasis)) * 100;
}
