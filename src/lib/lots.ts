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
): number {
    const EPS = 0.0001;
    if (isClosed) {
        // Exclude zero-quantity gains offset splits, negate basis - proceeds
        return -splits
            .filter(s => Math.abs(s.shares) > EPS)
            .reduce((sum, s) => sum + s.value, 0);
    }

    // Open lot: realized portion only (shares sold so far)
    const buys = splits.filter(s => s.shares > EPS);
    const sells = splits.filter(s => s.shares < -EPS);
    if (sells.length === 0) return 0;

    const boughtShares = buys.reduce((sum, s) => sum + s.shares, 0);
    const buyCost = buys.reduce((sum, s) => sum + Math.abs(s.value), 0);
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

    const sourceSlots = await prisma.slots.findMany({
        where: { obj_guid: { in: lotGuids }, name: 'source_lot_guid' },
        select: { obj_guid: true, string_val: true },
    });
    const sourceMap = new Map(sourceSlots.map(s => [s.obj_guid, s.string_val || null]));

    const acqDateSlots = await prisma.slots.findMany({
        where: { obj_guid: { in: lotGuids }, name: 'acquisition_date' },
        select: { obj_guid: true, string_val: true },
    });
    const acqDateMap = new Map(acqDateSlots.map(s => [s.obj_guid, s.string_val || null]));

    // carried_basis: original cost basis carried by a $0-value in-kind
    // transfer (see lot-scrub's writeCarriedBasisSlot / readCarriedBasis).
    const carriedSlots = await prisma.slots.findMany({
        where: { obj_guid: { in: lotGuids }, name: 'carried_basis' },
        select: { obj_guid: true, string_val: true },
    });
    const carriedMap = new Map(carriedSlots.map(s => {
        const parsed = s.string_val ? parseFloat(s.string_val) : NaN;
        return [s.obj_guid, Number.isFinite(parsed) ? parsed : 0] as const;
    }));

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

    const nowIso = new Date().toISOString();

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

        // Realized gain: proceeds - basis, excluding zero-qty gains offset
        // splits (native GnuCash convention; see computeRealizedGain)
        const realizedGain = computeRealizedGain(lotSplits, isClosed);

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
        const effectiveOpenDate = acqDateMap.get(lot.guid) || openDate;
        if (effectiveOpenDate) {
            const termEndDate = isClosed && closeDate ? closeDate : nowIso;
            holdingPeriod = isLongTerm(effectiveOpenDate, termEndDate) ? 'long_term' : 'short_term';
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
            sourceLotGuid: sourceMap.get(lot.guid) ?? null,
            acquisitionDate: acqDateMap.get(lot.guid) ?? null,
            carriedBasis: carriedMap.get(lot.guid) ?? 0,
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
