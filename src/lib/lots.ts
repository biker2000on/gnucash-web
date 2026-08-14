/**
 * Lot Service
 *
 * Provides functions for querying GnuCash lots and computing
 * summaries including realized/unrealized gains, holding periods,
 * and per-lot split details.
 */

import prisma from './prisma';
import { toDecimalNumber } from './gnucash';
import { getLatestPrice } from './commodities';
import { isLongTerm } from './reports/capital-gains';

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
    realizedGain: number;    // proceeds - basis (positive = gain); see computeRealizedGain
    unrealizedGain: number | null; // (currentPrice * shares) - costBasis (null if no price)
    /**
     * IRS holding term, measured acquisition -> CLOSE date for closed lots and
     * acquisition -> today for still-open lots. Uses the same "more than one
     * calendar year" rule as Form 8949 (see isLongTerm in reports/capital-gains).
     */
    holdingPeriod: 'short_term' | 'long_term' | null;
    currentPrice: number | null;
    sourceLotGuid: string | null;      // from source_lot_guid slot (transfer linking)
    acquisitionDate: string | null;     // from acquisition_date slot (original purchase date)
    /**
     * Cost basis carried into a transfer-destination lot via the
     * `carried_basis` lot slot. The $0-value in-kind transfer-in split carries
     * no value of its own, so the transferred shares' original basis lives
     * here (written by the lot-scrub transfer linking). 0 when absent.
     */
    carriedBasis: number;
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
        const shares = toDecimalNumber(split.quantity_num, split.quantity_denom);
        shareBalance += shares;
        return {
            guid: split.guid,
            txGuid: split.tx_guid,
            postDate: split.transaction?.post_date?.toISOString() || '',
            description: split.transaction?.description || '',
            shares,
            value: toDecimalNumber(split.value_num, split.value_denom),
            shareBalance,
        };
    });
}

/**
 * Compute the realized gain for a lot from its splits.
 *
 * Native GnuCash sign convention: a buy split on the stock account has
 * POSITIVE value (debit) and a sell split has NEGATIVE value (credit),
 * so summing the trading splits of a closed lot yields basis - proceeds.
 * The true realized gain is therefore the NEGATION of that sum.
 *
 * Gains offset splits (created by the scrub engine or GnuCash desktop)
 * have zero quantity and non-zero value; they record the gain inside the
 * lot so it sums to zero. They must be EXCLUDED from the basis/proceeds
 * sum — for a balanced scrubbed lot, -(sum of non-gain splits) equals the
 * value of the gains offset split itself.
 *
 * For open (partial) lots, only the realized portion is returned:
 * proceeds from shares sold so far minus their pro-rata share of the buy
 * cost. Returns 0 when nothing has been sold.
 */
export function computeRealizedGain(
    splits: Array<{ shares: number; value: number }>,
    isClosed: boolean,
    carriedBasis = 0,
): number {
    const EPS = 0.0001;
    if (isClosed) {
        // Exclude zero-quantity gains offset splits, negate basis - proceeds
        return -splits
            .filter(s => Math.abs(s.shares) > EPS)
            .reduce((sum, s) => sum + s.value, 0) - carriedBasis;
    }

    // Open lot: realized portion only (shares sold so far)
    const buys = splits.filter(s => s.shares > EPS);
    const sells = splits.filter(s => s.shares < -EPS);
    if (sells.length === 0) return 0;

    const boughtShares = buys.reduce((sum, s) => sum + s.shares, 0);
    const buyCost = buys.reduce((sum, s) => sum + Math.abs(s.value), 0) + carriedBasis;
    const costPerShare = boughtShares > EPS ? buyCost / boughtShares : 0;

    const soldShares = sells.reduce((sum, s) => sum + Math.abs(s.shares), 0);
    // Native: sell values are negative, so proceeds = -(sum of sell values)
    const proceeds = -sells.reduce((sum, s) => sum + s.value, 0);

    return proceeds - soldShares * costPerShare;
}

/**
 * Get all lots for an account with computed summaries.
 * Lots are sorted with open lots first, then by open date descending.
 */
export async function getAccountLots(accountGuid: string): Promise<LotSummary[]> {
    return (await getLotsForAccounts([accountGuid])).get(accountGuid) ?? [];
}

/**
 * Batch-load lot summaries for multiple investment accounts. The report paths
 * call this once so lots, metadata slots, and account commodities are loaded
 * in set-based queries instead of repeating the same query group per account.
 */
export async function getLotsForAccounts(accountGuids: string[]): Promise<Map<string, LotSummary[]>> {
    const uniqueAccountGuids = [...new Set(accountGuids)];
    const result = new Map(uniqueAccountGuids.map(guid => [guid, [] as LotSummary[]]));
    if (uniqueAccountGuids.length === 0) return result;

    const lots = await prisma.lots.findMany({
        where: { account_guid: { in: uniqueAccountGuids } },
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

    if (lots.length === 0) return result;

    const lotGuids = lots.map(l => l.guid);
    const metadataSlots = await prisma.slots.findMany({
        where: {
            obj_guid: { in: lotGuids },
            name: { in: ['title', 'source_lot_guid', 'acquisition_date', 'carried_basis'] },
        },
        select: {
            obj_guid: true,
            name: true,
            string_val: true,
        },
    });
    const slotValue = new Map(
        metadataSlots.map(slot => [`${slot.obj_guid}:${slot.name}`, slot.string_val]),
    );

    // Transfer destinations point back to their source lot using the metadata
    // written by the scrubber.  Read that existing linkage in reverse so a
    // source lot closed solely by a transfer-out does not look like it sold its
    // shares for $0 and therefore realized its entire basis as a loss.
    const transferDestinationSlots = await prisma.slots.findMany({
        where: {
            name: 'source_lot_guid',
            string_val: { in: lotGuids },
        },
        select: { string_val: true },
    });
    const transferOutSourceLotGuids = new Set(
        transferDestinationSlots
            .map(slot => slot.string_val)
            .filter((guid): guid is string => Boolean(guid)),
    );

    const accountRows = await prisma.accounts.findMany({
        where: { guid: { in: uniqueAccountGuids } },
        select: { guid: true, commodity_guid: true },
    });
    const commodityByAccount = new Map(accountRows.map(account => [account.guid, account.commodity_guid]));

    const commodityGuids = [...new Set(
        accountRows.map(account => account.commodity_guid).filter((guid): guid is string => Boolean(guid)),
    )];
    const latestPriceEntries = await Promise.all(commodityGuids.map(async commodityGuid => {
        const priceData = await getLatestPrice(commodityGuid);
        return [commodityGuid, priceData?.value ?? null] as const;
    }));
    const latestPriceByCommodity = new Map(latestPriceEntries);

    const nowIso = new Date().toISOString();
    const lotNumberByAccount = new Map<string, number>();

    for (const lot of lots) {
        const accountGuid = lot.account_guid || '';
        const index = lotNumberByAccount.get(accountGuid) ?? 0;
        lotNumberByAccount.set(accountGuid, index + 1);
        const title = slotValue.get(`${lot.guid}:title`) || `Lot ${index + 1}`;
        const lotSplits = buildLotSplits(lot.splits);
        const carriedRaw = slotValue.get(`${lot.guid}:carried_basis`);
        const carriedParsed = carriedRaw ? parseFloat(carriedRaw) : NaN;
        const carriedBasis = Number.isFinite(carriedParsed) ? carriedParsed : 0;
        const commodityGuid = commodityByAccount.get(accountGuid) ?? null;
        const latestPrice = commodityGuid
            ? (latestPriceByCommodity.get(commodityGuid) ?? null)
            : null;

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
            .reduce((sum, s) => sum + Math.abs(s.value), 0) + carriedBasis;

        // A lot closed by a transfer-out is not a disposition. Its basis and
        // acquisition date travel to the destination lot through the existing
        // source_lot_guid / carried_basis / acquisition_date linkage.
        // Realized gain: proceeds - basis for actual dispositions, excluding
        // zero-quantity gains offsets (see computeRealizedGain).
        const realizedGain = isClosed && transferOutSourceLotGuids.has(lot.guid)
            ? 0
            : computeRealizedGain(lotSplits, isClosed, carriedBasis);

        // Unrealized gain: (currentPrice * remaining shares) - cost basis of remaining shares
        let unrealizedGain: number | null = null;
        if (!isClosed && latestPrice !== null && Math.abs(totalShares) > 0.0001) {
            const marketValue = latestPrice * totalShares;
            // Pro-rate the buy cost over the remaining (unsold) shares so
            // partially-sold lots don't count the sold shares' basis twice.
            const boughtShares = lotSplits
                .filter(s => s.shares > 0)
                .reduce((sum, s) => sum + s.shares, 0);
            const remainingBasis = boughtShares > 0.0001
                ? totalCost * (totalShares / boughtShares)
                : totalCost;
            unrealizedGain = marketValue - remainingBasis;
        }

        // Holding period based on acquisition date (from transfer) or open date.
        // A CLOSED lot's term was fixed on its close date — measuring against
        // today would eventually reclassify every realized short-term sale as
        // long-term, which is exactly backwards for tax-harvesting decisions.
        // Only still-open lots are measured against today.
        let holdingPeriod: 'short_term' | 'long_term' | null = null;
        const acquisitionDate = slotValue.get(`${lot.guid}:acquisition_date`) || null;
        const effectiveOpenDate = acquisitionDate || openDate;
        if (effectiveOpenDate) {
            const termEndDate = isClosed && closeDate ? closeDate : nowIso;
            holdingPeriod = isLongTerm(effectiveOpenDate, termEndDate) ? 'long_term' : 'short_term';
        }

        const summary: LotSummary = {
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
            sourceLotGuid: slotValue.get(`${lot.guid}:source_lot_guid`) || null,
            acquisitionDate,
            carriedBasis,
            splits: lotSplits,
        };
        const summaries = result.get(accountGuid) ?? [];
        summaries.push(summary);
        result.set(accountGuid, summaries);
    }

    for (const summaries of result.values()) {
        summaries.sort((a, b) => {
            if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
            const dateA = a.openDate ? new Date(a.openDate).getTime() : 0;
            const dateB = b.openDate ? new Date(b.openDate).getTime() : 0;
            return dateB - dateA;
        });
    }

    return result;
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
