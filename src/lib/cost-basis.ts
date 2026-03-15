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
import { toDecimal as toDecimalString } from './gnucash';

export type CostBasisMethod = 'fifo' | 'lifo' | 'average';

interface PurchaseLot {
  date: Date;
  shares: number;
  costPerShare: number;
  totalCost: number;
}

export interface CostBasisResult {
  totalCost: number;
  perShareCost: number;
  method: CostBasisMethod;
  tracedFromAccount?: string; // Source account name if traced
}

/**
 * Convert GnuCash fraction to a number (local helper)
 */
function toDecimal(num: bigint | number | string | null, denom: bigint | number | string | null): number {
  if (num === null || denom === null) return 0;
  return parseFloat(toDecimalString(num, denom));
}

/**
 * Request-scoped cache -- pass through the call chain to avoid cross-request contamination.
 * Do NOT use a module-level singleton (persists across requests in Next.js Node runtime).
 */
export function createCostBasisCache(): Map<string, CostBasisResult> {
  return new Map();
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
  allSplits: Array<{ quantity_num: bigint; quantity_denom: bigint; account_guid: string; account?: { commodity_guid?: string | null } | null }>,
  accountCommodityGuid: string
): boolean {
  const qty = toDecimal(split.quantity_num, split.quantity_denom);
  if (qty <= 0) return false; // Only care about receiving shares

  // Check if there's a matching split sending shares from another account
  // with the same commodity (prevents false positives on cash splits)
  const matchingSend = allSplits.find(s =>
    s.account_guid !== split.account_guid &&
    s.account?.commodity_guid === accountCommodityGuid &&
    toDecimal(s.quantity_num, s.quantity_denom) < 0
  );

  return !!matchingSend;
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
  cache: Map<string, CostBasisResult>,
): Promise<CostBasisResult> {
  const cacheKey = `${transferInSplitGuid}-${method}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  // Get the transfer-in split
  // IMPORTANT: Prisma relation names are SINGULAR: `transaction`, `account` (not plural)
  const transferSplit = await prisma.splits.findUnique({
    where: { guid: transferInSplitGuid },
    include: {
      transaction: {
        include: {
          splits: {
            include: {
              account: { select: { guid: true, name: true, commodity_guid: true } },
            },
          },
        },
      },
    },
  });

  if (!transferSplit) {
    return { totalCost: 0, perShareCost: 0, method };
  }

  // Step 1: Check for lot-based tracing
  if (transferSplit.lot_guid) {
    const lotSplits = await prisma.splits.findMany({
      where: {
        lot_guid: transferSplit.lot_guid,
        guid: { not: transferInSplitGuid },
      },
      include: {
        transaction: { select: { post_date: true } },
        account: { select: { commodity_guid: true } },
      },
    });
    // Sort in JS since orderBy on nested relations may not work in all Prisma versions
    lotSplits.sort((a, b) => {
      const dateA = a.transaction?.post_date?.getTime() || 0;
      const dateB = b.transaction?.post_date?.getTime() || 0;
      return dateA - dateB;
    });

    // Sum only purchase splits (positive quantity, not transfers) from lot
    // Filter out transfer splits and sale splits to avoid double-counting
    const purchaseSplits = lotSplits.filter(s => {
      const qty = toDecimal(s.quantity_num, s.quantity_denom);
      return qty > 0; // Only count shares coming in
    });

    const totalCost = purchaseSplits.reduce((sum, s) => {
      const val = Math.abs(toDecimal(s.value_num, s.value_denom));
      return sum + val;
    }, 0);

    const totalShares = purchaseSplits.reduce((sum, s) => {
      return sum + toDecimal(s.quantity_num, s.quantity_denom);
    }, 0);

    const result: CostBasisResult = {
      totalCost: totalShares > 0 ? (totalCost / totalShares) * transferredShares : 0,
      perShareCost: totalShares > 0 ? totalCost / totalShares : 0,
      method,
    };
    cache.set(cacheKey, result);
    return result;
  }

  // Step 2: Trace transfer chain (no lots)
  // Find the source account (the split with opposite quantity in the same transaction)
  // IMPORTANT: check commodity_guid to avoid matching cash-side splits
  const sourceSplit = transferSplit.transaction?.splits.find(
    s => s.account_guid !== transferSplit.account_guid &&
         s.account?.commodity_guid === commodityGuid &&
         toDecimal(s.quantity_num, s.quantity_denom) < 0
  );

  if (!sourceSplit) {
    return { totalCost: 0, perShareCost: 0, method };
  }

  const sourceAccountGuid = sourceSplit.account_guid;

  // Step 3: Get all purchase history from source account
  const result = await getAccountCostBasis(
    sourceAccountGuid,
    commodityGuid,
    method,
    transferredShares,
    transferSplit.transaction?.post_date || new Date(),
    cache,
  );

  result.tracedFromAccount = sourceSplit.account?.name ?? undefined;
  cache.set(cacheKey, result);
  return result;
}

/**
 * Get the cost basis for a given number of shares from an account,
 * considering all purchases and prior transfers up to a given date.
 */
async function getAccountCostBasis(
  accountGuid: string,
  commodityGuid: string,
  method: CostBasisMethod,
  sharesNeeded: number,
  asOfDate: Date,
  cache: Map<string, CostBasisResult>,
): Promise<CostBasisResult> {
  // Get all splits for this account + commodity, ordered by date
  // Use singular relation names: `account`, `transaction`
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
              account: { select: { guid: true, commodity_guid: true } },
            },
          },
        },
      },
    },
  });
  // Sort in JS for reliability across Prisma versions
  splits.sort((a, b) => {
    const dateA = a.transaction?.post_date?.getTime() || 0;
    const dateB = b.transaction?.post_date?.getTime() || 0;
    return method === 'lifo' ? dateB - dateA : dateA - dateB;
  });

  if (method === 'average') {
    return calculateAverageCostBasis(splits, sharesNeeded);
  }

  // FIFO or LIFO: build purchase lots
  const lots: PurchaseLot[] = [];

  for (const split of splits) {
    const qty = toDecimal(split.quantity_num, split.quantity_denom);
    const val = Math.abs(toDecimal(split.value_num, split.value_denom));

    if (qty > 0) {
      // Purchase or transfer-in
      if (isTransferInSplit(split, accountGuid, commodityGuid)) {
        // Recursively trace this transfer
        const traced = await traceCostBasis(split.guid, method, commodityGuid, qty, cache);
        lots.push({
          date: split.transaction?.post_date || new Date(),
          shares: qty,
          costPerShare: traced.perShareCost,
          totalCost: traced.totalCost,
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
      // Sale: reduce lots using the same method
      let soldRemaining = Math.abs(qty);
      for (const lot of lots) {
        if (soldRemaining <= 0) break;
        const soldFromLot = Math.min(lot.shares, soldRemaining);
        lot.shares -= soldFromLot;
        lot.totalCost -= soldFromLot * lot.costPerShare;
        soldRemaining -= soldFromLot;
      }
    }
  }

  // Allocate cost basis to the requested shares
  let remainingShares = sharesNeeded;
  let totalCost = 0;

  for (const lot of lots) {
    if (remainingShares <= 0 || lot.shares <= 0) continue;
    const allocated = Math.min(lot.shares, remainingShares);
    totalCost += allocated * lot.costPerShare;
    remainingShares -= allocated;
  }

  return {
    totalCost,
    perShareCost: sharesNeeded > 0 ? totalCost / sharesNeeded : 0,
    method,
  };
}

function calculateAverageCostBasis(
  splits: Array<{ quantity_num: bigint; quantity_denom: bigint; value_num: bigint; value_denom: bigint }>,
  sharesNeeded: number,
): CostBasisResult {
  let totalShares = 0;
  let totalCost = 0;

  for (const split of splits) {
    const qty = toDecimal(split.quantity_num, split.quantity_denom);
    const val = Math.abs(toDecimal(split.value_num, split.value_denom));

    if (qty > 0) {
      totalShares += qty;
      totalCost += val;
    } else if (qty < 0) {
      const soldShares = Math.abs(qty);
      const avgCost = totalShares > 0 ? totalCost / totalShares : 0;
      totalCost -= avgCost * soldShares;
      totalShares -= soldShares;
    }
  }

  const perShareCost = totalShares > 0 ? totalCost / totalShares : 0;
  return {
    totalCost: perShareCost * sharesNeeded,
    perShareCost,
    method: 'average',
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
        account?: { commodity_guid?: string | null } | null;
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
         toDecimal(s.quantity_num, s.quantity_denom) < 0
  );
}
