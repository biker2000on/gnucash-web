/**
 * Commodity and Investment Utilities
 *
 * Functions for calculating investment valuations, price lookups,
 * and gain/loss calculations.
 */

import prisma from './prisma';
import { toDecimalNumber as toDecimal } from './gnucash';
import {
    traceCostBasis,
    isTransferIn,
    createCostBasisCache,
    createCostBasisPool,
    addPurchaseToPool,
    addTracedTransferToPool,
    removeSharesFromPool,
    type CostBasisMethod,
    type CostBasisCache,
} from './cost-basis';
import { qtyEpsilonForScu, qtyEpsilonWithMagnitude } from './tolerances';
import {
    calculateGainLoss,
    calculateGainLossPercent,
    type CostBasisCoverage,
    type HoldingsData,
    type PriceData,
} from './holdings-coverage';

export {
    calculateGainLoss,
    calculateGainLossPercent,
    combineCoverage,
    sameCoverageStatement,
    totalHoldings,
} from './holdings-coverage';

export type {
    CostBasisCoverage,
    GainInput,
    HoldingsData,
    HoldingsTotals,
    HoldingTotalsInput,
    PriceData,
} from './holdings-coverage';

/**
 * Coverage of a basis summed straight from split values with no transfer
 * tracing. GnuCash records an in-kind transfer-in at a $0 split value, and this
 * path does no transfer-in detection at all, so the sum may be missing real
 * cost by an amount nobody has measured. Claiming full coverage here would
 * assert a completeness the branch never established; the ledger route declines
 * the same claim for the same reason.
 */
export const UNTRACED_BASIS_COVERAGE: CostBasisCoverage = {
    status: 'unknown',
    reason: 'Cost basis carry-over is off, so shares transferred in enter at their $0 split value and the basis may be incomplete.',
};

/**
 * Get the latest price for a commodity in a given currency
 */
export async function getLatestPrice(
    commodityGuid: string,
    currencyGuid?: string,
    asOfDate?: Date
): Promise<PriceData | null> {
    const date = asOfDate || new Date();

    const where: {
        commodity_guid: string;
        date: { lte: Date };
        currency_guid?: string;
        value_num: { gt: number };
    } = {
        commodity_guid: commodityGuid,
        date: { lte: date },
        // GnuCash's split register records implied $0 prices for zero-value
        // transfer transactions; never value holdings with them.
        value_num: { gt: 0 },
    };

    if (currencyGuid) {
        where.currency_guid = currencyGuid;
    }

    const price = await prisma.prices.findFirst({
        where,
        orderBy: { date: 'desc' },
    });

    if (!price) return null;

    return {
        guid: price.guid,
        date: price.date,
        value: toDecimal(price.value_num, price.value_denom),
        source: price.source,
    };
}

/**
 * Get price history for a commodity
 */
export async function getPriceHistory(
    commodityGuid: string,
    currencyGuid?: string,
    days = 30
): Promise<PriceData[]> {
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days);

    const where: {
        commodity_guid: string;
        date: { gte: Date };
        currency_guid?: string;
    } = {
        commodity_guid: commodityGuid,
        date: { gte: startDate },
    };

    if (currencyGuid) {
        where.currency_guid = currencyGuid;
    }

    const prices = await prisma.prices.findMany({
        where,
        orderBy: { date: 'asc' },
    });

    return prices.map(p => ({
        guid: p.guid,
        date: p.date,
        value: toDecimal(p.value_num, p.value_denom),
        source: p.source,
    }));
}

/**
 * Calculate total shares from splits (quantity_num/quantity_denom)
 */
export function calculateShares(splits: Array<{ quantity_num: bigint; quantity_denom: bigint }>): number {
    return splits.reduce((sum, split) => {
        return sum + toDecimal(split.quantity_num, split.quantity_denom);
    }, 0);
}

/**
 * Calculate cost basis from splits (value_num/value_denom)
 * This is the total amount paid for the shares.
 * If tracedCostBasis is provided (from cost basis carry-over tracing),
 * it is used directly instead of summing split values.
 */
export function calculateCostBasis(
    splits: Array<{ value_num: bigint; value_denom: bigint }>,
    tracedCostBasis?: number,
): number {
    if (tracedCostBasis !== undefined) {
        return tracedCostBasis;
    }
    return splits.reduce((sum, split) => {
        return sum + toDecimal(split.value_num, split.value_denom);
    }, 0);
}

/**
 * Calculate current market value
 */
export function calculateMarketValue(shares: number, pricePerShare: number): number {
    return shares * pricePerShare;
}

/**
 * Options for cost basis carry-over in holdings calculations
 */
export interface CostBasisOptions {
    enabled: boolean;
    method: CostBasisMethod;
    cache?: CostBasisCache;
}

/**
 * Get full holdings data for an investment account.
 * When costBasisOptions is provided and enabled, traces transfer-in splits
 * back to their original purchase cost.
 */
export async function getAccountHoldings(
    accountGuid: string,
    asOfDate?: Date,
    costBasisOptions?: CostBasisOptions,
): Promise<HoldingsData> {
    // Get account with commodity info
    const account = await prisma.accounts.findUnique({
        where: { guid: accountGuid },
        include: {
            commodity: true,
        },
    });

    if (!account || !account.commodity) {
        return {
            shares: 0,
            costBasis: 0,
            // Not `complete` with zero covered shares: that asserts a measured
            // basis for a position nothing was read for.
            costBasisCoverage: {
                status: 'unknown',
                reason: 'Account not found, or it holds no commodity.',
            },
            marketValue: 0,
            gainLoss: 0,
            gainLossPercent: 0,
            latestPrice: null,
        };
    }

    const commodityGuid = account.commodity_guid!;

    // Get all splits for this account
    const splits = await prisma.splits.findMany({
        where: {
            account_guid: accountGuid,
            transaction: asOfDate ? {
                post_date: { lte: asOfDate },
            } : undefined,
        },
        select: {
            guid: true,
            quantity_num: true,
            quantity_denom: true,
            value_num: true,
            value_denom: true,
        },
    });

    const shares = calculateShares(splits);

    // Calculate cost basis -- with optional carry-over tracing
    let rawCostBasis: number;
    // Coverage travels WITH the basis: `costBasis` below is the basis of the
    // shares `rawCoverage` describes, never automatically of all `shares`.
    let rawCoverage: CostBasisCoverage;

    if (costBasisOptions?.enabled && commodityGuid) {
        // Fetch splits with transaction/account data for transfer detection
        const splitsWithTx = await prisma.splits.findMany({
            where: {
                account_guid: accountGuid,
                transaction: asOfDate ? {
                    post_date: { lte: asOfDate },
                } : undefined,
            },
            include: {
                transaction: {
                    include: {
                        splits: {
                            include: {
                                account: { select: { guid: true, commodity_guid: true, account_type: true } },
                            },
                        },
                    },
                },
            },
        });

        // Sort by date for proper cost basis accumulation
        splitsWithTx.sort((a, b) => {
            const dateA = a.transaction?.post_date?.getTime() || 0;
            const dateB = b.transaction?.post_date?.getTime() || 0;
            return dateA - dateB;
        });

        const cache = costBasisOptions.cache || createCostBasisCache();
        // A CostBasisPool, not a pair of loose running totals: a traced
        // transfer-in returns basis for only the shares it could establish, so
        // adding that basis while counting ALL the shares would divide a
        // partial cost by a full share count and understate the basis of every
        // share in the account (the H4 defect, one level up).
        const pool = createCostBasisPool();

        for (const split of splitsWithTx) {
            const qty = toDecimal(split.quantity_num, split.quantity_denom);
            const val = Math.abs(toDecimal(split.value_num, split.value_denom));

            if (qty > 0) {
                const txSplits = split.transaction?.splits || [];
                if (isTransferIn(split, txSplits, commodityGuid)) {
                    const traced = await traceCostBasis(split.guid, costBasisOptions.method, commodityGuid, qty, cache);
                    addTracedTransferToPool(pool, traced);
                } else {
                    addPurchaseToPool(pool, qty, val);
                }
            } else if (qty < 0) {
                removeSharesFromPool(pool, Math.abs(qty));
            }
        }

        rawCostBasis = pool.basisOfCoveredShares;

        // The same commodity-aware share tolerance the lot engine and the
        // ledger route use, deliberately reused rather than re-derived: at
        // crypto's 1e8 precision a flat 0.0001 reads a real one-unit oversell
        // as agreement. It is also MAGNITUDE-SCALED, because `shares` and the
        // pool's share count are two independent float sums over the same long
        // split replay: on a multi-million-share position their IEEE-754
        // residues diverge by more than any absolute epsilon, and an absolute
        // bound would report a perfectly consistent account as "coverage
        // unknown". The absolute floor still governs small positions.
        const absEps = qtyEpsilonForScu(account.commodity_scu);
        const poolShares = pool.coveredShares + pool.uncoveredShares;
        const coverageEps = qtyEpsilonWithMagnitude(
            account.commodity_scu,
            Math.max(Math.abs(shares), Math.abs(poolShares)),
        );
        if (Math.abs(shares - poolShares) >= coverageEps) {
            // An oversell empties the pool while `shares` goes negative; it
            // cannot describe a short position. The share count and basis stay
            // as computed, but coverage becomes unknown rather than a
            // "0 uncovered" claim a consumer would read as full coverage.
            rawCoverage = {
                status: 'unknown',
                reason: 'The share balance and the cost-basis pool disagree (an oversell leaves a short position the pool cannot describe).',
            };
        } else if (pool.uncoveredShares >= absEps) {
            rawCoverage = {
                status: 'partial',
                coveredShares: pool.coveredShares,
                uncoveredShares: pool.uncoveredShares,
                warnings: pool.warnings,
            };
        } else {
            rawCoverage = { status: 'complete', coveredShares: pool.coveredShares };
        }
    } else {
        rawCostBasis = calculateCostBasis(splits);
        rawCoverage = UNTRACED_BASIS_COVERAGE;
    }

    // Get latest price
    const latestPrice = await getLatestPrice(commodityGuid, undefined, asOfDate);
    const pricePerShare = latestPrice?.value || 0;

    // Zero-share holdings should have zero cost basis and market value.
    // Commodity-aware: a flat 0.0001 would zero out a real 1e-5 BTC position.
    const isZeroShares = Math.abs(shares) < qtyEpsilonForScu(account.commodity_scu);
    const costBasis = isZeroShares ? 0 : rawCostBasis;
    // A closed position holds nothing to cover, so zeroing the basis leaves
    // nothing overstated to caveat.
    const coverage: CostBasisCoverage = isZeroShares
        ? { status: 'complete', coveredShares: 0 }
        : rawCoverage;
    const marketValue = isZeroShares ? 0 : calculateMarketValue(shares, pricePerShare);
    const gainLoss = isZeroShares
        ? 0
        : calculateGainLoss({ shares, pricePerShare, costBasis, coverage });
    const gainLossPercent = calculateGainLossPercent(gainLoss, costBasis);

    return {
        shares: isZeroShares ? 0 : shares,
        costBasis,
        costBasisCoverage: coverage,
        marketValue,
        gainLoss,
        gainLossPercent,
        latestPrice,
    };
}

/**
 * Check if an account is an investment account (non-currency commodity)
 */
export async function isInvestmentAccount(accountGuid: string): Promise<boolean> {
    const account = await prisma.accounts.findUnique({
        where: { guid: accountGuid },
        include: {
            commodity: true,
        },
    });

    if (!account || !account.commodity) return false;

    // Investment accounts have commodities that are not in the CURRENCY namespace
    return account.commodity.namespace !== 'CURRENCY';
}
