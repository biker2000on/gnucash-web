/**
 * Lot Service
 *
 * Provides functions for querying GnuCash lots and computing
 * summaries including realized/unrealized gains, holding periods,
 * and per-lot split details.
 */

import prisma from './prisma';
import { toDecimal as toDecimalString } from './gnucash';
import { getLatestPrice } from './commodities';

/**
 * Convert GnuCash fraction to a number
 */
function toDecimal(num: bigint | number | string | null, denom: bigint | number | string | null): number {
    if (num === null || denom === null) return 0;
    return parseFloat(toDecimalString(num, denom));
}

export interface LotSplit {
    guid: string;
    txGuid: string;
    postDate: string;
    description: string;
    shares: number;          // quantity_decimal
    value: number;           // value_decimal (in transaction currency)
    shareBalance: number;    // running balance of shares within the lot
}

export interface LotSummary {
    guid: string;
    accountGuid: string;
    isClosed: boolean;
    title: string;           // from slots table or "Lot N"
    openDate: string | null; // earliest split date
    closeDate: string | null; // latest split date (if closed)
    totalShares: number;     // sum of quantity_decimal for all splits in lot
    totalCost: number;       // sum of value_decimal for buy splits (positive qty)
    realizedGain: number;    // sum of all values when lot is closed
    unrealizedGain: number | null; // (currentPrice * shares) - costBasis (null if no price)
    holdingPeriod: 'short_term' | 'long_term' | null; // based on open date vs today (1 year threshold)
    currentPrice: number | null;
    splits: LotSplit[];
}

/**
 * Build LotSplit objects from raw splits with transactions, computing running share balance.
 */
function buildLotSplits(
    splits: Array<{
        guid: string;
        tx_guid: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        value_num: bigint;
        value_denom: bigint;
        transaction: {
            post_date: Date | null;
            description: string | null;
        };
    }>
): LotSplit[] {
    // Sort by post_date ascending
    const sorted = [...splits].sort((a, b) => {
        const dateA = a.transaction?.post_date?.getTime() || 0;
        const dateB = b.transaction?.post_date?.getTime() || 0;
        return dateA - dateB;
    });

    let shareBalance = 0;
    return sorted.map(split => {
        const shares = toDecimal(split.quantity_num, split.quantity_denom);
        shareBalance += shares;
        return {
            guid: split.guid,
            txGuid: split.tx_guid,
            postDate: split.transaction?.post_date?.toISOString() || '',
            description: split.transaction?.description || '',
            shares,
            value: toDecimal(split.value_num, split.value_denom),
            shareBalance,
        };
    });
}

/**
 * Get all lots for an account with computed summaries.
 * Lots are sorted with open lots first, then by open date descending.
 */
export async function getAccountLots(accountGuid: string): Promise<LotSummary[]> {
    // Fetch lots with their splits and transactions
    const lots = await prisma.lots.findMany({
        where: { account_guid: accountGuid },
        include: {
            splits: {
                include: {
                    transaction: {
                        select: {
                            post_date: true,
                            description: true,
                        },
                    },
                },
            },
        },
    });

    if (lots.length === 0) return [];

    // Fetch lot titles from the slots table
    const lotGuids = lots.map(l => l.guid);
    const titleSlots = await prisma.slots.findMany({
        where: {
            obj_guid: { in: lotGuids },
            name: 'title',
        },
        select: {
            obj_guid: true,
            string_val: true,
        },
    });
    const titleMap = new Map(titleSlots.map(s => [s.obj_guid, s.string_val || '']));

    // Get account commodity for price lookup
    const account = await prisma.accounts.findUnique({
        where: { guid: accountGuid },
        select: { commodity_guid: true },
    });
    const commodityGuid = account?.commodity_guid || null;

    // Fetch latest price once for unrealized gain calculations
    let latestPrice: number | null = null;
    if (commodityGuid) {
        const priceData = await getLatestPrice(commodityGuid);
        latestPrice = priceData?.value ?? null;
    }

    const now = new Date();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;

    const summaries: LotSummary[] = lots.map((lot, index) => {
        const title = titleMap.get(lot.guid) || `Lot ${index + 1}`;
        const lotSplits = buildLotSplits(lot.splits);

        // Total shares = sum of all split quantities
        const computedShares = lotSplits.reduce((sum, s) => sum + s.shares, 0);
        // Treat lots with ~0 remaining shares as effectively closed
        const isClosed = lot.is_closed === 1 || (lotSplits.length > 0 && Math.abs(computedShares) < 0.0001);

        // Dates from sorted splits
        const openDate = lotSplits.length > 0 ? lotSplits[0].postDate : null;
        const closeDate = isClosed && lotSplits.length > 0
            ? lotSplits[lotSplits.length - 1].postDate
            : null;

        const totalShares = computedShares;

        // Total cost = sum of values where quantity > 0 (buys)
        const totalCost = lotSplits
            .filter(s => s.shares > 0)
            .reduce((sum, s) => sum + Math.abs(s.value), 0);

        // Realized gain: sum of ALL split values (GnuCash double-balance)
        const realizedGain = isClosed
            ? lotSplits.reduce((sum, s) => sum + s.value, 0)
            : 0;

        // Unrealized gain: (currentPrice * remaining shares) - cost basis of remaining shares
        let unrealizedGain: number | null = null;
        if (!isClosed && latestPrice !== null && Math.abs(totalShares) > 0.0001) {
            const marketValue = latestPrice * totalShares;
            unrealizedGain = marketValue - totalCost;
        }

        // Holding period based on open date
        let holdingPeriod: 'short_term' | 'long_term' | null = null;
        if (openDate) {
            const openMs = new Date(openDate).getTime();
            const elapsed = now.getTime() - openMs;
            holdingPeriod = elapsed > oneYearMs ? 'long_term' : 'short_term';
        }

        return {
            guid: lot.guid,
            accountGuid: lot.account_guid || accountGuid,
            isClosed,
            title,
            openDate,
            closeDate,
            totalShares,
            totalCost,
            realizedGain,
            unrealizedGain,
            holdingPeriod,
            currentPrice: latestPrice,
            splits: lotSplits,
        };
    });

    // Sort: open lots first, then by open date descending
    summaries.sort((a, b) => {
        if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
        const dateA = a.openDate ? new Date(a.openDate).getTime() : 0;
        const dateB = b.openDate ? new Date(b.openDate).getTime() : 0;
        return dateB - dateA;
    });

    return summaries;
}

/**
 * Get splits for an account that are NOT assigned to any lot (free splits).
 */
export async function getFreeSplits(accountGuid: string): Promise<LotSplit[]> {
    const splits = await prisma.splits.findMany({
        where: {
            account_guid: accountGuid,
            lot_guid: null,
        },
        include: {
            transaction: {
                select: {
                    post_date: true,
                    description: true,
                },
            },
        },
    });

    return buildLotSplits(splits);
}
