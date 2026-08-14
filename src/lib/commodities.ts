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

export interface PriceData {
    guid: string;
    date: Date;
    value: number;
    source: string | null;
}

export interface HoldingsData {
    shares: number;
    /**
     * Cost basis of `costBasisCoveredShares` — NOT necessarily of `shares`.
     * When `costBasisUncoveredShares > 0` some holdings have no establishable
     * basis (in-kind transfers whose origin is not in this book), so `gainLoss`
     * below overstates the gain by whatever those shares actually cost. Report
     * `costBasisWarnings` alongside the number rather than presenting it as a
     * complete basis.
     */
    costBasis: number;
    /** Shares whose basis is included in `costBasis`. */
    costBasisCoveredShares: number;
    /** Shares with no establishable basis; excluded from `costBasis`. */
    costBasisUncoveredShares: number;
    /** Plain-English notes naming the uncovered shares. */
    costBasisWarnings: string[];
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
    latestPrice: PriceData | null;
}

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
 * Calculate unrealized gain/loss
 */
export function calculateGainLoss(marketValue: number, costBasis: number): number {
    return marketValue - costBasis;
}

/**
 * Calculate gain/loss percentage
 */
export function calculateGainLossPercent(gainLoss: number, costBasis: number): number {
    if (costBasis === 0) return 0;
    return (gainLoss / Math.abs(costBasis)) * 100;
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
            costBasisCoveredShares: 0,
            costBasisUncoveredShares: 0,
            costBasisWarnings: [],
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
    // Coverage travels WITH the basis: `costBasis` below is the basis of
    // `costBasisCoveredShares`, never of all `shares`.
    let coveredShares = 0;
    let uncoveredShares = 0;
    let costBasisWarnings: string[] = [];

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
        coveredShares = pool.coveredShares;
        uncoveredShares = pool.uncoveredShares;
        costBasisWarnings = pool.warnings;
    } else {
        rawCostBasis = calculateCostBasis(splits);
        coveredShares = shares;
    }

    // Get latest price
    const latestPrice = await getLatestPrice(commodityGuid, undefined, asOfDate);
    const pricePerShare = latestPrice?.value || 0;

    // Zero-share holdings should have zero cost basis and market value
    // Use tolerance for floating point comparison (shares < 0.0001 is effectively zero)
    const isZeroShares = Math.abs(shares) < 0.0001;
    const costBasis = isZeroShares ? 0 : rawCostBasis;
    const marketValue = isZeroShares ? 0 : calculateMarketValue(shares, pricePerShare);
    const gainLoss = calculateGainLoss(marketValue, costBasis);
    const gainLossPercent = calculateGainLossPercent(gainLoss, costBasis);

    return {
        shares: isZeroShares ? 0 : shares,
        costBasis,
        costBasisCoveredShares: isZeroShares ? 0 : coveredShares,
        costBasisUncoveredShares: isZeroShares ? 0 : uncoveredShares,
        costBasisWarnings,
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
