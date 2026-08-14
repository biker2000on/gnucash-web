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
import { readCarriedBasis } from './lot-scrub';

export type CostBasisMethod = 'fifo' | 'lifo' | 'average';

/** Share-count tolerance, matching the epsilon used elsewhere in the lot code. */
const QTY_EPS = 0.0001;

interface PurchaseLot {
  date: Date;
  shares: number;
  costPerShare: number;
  totalCost: number;
  /**
   * True when this parcel arrived as a transfer-in whose original basis could
   * not be established (source history not in this book). Its costPerShare is
   * 0, but that 0 is a GAP, not a fact — see unknownBasisShares.
   */
  unknownBasis?: boolean;
}

export interface CostBasisResult {
  totalCost: number;
  perShareCost: number;
  method: CostBasisMethod;
  tracedFromAccount?: string; // Source account name if traced
  /**
   * Of the shares this result covers, how many have NO establishable basis
   * (in-kind transfers whose source lot is not in this book, or predates the
   * data). Never silently folded in at $0 without also being counted here.
   */
  unknownBasisShares?: number;
  /**
   * Plain-English notes naming the shares above, following the valuation-gap
   * precedent in account-valuation.ts ("<label> excluded: <reason>") — a gap is
   * reported out loud rather than presented as a real zero.
   */
  warnings?: string[];
}

/** Merge child-trace warnings into an accumulator without duplicates. */
function collectWarnings(into: string[], from?: string[]): void {
  if (!from) return;
  for (const w of from) if (!into.includes(w)) into.push(w);
}

/** ISO date (YYYY-MM-DD) used to NAME the shares in a warning. */
function dateLabel(date: Date | null | undefined): string {
  return date ? date.toISOString().slice(0, 10) : 'an unknown date';
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
  const qty = toDecimalNumber(split.quantity_num, split.quantity_denom);
  if (qty <= 0) return false; // Only care about receiving shares

  // Check if there's a matching split sending shares from another account
  // with the same commodity (prevents false positives on cash splits).
  // IMPORTANT: Exclude Trading account splits — GnuCash trading accounts
  // create same-commodity splits for purchases that would falsely match.
  const matchingSend = allSplits.find(s =>
    s.account_guid !== split.account_guid &&
    s.account?.commodity_guid === accountCommodityGuid &&
    s.account?.account_type !== 'TRADING' &&
    toDecimalNumber(s.quantity_num, s.quantity_denom) < 0
  );

  return !!matchingSend;
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
 */
export async function traceCostBasis(
  transferInSplitGuid: string,
  method: CostBasisMethod,
  commodityGuid: string,
  transferredShares: number,
  cache: CostBasisCache,
): Promise<CostBasisResult> {
  const internalCache = cache as unknown as InternalCache;
  const cacheKey = `${transferInSplitGuid}-${method}`;
  const cached = internalCache.get(cacheKey);

  // If we have a real result, return it
  if (cached && cached !== IN_PROGRESS) {
    return cached as CostBasisResult;
  }

  // If this split is already being traced (circular transfer chain), return $0
  // This is the ONLY case where we return zero for circular detection
  if (cached === IN_PROGRESS) {
    return { totalCost: 0, perShareCost: 0, method };
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
    const result: CostBasisResult = { totalCost: 0, perShareCost: 0, method };
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
        const result: CostBasisResult = {
          totalCost: perShareCost * transferredShares,
          perShareCost,
          method,
        };
        internalCache.set(cacheKey, result);
        return result;
      }
    }

    // Only use the lot's own purchases when it actually contains some;
    // otherwise fall through to transfer-chain tracing below.
    if (totalShares > QTY_EPS) {
      const result: CostBasisResult = {
        totalCost: (totalCost / totalShares) * transferredShares,
        perShareCost: totalCost / totalShares,
        method,
      };
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
    // No traceable source — this is a legitimate zero cost (e.g., a gift, airdrop, etc.)
    // NOT a circular detection case — store a real result
    const result: CostBasisResult = { totalCost: 0, perShareCost: 0, method };
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
 */
async function getAccountCostBasis(
  accountGuid: string,
  commodityGuid: string,
  method: CostBasisMethod,
  sharesNeeded: number,
  asOfDate: Date,
  cache: CostBasisCache,
  excludeTxGuid?: string,
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
    return calculateAverageCostBasis(sortedSplits, sharesNeeded, accountGuid, commodityGuid, cache);
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
        const traced = await traceCostBasis(split.guid, method, commodityGuid, qty, cache);
        collectWarnings(warnings, traced.warnings);
        const unknownBasis = !(traced.totalCost > 0);
        if (unknownBasis) {
          // Unlike the average pool, a FIFO/LIFO parcel cannot simply be
          // dropped: lots are individually identified and consumed in date
          // order, so removing one would shift which lot every later sale
          // eats and corrupt the basis of the KNOWN parcels too. It stays in
          // the queue at $0 — but is counted and named, never silent.
          warnings.push(
            `${qty} share(s) transferred in on ${dateLabel(split.transaction?.post_date)} admitted at $0 basis: no traceable cost basis in this book.`,
          );
        }
        lots.push({
          date: split.transaction?.post_date || new Date(),
          shares: qty,
          costPerShare: traced.perShareCost,
          totalCost: traced.totalCost,
          unknownBasis,
        });
      } else {
        // Direct purchase
        lots.push({
          date: split.transaction?.post_date || new Date(),
          shares: qty,
          costPerShare: qty > 0 ? val / qty : 0,
          totalCost: val,
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
        lot.totalCost -= soldFromLot * lot.costPerShare;
        soldRemaining -= soldFromLot;
      }
    }
  }

  // Allocate cost basis to the requested shares, in the same order a sale
  // would consume them.
  let remainingShares = sharesNeeded;
  let totalCost = 0;
  let unknownBasisShares = 0;

  for (const lot of consumptionOrder(lots, method)) {
    if (remainingShares <= 0 || lot.shares <= 0) continue;
    const allocated = Math.min(lot.shares, remainingShares);
    totalCost += allocated * lot.costPerShare;
    if (lot.unknownBasis) unknownBasisShares += allocated;
    remainingShares -= allocated;
  }

  return {
    totalCost,
    perShareCost: sharesNeeded > 0 ? totalCost / sharesNeeded : 0,
    method,
    ...(unknownBasisShares > 0 ? { unknownBasisShares } : {}),
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
 * not in this book, or predates the data), those shares are EXCLUDED from the
 * pool — numerator and denominator both — and named in `warnings`, following
 * the same "exclude and say so, never present a gap as a real zero" rule that
 * account-valuation.ts applies to unpriceable holdings. Shares are fungible
 * under the average method, so one un-basised share would otherwise
 * contaminate the reported basis of every other share in the pool.
 */
async function calculateAverageCostBasis(
  splits: Awaited<ReturnType<typeof fetchAccountSplits>>,
  sharesNeeded: number,
  accountGuid: string,
  commodityGuid: string,
  cache: CostBasisCache,
): Promise<CostBasisResult> {
  let knownShares = 0;
  let knownCost = 0;
  let unknownShares = 0;
  const warnings: string[] = [];

  for (const split of splits) {
    const qty = toDecimalNumber(split.quantity_num, split.quantity_denom);
    const val = Math.abs(toDecimalNumber(split.value_num, split.value_denom));

    if (qty > 0) {
      if (isTransferInSplit(split, accountGuid, commodityGuid)) {
        const traced = await traceCostBasis(split.guid, 'average', commodityGuid, qty, cache);
        collectWarnings(warnings, traced.warnings);
        if (traced.totalCost > 0) {
          knownShares += qty;
          knownCost += traced.totalCost;
        } else {
          unknownShares += qty;
          warnings.push(
            `${qty} share(s) transferred in on ${dateLabel(split.transaction?.post_date)} excluded from the average-cost pool: no traceable cost basis in this book.`,
          );
        }
      } else {
        knownShares += qty;
        knownCost += val;
      }
    } else if (qty < 0) {
      // Shares are fungible in an average-cost pool, so a sale consumes the
      // known and unknown-basis shares pro rata.
      const soldShares = Math.abs(qty);
      const poolShares = knownShares + unknownShares;
      const fromKnown = poolShares > 0 ? Math.min(knownShares, soldShares * (knownShares / poolShares)) : 0;
      const avgCost = knownShares > 0 ? knownCost / knownShares : 0;
      knownCost -= avgCost * fromKnown;
      knownShares -= fromKnown;
      unknownShares = Math.max(0, unknownShares - (soldShares - fromKnown));
    }
  }

  const perShareCost = knownShares > 0 ? knownCost / knownShares : 0;
  const poolShares = knownShares + unknownShares;
  // The requested shares are drawn fungibly from the pool, so the unknown
  // fraction of the pool is the unknown fraction of the request.
  const unknownBasisShares = poolShares > 0
    ? Math.min(sharesNeeded, sharesNeeded * (unknownShares / poolShares))
    : 0;

  return {
    // Basis is reported for the shares that HAVE one; the rest are counted in
    // unknownBasisShares instead of being handed an invented per-share cost.
    totalCost: perShareCost * (sharesNeeded - unknownBasisShares),
    perShareCost,
    method: 'average',
    ...(unknownBasisShares > QTY_EPS ? { unknownBasisShares } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
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
  const txSplits = split.transaction?.splits || [];
  return txSplits.some(
    s => s.account_guid !== currentAccountGuid &&
         s.account?.commodity_guid === commodityGuid &&
         s.account?.account_type !== 'TRADING' &&
         toDecimalNumber(s.quantity_num, s.quantity_denom) < 0
  );
}
