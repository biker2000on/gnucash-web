/**
 * Cost Basis Tracing Utility
 *
 * Tracks historical cost basis across investment account transfers.
 * When shares are transferred between brokerage accounts, traces the
 * original purchase cost basis instead of showing $0.
 *
 * Supports lot-based tracing when available, with FIFO/LIFO/average fallback.
 */

import prisma from './prisma';
import { toDecimalNumber } from './gnucash';
import { isOwnAccountCommodityTransfer } from './account-transfer';
import { readCarriedBasis } from './lot-scrub';

export type CostBasisMethod = 'fifo' | 'lifo' | 'average';

/** Share-count tolerance, matching the epsilon used elsewhere in the lot code. */
const QTY_EPS = 0.0001;

/**
 * Hard bound on how many transfer hops a single trace will follow.
 *
 * Cycles are already impossible (the IN_PROGRESS sentinel is written before any
 * recursion), but a legitimately long A->B->C->... chain is valid in this data
 * model and would otherwise produce an unbounded request-time chain of queries
 * and promises. 200 matches the depth guard on this repo's recursive
 * account-ancestor CTEs (book-scope.ts:279, book-lock.ts:131,
 * inventory-engine.ts:751).
 *
 * Exhausting it does NOT throw and does NOT return a fake $0: the shares come
 * back UNCOVERED with a warning naming the reason, i.e. the same honest
 * "excluded and named" path used for any other unestablishable basis.
 */
export const MAX_TRACE_DEPTH = 200;

interface PurchaseLot {
  date: Date;
  shares: number;
  /** Basis per COVERED share of this parcel (never per raw share). */
  costPerShare: number;
  /** Fraction of this parcel's shares that have no establishable basis (0..1). */
  uncoveredFraction: number;
}

/**
 * The basis of a requested number of shares, split by COVERAGE.
 *
 * There is deliberately no `totalCost` field. A basis figure is only meaningful
 * next to the share count it covers: adding `basisOfCoveredShares` into a pool
 * while counting ALL the requested shares in the denominator is exactly the
 * defect this type exists to prevent (partial cost / full shares understates
 * basis and inflates every downstream gain). Callers that aggregate must use
 * the CostBasisPool helpers below, which keep the two numbers in step.
 *
 * Invariant: coveredShares + uncoveredShares === the shares requested.
 */
export interface CostBasisResult {
  /** Requested shares whose basis IS established. */
  coveredShares: number;
  /**
   * Requested shares whose basis is NOT establishable — an in-kind transfer
   * whose source lot is not in this book, predates the data, or sits beyond
   * MAX_TRACE_DEPTH. Always present: a caller cannot forget to look at it.
   */
  uncoveredShares: number;
  /** Cost basis of `coveredShares` ONLY — never of the whole request. */
  basisOfCoveredShares: number;
  /** basisOfCoveredShares / coveredShares; 0 when nothing is covered. */
  perShareCost: number;
  method: CostBasisMethod;
  tracedFromAccount?: string; // Source account name if traced
  /**
   * Plain-English notes naming the uncovered shares, following the
   * valuation-gap precedent in account-valuation.ts ("<label> excluded:
   * <reason>") — a gap is reported out loud, never presented as a real zero.
   */
  warnings?: string[];
}

/**
 * A running (shares, basis) pool that cannot silently upgrade coverage.
 *
 * Every aggregate consumer of traceCostBasis needs this exact arithmetic, so it
 * lives here once: mixing a partial basis with a full share count is the bug,
 * and it is only avoidable if the two counts travel together.
 */
export interface CostBasisPool {
  /** Shares in the pool that have an established basis. */
  coveredShares: number;
  /** Shares in the pool that do not. */
  uncoveredShares: number;
  /** Basis of `coveredShares` only. */
  basisOfCoveredShares: number;
  warnings: string[];
}

export function createCostBasisPool(): CostBasisPool {
  return { coveredShares: 0, uncoveredShares: 0, basisOfCoveredShares: 0, warnings: [] };
}

/** A purchase with a real price: fully covered. */
export function addPurchaseToPool(pool: CostBasisPool, shares: number, cost: number): void {
  pool.coveredShares += shares;
  pool.basisOfCoveredShares += cost;
}

/**
 * Fold a traced transfer-in into the pool, PRESERVING its coverage. The traced
 * result's own covered/uncovered split is carried through rather than the whole
 * parcel being treated as covered — otherwise a partially-covered child is
 * laundered into a fully-covered parent one hop up the chain.
 */
export function addTracedTransferToPool(pool: CostBasisPool, traced: CostBasisResult): void {
  pool.coveredShares += traced.coveredShares;
  pool.uncoveredShares += traced.uncoveredShares;
  pool.basisOfCoveredShares += traced.basisOfCoveredShares;
  collectWarnings(pool.warnings, traced.warnings);
}

/** Basis per covered share — the only per-share figure the pool can honestly state. */
export function poolPerShareCost(pool: CostBasisPool): number {
  return pool.coveredShares > 0 ? pool.basisOfCoveredShares / pool.coveredShares : 0;
}

/**
 * A sale removes shares from the pool. Shares are fungible here, so the sale
 * consumes covered and uncovered shares PRO RATA; the covered side gives up
 * basis at the covered average.
 */
export function removeSharesFromPool(pool: CostBasisPool, shares: number): void {
  const poolShares = pool.coveredShares + pool.uncoveredShares;
  if (poolShares <= 0) return;
  const sold = Math.min(shares, poolShares);
  const fromCovered = sold * (pool.coveredShares / poolShares);
  pool.basisOfCoveredShares -= poolPerShareCost(pool) * fromCovered;
  pool.coveredShares -= fromCovered;
  pool.uncoveredShares = Math.max(0, pool.uncoveredShares - (sold - fromCovered));
}

/**
 * Draw `sharesNeeded` out of the pool as a result. The draw takes covered and
 * uncovered shares pro rata; asking for more shares than the pool holds makes
 * the shortfall uncovered rather than inventing basis for it.
 */
export function drawFromPool(
  pool: CostBasisPool,
  sharesNeeded: number,
  method: CostBasisMethod,
): CostBasisResult {
  const poolShares = pool.coveredShares + pool.uncoveredShares;
  const perShareCost = poolPerShareCost(pool);
  const draw = Math.min(sharesNeeded, poolShares);
  const shortfall = Math.max(0, sharesNeeded - draw);
  const coveredShares = poolShares > 0 ? draw * (pool.coveredShares / poolShares) : 0;
  const uncoveredShares = sharesNeeded - coveredShares;
  const warnings = [...pool.warnings];
  if (shortfall > QTY_EPS) {
    collectWarnings(warnings, [
      `${round4(shortfall)} share(s) exceed the traced history available in the source account: reported without a cost basis.`,
    ]);
  }
  return {
    coveredShares,
    uncoveredShares,
    basisOfCoveredShares: perShareCost * coveredShares,
    perShareCost,
    method,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** A result covering `shares` at a known basis of `basis`. */
function covered(shares: number, basis: number, method: CostBasisMethod): CostBasisResult {
  return {
    coveredShares: shares,
    uncoveredShares: 0,
    basisOfCoveredShares: basis,
    perShareCost: shares > 0 ? basis / shares : 0,
    method,
  };
}

/** A result whose shares have NO establishable basis, with the reason named. */
function uncovered(shares: number, method: CostBasisMethod, warning: string): CostBasisResult {
  return {
    coveredShares: 0,
    uncoveredShares: shares,
    basisOfCoveredShares: 0,
    perShareCost: 0,
    method,
    warnings: [warning],
  };
}

/** Merge warnings into an accumulator without duplicates. */
function collectWarnings(into: string[], from?: string[]): void {
  if (!from) return;
  for (const w of from) if (!into.includes(w)) into.push(w);
}

/** ISO date (YYYY-MM-DD) used to NAME the shares in a warning. */
function dateLabel(date: Date | null | undefined): string {
  return date ? date.toISOString().slice(0, 10) : 'an unknown date';
}

/** Share counts in warnings are display text; keep them readable. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Request-scoped cache -- pass through the call chain to avoid cross-request contamination.
 * Do NOT use a module-level singleton (persists across requests in Next.js Node runtime).
 */
export type CostBasisCache = Map<string, CostBasisResult>;

// Sentinel symbol to mark in-progress traces (circular detection)
const IN_PROGRESS = Symbol('in-progress');
type CacheEntry = CostBasisResult | typeof IN_PROGRESS;

// Internal cache that supports both real results and in-progress markers
type InternalCache = Map<string, CacheEntry>;

export function createCostBasisCache(): CostBasisCache {
  return new Map();
}

/** Query shape shared by the per-lot lookup in traceCostBasis and the batched preload. */
const LOT_SPLIT_INCLUDE = {
  transaction: { select: { post_date: true } },
  account: { select: { commodity_guid: true } },
} as const;

type LotSplitRow = Awaited<ReturnType<typeof fetchLotSplitsForLot>>[number];

async function fetchLotSplitsForLot(lotGuid: string) {
  return prisma.splits.findMany({
    where: { lot_guid: lotGuid },
    include: LOT_SPLIT_INCLUDE,
  });
}

const lotCacheKey = (lotGuid: string) => `__lot__${lotGuid}`;

/**
 * Preload the splits of many lots in ONE query, seeding the trace cache so
 * traceCostBasis skips its per-lot `splits WHERE lot_guid = ?` lookup.
 * Purely an optimization for list callers — tracing behaves identically
 * without it.
 */
export async function preloadLotSplits(lotGuids: string[], cache: CostBasisCache): Promise<void> {
  const internalCache = cache as unknown as InternalCache;
  const unique = [...new Set(lotGuids)].filter((g) => g && !internalCache.has(lotCacheKey(g)));
  if (unique.length === 0) return;

  const rows = await prisma.splits.findMany({
    where: { lot_guid: { in: unique } },
    include: LOT_SPLIT_INCLUDE,
  });

  const byLot = new Map<string, LotSplitRow[]>();
  for (const g of unique) byLot.set(g, []);
  for (const r of rows) {
    if (r.lot_guid) byLot.get(r.lot_guid)?.push(r);
  }
  for (const [g, list] of byLot) {
    internalCache.set(lotCacheKey(g), { _splits: list } as unknown as CostBasisResult);
  }
}

/** Splits of a lot, from the cache when preloaded/previously fetched. */
async function getLotSplits(lotGuid: string, internalCache: InternalCache): Promise<LotSplitRow[]> {
  const cached = internalCache.get(lotCacheKey(lotGuid));
  if (cached && cached !== IN_PROGRESS && Array.isArray((cached as unknown as { _splits?: unknown[] })._splits)) {
    return (cached as unknown as { _splits: LotSplitRow[] })._splits;
  }
  const rows = await fetchLotSplitsForLot(lotGuid);
  internalCache.set(lotCacheKey(lotGuid), { _splits: rows } as unknown as CostBasisResult);
  return rows;
}

const carriedCacheKey = (lotGuid: string) => `__carried__${lotGuid}`;

/**
 * The cost basis carried into a transfer-destination lot, from the lot's
 * `carried_basis` slot. This is the SAME field the lot-scrub engine writes on
 * transfer linking and that lots.ts / reports/capital-gains.ts read — an
 * in-kind transfer split has no value of its own, so this slot is where the
 * transferred shares' basis actually lives. Cached per lot.
 */
async function getLotCarriedBasis(lotGuid: string, internalCache: InternalCache): Promise<number> {
  const cached = internalCache.get(carriedCacheKey(lotGuid));
  if (cached && cached !== IN_PROGRESS && typeof (cached as unknown as { _carried?: number })._carried === 'number') {
    return (cached as unknown as { _carried: number })._carried;
  }
  const carried = await readCarriedBasis(lotGuid, prisma);
  internalCache.set(carriedCacheKey(lotGuid), { _carried: carried } as unknown as CostBasisResult);
  return carried;
}

/**
 * Determine if a split represents a transfer-in (shares received with no cash exchange).
 * A transfer-in has shares (quantity != 0) but the transaction has another split
 * in a different investment account with opposite quantity for the same commodity.
 *
 * IMPORTANT: checks commodity_guid to avoid false positives on cash-side splits.
 */
export function isTransferIn(
  split: { quantity_num: bigint; quantity_denom: bigint; value_num: bigint; value_denom: bigint; account_guid: string },
  allSplits: Array<{ quantity_num: bigint; quantity_denom: bigint; account_guid: string; account?: { commodity_guid?: string | null; account_type?: string | null; name?: string | null } | null }>,
  accountCommodityGuid: string
): boolean {
  return isOwnAccountCommodityTransfer(
    { ...split, transaction: { splits: allSplits } },
    accountCommodityGuid,
    'in',
  );
}

/**
 * Fetch all splits for an account+commodity with transaction data.
 * Extracted for caching — avoids re-querying the same account in recursive traces.
 */
async function fetchAccountSplits(
  accountGuid: string,
  commodityGuid: string,
  asOfDate: Date,
) {
  const splits = await prisma.splits.findMany({
    where: {
      account_guid: accountGuid,
      account: { commodity_guid: commodityGuid },
      transaction: { post_date: { lte: asOfDate } },
    },
    include: {
      transaction: {
        select: {
          post_date: true,
          description: true,
          splits: {
            include: {
              account: { select: { guid: true, commodity_guid: true, account_type: true } },
            },
          },
        },
      },
    },
  });
  return splits;
}

/**
 * Trace the cost basis for transferred shares.
 *
 * 1. If lot_guid exists, find all splits in the same lot to derive cost
 * 2. Otherwise, trace the transfer chain to find original purchases
 * 3. Apply FIFO/LIFO/average to allocate cost across transferred shares
 *
 * @param depth - hops already followed; callers leave this at 0. Beyond
 *   MAX_TRACE_DEPTH the shares come back uncovered-and-named instead of
 *   recursing further (see MAX_TRACE_DEPTH).
 */
export async function traceCostBasis(
  transferInSplitGuid: string,
  method: CostBasisMethod,
  commodityGuid: string,
  transferredShares: number,
  cache: CostBasisCache,
  depth = 0,
): Promise<CostBasisResult> {
  const internalCache = cache as unknown as InternalCache;
  const cacheKey = `${transferInSplitGuid}-${method}`;
  const cached = internalCache.get(cacheKey);

  // If we have a real result, return it
  if (cached && cached !== IN_PROGRESS) {
    return cached as CostBasisResult;
  }

  // Depth-exhausted and circular results are NOT cached: both depend on where
  // the trace started, so caching one would poison a later, shallower trace of
  // the same split.
  if (depth >= MAX_TRACE_DEPTH) {
    return uncovered(
      transferredShares,
      method,
      `${round4(transferredShares)} share(s) reported without a cost basis: the transfer chain is deeper than ${MAX_TRACE_DEPTH} hops and was not followed further.`,
    );
  }

  // If this split is already being traced (circular transfer chain), the basis
  // cannot be established from here — uncovered, not a real zero.
  if (cached === IN_PROGRESS) {
    return uncovered(
      transferredShares,
      method,
      `${round4(transferredShares)} share(s) reported without a cost basis: the transfer chain loops back on itself.`,
    );
  }

  // Mark as in-progress for circular detection
  internalCache.set(cacheKey, IN_PROGRESS);

  // Get the transfer-in split
  // IMPORTANT: Prisma relation names are SINGULAR: `transaction`, `account` (not plural)
  const transferSplit = await prisma.splits.findUnique({
    where: { guid: transferInSplitGuid },
    include: {
      transaction: {
        include: {
          splits: {
            include: {
              account: { select: { guid: true, name: true, commodity_guid: true, account_type: true } },
            },
          },
        },
      },
    },
  });

  if (!transferSplit) {
    // The split we were asked to trace does not exist — nothing to establish.
    const result = uncovered(
      transferredShares,
      method,
      `${round4(transferredShares)} share(s) reported without a cost basis: the transfer split could not be read.`,
    );
    internalCache.set(cacheKey, result);
    return result;
  }

  // Step 1: Check for lot-based tracing (whole-lot rows come from the cache
  // when preloadLotSplits was called; the transfer split itself is excluded
  // in JS, matching the old `guid: { not: ... }` query filter)
  if (transferSplit.lot_guid) {
    const allLotSplits = await getLotSplits(transferSplit.lot_guid, internalCache);
    const lotSplits = allLotSplits.filter((s) => s.guid !== transferInSplitGuid);
    // Sort in JS since orderBy on nested relations may not work in all Prisma versions
    lotSplits.sort((a, b) => {
      const dateA = a.transaction?.post_date?.getTime() || 0;
      const dateB = b.transaction?.post_date?.getTime() || 0;
      return dateA - dateB;
    });

    // Sum only purchase splits (positive quantity, not transfers) from lot
    // Filter out transfer splits and sale splits to avoid double-counting
    const purchaseSplits = lotSplits.filter(s => {
      const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
      return qty > 0; // Only count shares coming in
    });

    const totalShares = purchaseSplits.reduce((sum, s) => {
      return sum + toDecimalNumber(s.quantity_num, s.quantity_denom);
    }, 0);

    const totalCost = purchaseSplits.reduce((sum, s) => {
      const val = Math.abs(toDecimalNumber(s.value_num, s.value_denom));
      return sum + val;
    }, 0);

    // A transfer-destination lot created by the scrub engine holds ONLY the
    // transfer-in split (excluded above) plus later sells, so it has no
    // purchase VALUE to pro-rate — the transferred shares' basis lives in the
    // lot's `carried_basis` slot instead. Spread (buy cost + carried basis)
    // over every share that entered the lot, the same formula the scrub engine
    // uses when it books gains (lot-scrub.ts generateCapitalGains).
    const carriedBasis = await getLotCarriedBasis(transferSplit.lot_guid, internalCache);
    if (carriedBasis > 0) {
      const ownShares = toDecimalNumber(transferSplit.quantity_num, transferSplit.quantity_denom);
      const incomingShares = totalShares + Math.max(0, ownShares);
      if (incomingShares > QTY_EPS) {
        const perShareCost = (totalCost + carriedBasis) / incomingShares;
        const result = covered(transferredShares, perShareCost * transferredShares, method);
        internalCache.set(cacheKey, result);
        return result;
      }
    }

    // Only use the lot's own purchases when it actually contains some;
    // otherwise fall through to transfer-chain tracing below.
    if (totalShares > QTY_EPS) {
      const result = covered(transferredShares, (totalCost / totalShares) * transferredShares, method);
      internalCache.set(cacheKey, result);
      return result;
    }
  }

  // Step 2: Trace transfer chain (no lots)
  // Find the source account (the split with opposite quantity in the same transaction)
  // IMPORTANT: check commodity_guid to avoid matching cash-side splits
  const sourceSplit = transferSplit.transaction?.splits.find(
    s => s.account_guid !== transferSplit.account_guid &&
         s.account?.commodity_guid === commodityGuid &&
         s.account?.account_type !== 'TRADING' &&
         toDecimalNumber(s.quantity_num, s.quantity_denom) < 0
  );

  if (!sourceSplit) {
    // No sending account at all — the shares did not come from anywhere with a
    // basis (gift, airdrop, ...). That $0 is a FACT, not a gap, so it is
    // reported as covered rather than as an unknown.
    const result = covered(transferredShares, 0, method);
    internalCache.set(cacheKey, result);
    return result;
  }

  const sourceAccountGuid = sourceSplit.account_guid;

  // Step 3: Get all purchase history from source account.
  // Exclude the transfer transaction itself from the replay — otherwise the
  // transfer-out split is treated as a prior sale and consumes the very
  // shares whose basis we are tracing (double-counting).
  const result = await getAccountCostBasis(
    sourceAccountGuid,
    commodityGuid,
    method,
    transferredShares,
    transferSplit.transaction?.post_date || new Date(),
    internalCache as unknown as CostBasisCache,
    transferSplit.tx_guid,
    depth,
  );

  result.tracedFromAccount = sourceSplit.account?.name ?? undefined;
  internalCache.set(cacheKey, result);
  return result;
}

/**
 * Order in which lots are consumed for a given method. `lots` is built in
 * chronological (oldest-first) order, so FIFO consumes it as-is and LIFO
 * consumes it reversed. The returned array holds the SAME lot objects, so
 * mutating them through it updates the underlying lots.
 */
function consumptionOrder(lots: PurchaseLot[], method: CostBasisMethod): PurchaseLot[] {
  return method === 'lifo' ? [...lots].reverse() : lots;
}

/**
 * Get the cost basis for a given number of shares from an account,
 * considering all purchases and prior transfers up to a given date.
 *
 * @param excludeTxGuid - Transaction to skip during replay (the transfer
 *   being traced), so its outbound splits are not counted as prior sales.
 * @param depth - hops already followed by the enclosing trace.
 */
async function getAccountCostBasis(
  accountGuid: string,
  commodityGuid: string,
  method: CostBasisMethod,
  sharesNeeded: number,
  asOfDate: Date,
  cache: CostBasisCache,
  excludeTxGuid: string | undefined,
  depth: number,
): Promise<CostBasisResult> {
  // Cache query results per account+commodity+date to avoid re-fetching
  // Use a separate namespace to avoid collision with split-level cache
  const queryCacheKey = `__acct__${accountGuid}-${commodityGuid}-${asOfDate.getTime()}`;
  const internalCache = cache as unknown as InternalCache;

  let splits: Awaited<ReturnType<typeof fetchAccountSplits>>;

  const cachedQuery = internalCache.get(queryCacheKey);
  if (cachedQuery && cachedQuery !== IN_PROGRESS && Array.isArray((cachedQuery as unknown as { _splits: unknown[] })._splits)) {
    splits = (cachedQuery as unknown as { _splits: Awaited<ReturnType<typeof fetchAccountSplits>> })._splits;
  } else {
    splits = await fetchAccountSplits(accountGuid, commodityGuid, asOfDate);
    // Store in cache with a special wrapper to distinguish from CostBasisResult
    internalCache.set(queryCacheKey, { _splits: splits } as unknown as CostBasisResult);
  }

  // Exclude the transfer transaction being traced (see excludeTxGuid docs)
  const replaySplits = excludeTxGuid
    ? splits.filter(s => s.tx_guid !== excludeTxGuid)
    : splits;

  // Sort in JS for reliability across Prisma versions.
  // ALWAYS replay chronologically ascending — a sale can only consume lots that
  // existed when it happened. FIFO vs LIFO is expressed by which END of the lot
  // array a sale (and the final allocation) consumes from, NOT by replaying the
  // history backwards.
  const sortedSplits = [...replaySplits].sort((a, b) => {
    const dateA = a.transaction?.post_date?.getTime() || 0;
    const dateB = b.transaction?.post_date?.getTime() || 0;
    return dateA - dateB;
  });

  if (method === 'average') {
    return calculateAverageCostBasis(sortedSplits, sharesNeeded, accountGuid, commodityGuid, cache, depth);
  }

  // FIFO or LIFO: build purchase lots
  const lots: PurchaseLot[] = [];
  const warnings: string[] = [];

  for (const split of sortedSplits) {
    const qty = toDecimalNumber(split.quantity_num, split.quantity_denom);
    const val = Math.abs(toDecimalNumber(split.value_num, split.value_denom));

    if (qty > 0) {
      // Purchase or transfer-in
      if (isTransferInSplit(split, accountGuid, commodityGuid)) {
        // Recursively trace this transfer — the split's own value is $0, the
        // basis is CARRIED from the source lot.
        const traced = await traceCostBasis(split.guid, method, commodityGuid, qty, cache, depth + 1);
        collectWarnings(warnings, traced.warnings);
        if (traced.uncoveredShares > QTY_EPS) {
          // Unlike the average pool, a FIFO/LIFO parcel cannot simply be
          // dropped: lots are individually identified and consumed in date
          // order, so removing one would shift which lot every later sale
          // eats and corrupt the basis of the COVERED parcels too. The
          // uncovered SHARE COUNT rides along with the parcel instead, so a
          // partially-covered transfer stays partially covered here and in
          // every result derived from it.
          warnings.push(
            `${round4(traced.uncoveredShares)} of ${round4(qty)} share(s) transferred in on ${dateLabel(split.transaction?.post_date)} have no traceable cost basis in this book.`,
          );
        }
        lots.push({
          date: split.transaction?.post_date || new Date(),
          shares: qty,
          // Per COVERED share — dividing the traced basis by the full parcel
          // would launder the uncovered shares into a fake low average.
          costPerShare: traced.coveredShares > QTY_EPS
            ? traced.basisOfCoveredShares / traced.coveredShares
            : 0,
          uncoveredFraction: qty > 0 ? Math.min(1, traced.uncoveredShares / qty) : 0,
        });
      } else {
        // Direct purchase
        lots.push({
          date: split.transaction?.post_date || new Date(),
          shares: qty,
          costPerShare: qty > 0 ? val / qty : 0,
          uncoveredFraction: 0,
        });
      }
    } else if (qty < 0) {
      // Sale: reduce lots using the same method. FIFO consumes the oldest lots
      // (front of the array); LIFO consumes the most recent (back).
      let soldRemaining = Math.abs(qty);
      for (const lot of consumptionOrder(lots, method)) {
        if (soldRemaining <= 0) break;
        const soldFromLot = Math.min(lot.shares, soldRemaining);
        lot.shares -= soldFromLot;
        soldRemaining -= soldFromLot;
      }
    }
  }

  // Allocate cost basis to the requested shares, in the same order a sale
  // would consume them. Each parcel contributes basis only for its COVERED
  // fraction; the rest is carried out as uncovered shares.
  let remainingShares = sharesNeeded;
  let coveredShares = 0;
  let uncoveredShares = 0;
  let basis = 0;

  for (const lot of consumptionOrder(lots, method)) {
    if (remainingShares <= 0 || lot.shares <= 0) continue;
    const allocated = Math.min(lot.shares, remainingShares);
    const allocatedUncovered = allocated * lot.uncoveredFraction;
    coveredShares += allocated - allocatedUncovered;
    uncoveredShares += allocatedUncovered;
    basis += (allocated - allocatedUncovered) * lot.costPerShare;
    remainingShares -= allocated;
  }

  // Shares the source account's history cannot account for at all are a gap,
  // not free shares: report them uncovered rather than silently at $0.
  if (remainingShares > QTY_EPS) {
    uncoveredShares += remainingShares;
    warnings.push(
      `${round4(remainingShares)} share(s) exceed the traced history available in the source account: reported without a cost basis.`,
    );
  }

  return {
    coveredShares,
    uncoveredShares,
    basisOfCoveredShares: basis,
    perShareCost: coveredShares > 0 ? basis / coveredShares : 0,
    method,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Average-cost pool replay.
 *
 * An in-kind transfer-in split has NO value of its own — its basis is carried
 * from the source lot. Admitting those shares at their $0 split value would
 * drag the pooled average down and inflate the gain on every later sale, so
 * each transfer-in is traced to its carried basis first.
 *
 * When the carried basis genuinely cannot be established (the source lot is
 * not in this book, predates the data, or sits beyond MAX_TRACE_DEPTH), those
 * shares are EXCLUDED from the pool — numerator and denominator both — and
 * named in `warnings`, following the same "exclude and say so, never present a
 * gap as a real zero" rule that account-valuation.ts applies to unpriceable
 * holdings. Shares are fungible under the average method, so one un-basised
 * share would otherwise contaminate the reported basis of every other share.
 *
 * Crucially, a traced transfer-in is folded in with `addTracedTransferToPool`,
 * which carries the child's covered/uncovered SPLIT through. Treating a
 * partially-covered child as fully covered would re-create the original defect
 * one hop up the chain: 100 covered + 100 uncovered shares with $5,000 of basis
 * would be reported as 200 shares at $25 instead of 100 shares at $50.
 */
async function calculateAverageCostBasis(
  splits: Awaited<ReturnType<typeof fetchAccountSplits>>,
  sharesNeeded: number,
  accountGuid: string,
  commodityGuid: string,
  cache: CostBasisCache,
  depth: number,
): Promise<CostBasisResult> {
  const pool = createCostBasisPool();

  for (const split of splits) {
    const qty = toDecimalNumber(split.quantity_num, split.quantity_denom);
    const val = Math.abs(toDecimalNumber(split.value_num, split.value_denom));

    if (qty > 0) {
      if (isTransferInSplit(split, accountGuid, commodityGuid)) {
        const traced = await traceCostBasis(split.guid, 'average', commodityGuid, qty, cache, depth + 1);
        addTracedTransferToPool(pool, traced);
        if (traced.uncoveredShares > QTY_EPS) {
          collectWarnings(pool.warnings, [
            `${round4(traced.uncoveredShares)} of ${round4(qty)} share(s) transferred in on ${dateLabel(split.transaction?.post_date)} excluded from the average-cost pool: no traceable cost basis in this book.`,
          ]);
        }
      } else {
        addPurchaseToPool(pool, qty, val);
      }
    } else if (qty < 0) {
      removeSharesFromPool(pool, Math.abs(qty));
    }
  }

  return drawFromPool(pool, sharesNeeded, 'average');
}

/**
 * Check if a split is a transfer-in by looking for a matching send split
 * in the same transaction from another account with the SAME commodity.
 * The commodity check prevents false positives on cash-side splits in buy transactions.
 */
function isTransferInSplit(
  split: {
    quantity_num: bigint;
    quantity_denom: bigint;
    transaction?: {
      splits: Array<{
        account_guid: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        account?: { guid?: string; commodity_guid?: string | null; account_type?: string | null } | null;
      }>;
    } | null;
  },
  currentAccountGuid: string,
  commodityGuid: string,
): boolean {
  return isOwnAccountCommodityTransfer(
    { ...split, account_guid: currentAccountGuid },
    commodityGuid,
    'in',
  );
}
