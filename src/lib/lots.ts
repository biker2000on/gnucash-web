/**
 * Lot Service
 *
 * Provides functions for querying GnuCash lots and computing
 * summaries including realized/unrealized gains, holding periods,
 * and per-lot split details.
 *
 * BROKERAGE COMMISSIONS: GnuCash records a trade commission as a separate
 * EXPENSE split of the trade transaction, so a lot's own splits cannot see it.
 * Basis and proceeds derived purely from lot splits are therefore GROSS of
 * every commission — which is exactly how this module reported them until the
 * Form 8949 path (@/lib/reports/capital-gains) started applying the IRS
 * treatment, leaving the two reports disagreeing about the same sale by the
 * commission. `includeTradeFees` recovers the fees through the SAME allocator
 * the 8949 path uses (@/lib/trade-fees) so the figures agree split for split:
 * a classified fee is ALWAYS capitalized into basis / netted off proceeds and
 * NEVER deducted, and anything not confidently classified changes nothing and
 * is reported as a warning.
 *
 * That netting is the DEFAULT for BOTH entry points — gross money figures are
 * a bug on every surface that shows them, so reaching them takes an explicit
 * `{ includeTradeFees: false }`. The two used to disagree (single netted,
 * batch gross), which meant switching a caller from one to the other for
 * performance silently changed its numbers. The one caller that genuinely
 * wants raw lots — the Form 8949 path in @/lib/reports/capital-gains, which
 * runs its own allocation with tax mappings — now says so explicitly.
 */

import prisma from './prisma';
import { toDecimalNumber } from './gnucash';
import { getLatestPrice } from './commodities';
import { isLongTerm } from './reports/capital-gains';
import { loadTradeFees, NO_TRADE_FEES, type TradeFeeBySplit } from './trade-fees';
import { isOwnAccountCommodityTransfer } from './account-transfer';
import { AVG_COST_BASIS_SLOT, AVG_BASIS_REMAINING_SLOT } from './lot-scrub';
import { DEFAULT_QTY_EPSILON } from './tolerances';

export interface LotSplit {
    guid: string;
    txGuid: string;
    postDate: string;
    description: string;
    shares: number;          // quantity_decimal
    value: number;           // value_decimal (in transaction currency)
    shareBalance: number;    // running balance of shares within the lot
    /**
     * AVERAGE-COST basis of the shares this split disposed of, as priced by
     * the average-cost replay at the split's own date (`avg_cost_basis` slot,
     * see @/lib/lot-scrub). Present only on disposal splits of an account
     * scrubbed under the average-basis election, and already fee-inclusive on
     * the buy side. When present it REPLACES the lot's pro-rata buy cost as
     * the basis of those shares; when absent every reader keeps its existing
     * per-lot behaviour, so FIFO/LIFO books are untouched.
     */
    avgCostBasis?: number;
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
     * `carried_basis` lot slot. A same-commodity own-account transfer's
     * recorded value is not a new purchase, so the transferred shares'
     * original basis lives here (written by the lot-scrub transfer linking).
     * 0 when absent.
     */
    carriedBasis: number;
    /**
     * Pooled cost basis of the shares this lot STILL HOLDS, from the
     * `avg_cost_basis_remaining` lot slot. Non-null only for an open lot in an
     * account scrubbed under the average-basis election. Under pooling a lot's
     * own purchase price stops describing its remaining shares as soon as a
     * later buy re-averages the pool, so this — not `totalCost` pro-rated — is
     * what `unrealizedGain` is measured against.
     */
    averageBasisRemaining?: number | null;
    /** Transfer-in split GUIDs whose recorded values were replaced by carriedBasis. */
    transferInSplitGuids?: string[];
    /**
     * Classified brokerage commissions/fees from the lot's trade transactions
     * that were folded into `totalCost` (buy side) and `realizedGain` (both
     * sides). 0 unless the caller asked for `includeTradeFees`, and 0 for any
     * charge the allocator refused to classify. Reported so a report can
     * explain the difference between the book's raw split values and the
     * figures shown.
     */
    tradeFees?: number;
    splits: LotSplit[];
}

/** Options for the lot loaders. */
export interface LotQueryOptions {
    /**
     * Fold classified brokerage commissions/fees into `totalCost`,
     * `realizedGain` and `unrealizedGain`, matching Form 8949 (see
     * @/lib/reports/capital-gains).
     *
     * DEFAULTS TO TRUE in `getAccountLots`: a gain reported gross of the
     * commission that produced it disagrees with Form 8949, the Investment
     * Lots report and the ledger, and every caller of `getAccountLots`
     * reports money. It costs one extra batched query over the trade
     * transactions' sibling splits.
     *
     * Pass `false` only when the caller genuinely wants GROSS figures — the
     * batch entry point `getLotsForAccounts` still defaults to false because
     * the 8949 path runs its own allocation over the raw lots.
     */
    includeTradeFees?: boolean;
    /**
     * Account GUID -> full account path ("Expenses:Investments:Commissions"),
     * as built by buildAccountPathMap. Fee classification reads the PATH — the
     * 8949 path passes the same map, and passing anything less (or nothing,
     * which falls back to the bare account name) can classify a charge
     * differently there than here, which is the disagreement this option
     * exists to remove.
     */
    accountPaths?: ReadonlyMap<string, string>;
    /**
     * Sink for the allocator's warnings — charges deliberately NOT capitalized
     * because they could not be classified confidently. A refusal is silent
     * under-reporting unless it reaches the user, so a caller that displays
     * money should pass this and surface it.
     */
    feeWarnings?: string[];
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
    }>,
    avgCostBasisBySplit: ReadonlyMap<string, number> = new Map(),
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
        const avgCostBasis = avgCostBasisBySplit.get(split.guid);
        return {
            guid: split.guid,
            txGuid: split.tx_guid,
            postDate: split.transaction?.post_date?.toISOString() || '',
            description: split.transaction?.description || '',
            shares,
            value: toDecimalNumber(split.value_num, split.value_denom),
            shareBalance,
            ...(avgCostBasis !== undefined ? { avgCostBasis } : {}),
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
 *
 * `fees` supplies the brokerage commission attributable to each split, keyed by
 * split GUID, as recovered from the trade's sibling EXPENSE splits by
 * @/lib/trade-fees. The IRS treatment (Pub. 550) is a single rule under
 * GnuCash's native signs: a fee ALWAYS moves the split's value toward the
 * positive — a buy-side fee is capitalized into basis, a sell-side fee reduces
 * the amount realized — so either way it shrinks the gain by its own amount.
 * A fee is never deducted, and a charge the allocator did not classify is
 * simply absent from the map and changes nothing. Omit `fees` (existing
 * callers, pure tests) and the gain is gross, exactly as before.
 *
 * AVERAGE COST: when a disposal split carries `avgCostBasis`, that number IS
 * the basis of the shares it disposed of — the pooled average as of that
 * sale's own date — and neither the lot's buy values nor `carriedBasis` may be
 * used, because both are already inside the pool that produced it. Buy-side
 * commissions are likewise already capitalized into the pooled figure, so only
 * SELL-side fees are applied here (they reduce the amount realized, per
 * Pub. 550). The branch engages only when EVERY disposal in the lot is priced
 * that way; a half-priced lot stays on the legacy path rather than mixing two
 * bases into one number.
 */
export function computeRealizedGain(
    splits: Array<{ guid?: string; shares: number; value: number; avgCostBasis?: number }>,
    isClosed: boolean,
    carriedBasis = 0,
    transferInSplitGuids: ReadonlySet<string> = new Set(),
    fees: TradeFeeBySplit = NO_TRADE_FEES,
): number {
    const EPS = DEFAULT_QTY_EPSILON;
    const feeOf = (split: { guid?: string }) => (split.guid ? fees.get(split.guid) ?? 0 : 0);

    const disposals = splits.filter(s => s.shares < -EPS);
    if (disposals.length > 0 && disposals.every(s => s.avgCostBasis !== undefined)) {
        return disposals.reduce(
            (gain, s) => gain + (-s.value - feeOf(s)) - (s.avgCostBasis ?? 0),
            0,
        );
    }
    // A confirmed same-commodity own-account transfer-in is bookkeeping, not
    // an acquisition: its true basis is the separately stored carried_basis.
    const basisValue = (split: { guid?: string; shares: number; value: number }) =>
        split.shares > EPS && transferInSplitGuids.has(split.guid ?? '') ? 0 : split.value;
    if (isClosed) {
        // Exclude zero-quantity gains offset splits, negate basis - proceeds
        const traded = splits.filter(s => Math.abs(s.shares) > EPS);
        return -traded.reduce((sum, s) => sum + basisValue(s), 0)
            - carriedBasis
            - traded.reduce((sum, s) => sum + feeOf(s), 0);
    }

    // Open lot: realized portion only (shares sold so far)
    const buys = splits.filter(s => s.shares > EPS);
    const sells = splits.filter(s => s.shares < -EPS);
    if (sells.length === 0) return 0;

    const boughtShares = buys.reduce((sum, s) => sum + s.shares, 0);
    // Buy-side fees join the basis pool before it is pro-rated, so the sold
    // shares carry their share of the commission and the shares still held
    // keep the rest (see totalCost / unrealizedGain below).
    const buyCost = buys.reduce((sum, s) => sum + Math.abs(basisValue(s)) + feeOf(s), 0) + carriedBasis;
    const costPerShare = boughtShares > EPS ? buyCost / boughtShares : 0;

    const soldShares = sells.reduce((sum, s) => sum + Math.abs(s.shares), 0);
    // Native: sell values are negative, so proceeds = -(sum of sell values)
    const proceeds = -sells.reduce((sum, s) => sum + s.value + feeOf(s), 0);

    return proceeds - soldShares * costPerShare;
}

/**
 * Cost basis attributable to the shares a lot STILL HOLDS.
 *
 * The canonical implementation, shared by everything that values open
 * holdings (the unrealized-gain math below, the Investment Lots report and the
 * sell planner) so the same lot cannot be priced two ways.
 *
 * Under the average-basis election the lot records that basis directly — the
 * pool re-prices every open share on each purchase, so pro-rating a lot's own
 * total cost would re-derive the per-lot figure the election discarded, and
 * would be wrong by however much the pool average moved between disposals.
 * Otherwise the basis pool is pro-rated over the shares bought, so a
 * partially-sold lot does not count the sold shares' basis twice.
 */
export function remainingCostBasis(
    lot: Pick<LotSummary, 'averageBasisRemaining' | 'splits' | 'totalShares' | 'totalCost'>,
): number {
    if (lot.averageBasisRemaining !== null && lot.averageBasisRemaining !== undefined) {
        return lot.averageBasisRemaining;
    }
    const boughtShares = lot.splits
        .filter(s => s.shares > 0)
        .reduce((sum, s) => sum + s.shares, 0);
    return boughtShares > DEFAULT_QTY_EPSILON
        ? lot.totalCost * (lot.totalShares / boughtShares)
        : lot.totalCost;
}

/**
 * Get all lots for an account with computed summaries.
 * Lots are sorted with open lots first, then by open date descending.
 *
 * Basis, realized gain and unrealized gain are NET of classified brokerage
 * commissions by default (`includeTradeFees` defaults to true here), which is
 * the treatment Form 8949, the Investment Lots report and the ledger all use.
 * Pass `{ includeTradeFees: false }` for deliberately gross figures.
 *
 * Callers that display money should also pass `accountPaths` (fee
 * classification reads the FULL account path; without it the allocator falls
 * back to the bare account name and can classify a charge differently than
 * the 8949 path does) and a `feeWarnings` sink to surface charges the
 * allocator refused to capitalize.
 */
export async function getAccountLots(
    accountGuid: string,
    options: LotQueryOptions = {},
): Promise<LotSummary[]> {
    return (await getLotsForAccounts([accountGuid], options)).get(accountGuid) ?? [];
}

/**
 * Batch-load lot summaries for multiple investment accounts. The report paths
 * call this once so lots, metadata slots, and account commodities are loaded
 * in set-based queries instead of repeating the same query group per account.
 *
 * Fee netting defaults ON here, exactly as in {@link getAccountLots}: the two
 * entry points must not disagree, or moving a caller onto the batch one for
 * performance quietly changes the money it reports.
 */
export async function getLotsForAccounts(
    accountGuids: string[],
    options: LotQueryOptions = {},
): Promise<Map<string, LotSummary[]>> {
    // `?? true` rather than spread order, so an explicit `undefined` from a
    // caller building options dynamically still gets the netted default.
    const includeTradeFees = options.includeTradeFees ?? true;
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
                            splits: {
                                select: {
                                    account_guid: true,
                                    quantity_num: true,
                                    quantity_denom: true,
                                    account: { select: { commodity_guid: true, account_type: true } },
                                },
                            },
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
            name: {
                in: [
                    'title', 'source_lot_guid', 'acquisition_date', 'carried_basis',
                    AVG_BASIS_REMAINING_SLOT,
                ],
            },
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

    // Per-disposal average-cost basis, written by the average-cost replay in
    // @/lib/lot-assignment. One batched query for every lot split in scope;
    // absent for FIFO/LIFO books, which then behave exactly as before.
    const allLotSplitGuids = lots.flatMap(lot => lot.splits.map(split => split.guid));
    const avgBasisSlots = allLotSplitGuids.length > 0
        ? await prisma.slots.findMany({
            where: { obj_guid: { in: allLotSplitGuids }, name: AVG_COST_BASIS_SLOT },
            select: { obj_guid: true, string_val: true },
        })
        : [];
    const avgCostBasisBySplit = new Map<string, number>();
    for (const slot of avgBasisSlots) {
        const parsed = slot.string_val ? parseFloat(slot.string_val) : NaN;
        if (Number.isFinite(parsed)) avgCostBasisBySplit.set(slot.obj_guid, parsed);
    }

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

    // Brokerage commissions live on sibling EXPENSE splits of the trade
    // transactions, which the lot query above never loads. Recover them ONCE
    // for every transaction touching these lots, through the same allocator the
    // Form 8949 path uses, so both reports charge the identical amount to the
    // identical split. Allocation is per-TRANSACTION (a ticket's fee is shared
    // across that ticket's security splits by value, so a sell scrubbed into
    // one split per lot is charged the fee once in total, not once per lot),
    // which is what makes the per-split amount independent of which lots each
    // report happened to ask for.
    //
    // Tax mappings are deliberately not passed: they only select which
    // neutralized-mapping warnings the allocator emits and never change an
    // amount, so omitting them cannot move a figure away from the 8949's.
    let fees: TradeFeeBySplit = NO_TRADE_FEES;
    if (includeTradeFees) {
        const allocation = await loadTradeFees(
            lots.flatMap(lot => lot.splits.map(split => split.tx_guid)),
            { accountPaths: options.accountPaths },
        );
        fees = allocation.fees;
        options.feeWarnings?.push(...allocation.warnings);
    }

    const nowIso = new Date().toISOString();
    const lotNumberByAccount = new Map<string, number>();

    for (const lot of lots) {
        const accountGuid = lot.account_guid || '';
        const index = lotNumberByAccount.get(accountGuid) ?? 0;
        lotNumberByAccount.set(accountGuid, index + 1);
        const title = slotValue.get(`${lot.guid}:title`) || `Lot ${index + 1}`;
        const lotSplits = buildLotSplits(lot.splits, avgCostBasisBySplit);
        const sourceLotGuid = slotValue.get(`${lot.guid}:source_lot_guid`) || null;
        const carriedRaw = slotValue.get(`${lot.guid}:carried_basis`);
        const carriedParsed = carriedRaw ? parseFloat(carriedRaw) : NaN;
        const carriedBasis = Number.isFinite(carriedParsed) ? carriedParsed : 0;
        const remainingRaw = slotValue.get(`${lot.guid}:${AVG_BASIS_REMAINING_SLOT}`);
        const remainingParsed = remainingRaw ? parseFloat(remainingRaw) : NaN;
        const averageBasisRemaining = Number.isFinite(remainingParsed) ? remainingParsed : null;
        // An average-cost lot is one the pooled replay priced: it either still
        // holds shares at the pool average or has already disposed of some at
        // it. Either marker is enough — a fully-sold lot has no remaining
        // basis, and a lot that has never sold has no disposal basis.
        const isAverageCostLot =
            averageBasisRemaining !== null
            || lotSplits.some(split => split.avgCostBasis !== undefined);
        const commodityGuid = commodityByAccount.get(accountGuid) ?? null;
        const latestPrice = commodityGuid
            ? (latestPriceByCommodity.get(commodityGuid) ?? null)
            : null;
        // Same-commodity shares sent to another non-TRADING account are an
        // in-kind transfer, not a disposition. This is the transfer evidence
        // used by the scrubber and wash-sale detector; value alone is not
        // enough because a zero-value write-off is a real loss.
        const transferOutSplitGuids = new Set(lot.splits
            .filter(split => isOwnAccountCommodityTransfer(split, commodityGuid, 'out'))
            .map(split => split.guid));
        // A source_lot_guid means this lot was created for an own-account
        // transfer. Confirm the positive split has the matching
        // same-commodity, non-TRADING negative counterpart before excluding
        // its recorded value from basis; genuine later buys remain purchases.
        const transferInSplitGuids = new Set(lot.splits
            .filter(split => carriedBasis > 0 && isOwnAccountCommodityTransfer(split, commodityGuid, 'in'))
            .map(split => split.guid));

        // Total shares = sum of all split quantities
        const computedShares = lotSplits.reduce((sum, s) => sum + s.shares, 0);
        // Treat lots with ~0 remaining shares as effectively closed
        const isClosed = lot.is_closed === 1 || (lotSplits.length > 0 && Math.abs(computedShares) < DEFAULT_QTY_EPSILON);

        // Dates from sorted splits
        const openDate = lotSplits.length > 0 ? lotSplits[0].postDate : null;
        const closeDate = isClosed && lotSplits.length > 0
            ? lotSplits[lotSplits.length - 1].postDate
            : null;

        const totalShares = computedShares;

        // Total cost = sum of values where quantity > 0 (buys), plus the
        // commissions paid to acquire them: a buy-side fee is part of what the
        // shares cost, so it belongs in basis (and therefore in the
        // unrealized-gain and remaining-basis math derived from it below).
        const tradeFees = lotSplits.reduce((sum, s) => sum + (fees.get(s.guid) ?? 0), 0);
        // Under the average-basis election the lot's basis is what the POOL
        // assigned it, not what this lot's own buys cost: the basis still held
        // plus the basis already disposed of (sold or transferred out). Both
        // components are fee-inclusive, so buy-side commissions must not be
        // added again here.
        const totalCost = isAverageCostLot
            ? (averageBasisRemaining ?? 0)
                + lotSplits.reduce((sum, s) => sum + (s.avgCostBasis ?? 0), 0)
            : lotSplits
                .filter(s => s.shares > 0)
                .reduce((sum, s) => sum
                    + (transferInSplitGuids.has(s.guid) ? 0 : Math.abs(s.value))
                    + (fees.get(s.guid) ?? 0), 0) + carriedBasis;

        // Exclude transfer-outs, split by split, before computing gain. A
        // transfer can coexist with an actual sale in the same lot; suppressing
        // the entire lot would erase that real disposition. The remaining
        // shares are deliberately treated as open for the pro-rata basis math.
        const taxableLotSplits = lotSplits.filter(split => !transferOutSplitGuids.has(split.guid));
        const taxableShares = taxableLotSplits.reduce((sum, split) => sum + split.shares, 0);
        const taxableLotIsClosed = Math.abs(taxableShares) < DEFAULT_QTY_EPSILON;
        const realizedGain = computeRealizedGain(
            taxableLotSplits,
            taxableLotIsClosed,
            carriedBasis,
            transferInSplitGuids,
            fees,
        );

        // Unrealized gain: (currentPrice * remaining shares) - cost basis of remaining shares
        let unrealizedGain: number | null = null;
        if (!isClosed && latestPrice !== null && Math.abs(totalShares) > DEFAULT_QTY_EPSILON) {
            const marketValue = latestPrice * totalShares;
            unrealizedGain = marketValue - remainingCostBasis({
                averageBasisRemaining, splits: lotSplits, totalShares, totalCost,
            });
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
            sourceLotGuid,
            acquisitionDate,
            carriedBasis,
            averageBasisRemaining,
            transferInSplitGuids: [...transferInSplitGuids],
            tradeFees,
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
