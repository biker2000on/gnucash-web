/**
 * Lot Scrub Engine
 *
 * Implements GnuCash-compatible scrub algorithms:
 * 1. splitSellAcrossLots — split a sell across multiple lots when it exceeds one lot's balance
 * 2. linkTransferToLot — create destination lots for share transfers with metadata linking
 * 3. generateCapitalGains — create double-balance gains transactions for closed lots
 * 4. valueZeroValueTrade — value zero-value commodity-for-commodity trades from the price DB
 * 5. assignAdjustmentToLots — scale existing lots for stock splits / reverse splits
 *
 * Also provides helpers:
 * - classifyAccountTax — determine TAX_NORMAL / TAX_DEFERRED / TAX_EXEMPT
 * - classifyHoldingPeriod — short_term vs long_term (IRS calendar-anniversary rule)
 * - qtyEpsilonForScu — commodity-aware share epsilon (crypto at 1e8 precision)
 *
 * Transfer basis carryover: when shares move between accounts, the destination
 * lot stores the transferred shares' remaining cost basis in a `carried_basis`
 * slot (a decimal string, same slots-table pattern as `acquisition_date` /
 * `source_lot_guid`). This was chosen over rewriting the transfer splits'
 * values because it leaves the user's transactions untouched and keeps the
 * revert path (restore original_* slots, delete generated slots) unchanged.
 * generateCapitalGains consumes the slot as extra basis; a transfer is NOT a
 * taxable event, so lots closed purely by transfer-out never book gains.
 */

import prisma from './prisma';
import { generateGuid, toDecimalNumber, fromDecimal, findOrCreateAccount } from './gnucash';
import { isLongTerm } from './holding-period';
import { isOwnAccountCommodityTransfer } from './account-transfer';
import { allocateTradeFees } from './trade-fees';
import {
  assertSplitsNotProtected,
  lockTransactionsForSplits,
} from './services/reconciled-split.service';

/**
 * Slot recording WHICH split a generated sub-split was carved out of.
 *
 * The revert paths need to know, per restored split, whether the rows being
 * deleted alongside it actually came from IT. Co-tagging with the same runId
 * cannot answer that: one run covers every event in an account, so a single
 * parent transaction can hold both a partitioned sale and an unrelated
 * in-place rewrite, and "some sub-split is being deleted in this transaction"
 * says nothing about any particular parent.
 *
 * Written on every sub-split at creation time; read by
 * assertRevertPreservesReconciled. It is a plain slot row — the slots table is
 * generic (obj_guid, name, slot_type, string_val), so no schema change is
 * involved, and the existing wholesale `slots.deleteMany({ obj_guid })`
 * cleanup on the revert paths removes it with its sub-split.
 *
 * Sub-splits created before this marker existed simply have no row here, so
 * their parent's restore reads as uncompensated and is BLOCKED — the required
 * fail-closed behaviour, not a silent pass.
 */
export const PARENT_SPLIT_SLOT = 'gnucash_web_parent_split';

/** Tag a generated sub-split with its run and the parent it was carved from. */
async function tagGeneratedSubSplit(
  tx: PrismaTx,
  subGuid: string,
  parentSplitGuid: string,
  runId: string,
): Promise<void> {
  await tx.slots.create({
    data: { obj_guid: subGuid, name: 'gnucash_web_generated', slot_type: 4, string_val: runId },
  });
  await tx.slots.create({
    data: { obj_guid: subGuid, name: PARENT_SPLIT_SLOT, slot_type: 4, string_val: parentSplitGuid },
  });
}

/** Prisma interactive transaction client type */
export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaxClassification = 'TAX_NORMAL' | 'TAX_DEFERRED' | 'TAX_EXEMPT';
export type HoldingPeriod = 'short_term' | 'long_term';

export interface OpenLot {
  guid: string;
  /** Remaining shares in the lot — MUTATED IN-PLACE by splitSellAcrossLots */
  shares: number;
  /**
   * Consumption-ordering date. For transferred lots this is the CARRIED
   * acquisition date (from the `acquisition_date` slot), not the transfer
   * date, so FIFO/LIFO order transferred shares by when they were originally
   * bought.
   */
  openDate: Date | null;
}

export interface ValueTradeResult {
  /** True when the trade legs now carry a non-zero value. */
  valued: boolean;
  warning?: string;
}

export interface AdjustmentResult {
  subSplitsCreated: string[];
  lotsUsed: string[];
  warning?: string;
}

export interface SplitSellResult {
  /** Sub-splits created (empty if sell fits in one lot) */
  subSplitsCreated: string[];
  /** Lots the sell was assigned to */
  lotsUsed: string[];
  /** Warning if sell exceeds all lot balances */
  warning?: string;
}

export interface LinkTransferResult {
  lotGuid: string;
  created: boolean;
}

export interface SplitTransferResult {
  lotsCreated: number;
  subSplitsCreated: number;
  lotGuids: string[];
}

export interface CapitalGainsResult {
  /** GUID of the gains transaction created, or null if skipped */
  gainsTransactionGuid: string | null;
  /** Reason for skipping, if applicable */
  skippedReason?: string;
  gainLoss: number;
  holdingPeriod: HoldingPeriod | null;
  taxClassification: TaxClassification;
}

// ---------------------------------------------------------------------------
// classifyHoldingPeriod
// ---------------------------------------------------------------------------

/**
 * Classify a holding period as short-term or long-term.
 *
 * Delegates to the shared IRS calendar-anniversary rule in
 * `@/lib/holding-period` (long-term = sold strictly AFTER the one-year
 * anniversary of acquisition). The old 365-day millisecond threshold
 * disagreed with Form 8949 on exact-anniversary sales across leap years.
 */
export function classifyHoldingPeriod(openDate: Date, closeDate: Date): HoldingPeriod {
  return isLongTerm(openDate, closeDate) ? 'long_term' : 'short_term';
}

// ---------------------------------------------------------------------------
// qtyEpsilonForScu
// ---------------------------------------------------------------------------

/** Legacy share epsilon, correct for stocks/funds at scu 100–10000. */
export const DEFAULT_QTY_EPSILON = 0.0001;

/**
 * Commodity-aware share epsilon derived from the commodity's fraction
 * (`commodity_scu`). At crypto's 1e8 precision, 0.0001 BTC is real money, so
 * the epsilon shrinks to half the smallest representable unit. It never grows
 * beyond the legacy 0.0001 so coarse-scu stocks keep their behavior.
 */
export function qtyEpsilonForScu(scu: number | bigint | null | undefined): number {
  const n = Number(scu);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QTY_EPSILON;
  return Math.min(DEFAULT_QTY_EPSILON, 0.5 / n);
}

// ---------------------------------------------------------------------------
// classifyAccountTax
// ---------------------------------------------------------------------------

/** Map an explicit retirement_account_type preference to a tax classification. */
function classifyRetirementType(type: string): TaxClassification | null {
  const t = type.toLowerCase();
  if (t === 'brokerage') return 'TAX_NORMAL';
  if (t.includes('roth') || t.startsWith('hsa') || t === 'coverdell_esa' || t === 'education_529') {
    return 'TAX_EXEMPT';
  }
  // 401k / 403b / 457 / traditional_ira / sep_ira / simple_ira / hra / fsa / ...
  return 'TAX_DEFERRED';
}

/**
 * Walk the account hierarchy upward to determine tax classification.
 *
 * The account preference system's EXPLICIT retirement flag wins when set on
 * the account or any ancestor (nearest wins): retirement_account_type maps
 * roth/hsa types to TAX_EXEMPT, brokerage to TAX_NORMAL, other retirement
 * types to TAX_DEFERRED. Only when no ancestor carries a preference does the
 * legacy name walk (IRA/401k/Roth/HSA patterns) apply:
 *
 * - TAX_EXEMPT: Roth IRA, Roth 401k, HSA
 * - TAX_DEFERRED: Traditional IRA, 401k (non-Roth), 403b, 457
 * - TAX_NORMAL: everything else
 */
export async function classifyAccountTax(
  accountGuid: string,
  tx?: PrismaTx,
): Promise<TaxClassification> {
  const db = tx || prisma;
  const names: string[] = [];
  const walkGuids: string[] = [];

  let currentGuid: string | null = accountGuid;
  // Walk up to 20 levels to avoid infinite loops
  for (let i = 0; i < 20 && currentGuid; i++) {
    const acct: { name: string; parent_guid: string | null } | null =
      await db.accounts.findUnique({
        where: { guid: currentGuid },
        select: { name: true, parent_guid: true },
      });
    if (!acct) break;
    walkGuids.push(currentGuid);
    names.push(acct.name.toLowerCase());
    currentGuid = acct.parent_guid;
  }

  // Explicit preference beats name-walking. Query defensively: the model may
  // be absent in mocked test clients or pre-migration databases.
  try {
    const prefRows: Array<{
      account_guid: string;
      is_retirement: boolean | null;
      retirement_account_type: string | null;
    }> = await (db as unknown as {
      gnucash_web_account_preferences: {
        findMany: (args: unknown) => Promise<Array<{
          account_guid: string;
          is_retirement: boolean | null;
          retirement_account_type: string | null;
        }>>;
      };
    }).gnucash_web_account_preferences.findMany({
      where: { account_guid: { in: walkGuids } },
      select: { account_guid: true, is_retirement: true, retirement_account_type: true },
    });
    const prefByGuid = new Map(prefRows.map(p => [p.account_guid, p]));
    // Nearest ancestor (self first) with a retirement flag wins.
    for (const guid of walkGuids) {
      const pref = prefByGuid.get(guid);
      if (!pref) continue;
      if (pref.is_retirement && pref.retirement_account_type) {
        const mapped = classifyRetirementType(pref.retirement_account_type);
        if (mapped) return mapped;
      }
      if (pref.is_retirement === false && pref.retirement_account_type === 'brokerage') {
        return 'TAX_NORMAL';
      }
    }
  } catch {
    // Preference model unavailable — fall through to the name walk.
  }

  const joined = names.join(' ');

  // Check for tax-exempt patterns (Roth, HSA)
  if (/\broth\b/.test(joined) || /\bhsa\b/.test(joined)) {
    return 'TAX_EXEMPT';
  }

  // Check for tax-deferred patterns (IRA, 401k, 403b, 457)
  if (/\bira\b/.test(joined) || /\b401k?\b/.test(joined) || /\b403b?\b/.test(joined) || /\b457\b/.test(joined)) {
    return 'TAX_DEFERRED';
  }

  return 'TAX_NORMAL';
}

// ---------------------------------------------------------------------------
// splitSellAcrossLots
// ---------------------------------------------------------------------------

/**
 * When a sell split exceeds a single lot's remaining shares, split it into
 * sub-splits (one per lot consumed). Creates new `splits` rows in the DB.
 *
 * Oversell (sell exceeds ALL open lot balances): matching GnuCash desktop,
 * the un-allocatable remainder stays UNASSIGNED — it becomes a sub-split with
 * `lot_guid = null`. No lot is driven negative and the original split's
 * quantity/value totals are preserved across the sub-splits, so the
 * transaction keeps balancing.
 *
 * **IMPORTANT**: Mutates `openLots[].shares` in-place to reflect consumption.
 *
 * @param sellSplitGuid - GUID of the original sell split
 * @param openLots - Open lots sorted in consumption order (FIFO/LIFO). `.shares` is mutated.
 * @param runId - Unique run identifier for tagging generated entities
 * @param tx - Prisma transaction client
 * @param qtyEpsilon - Commodity-aware share epsilon (see qtyEpsilonForScu)
 * @returns SplitSellResult with sub-splits created and lots used
 */
export async function splitSellAcrossLots(
  sellSplitGuid: string,
  openLots: OpenLot[],
  runId: string,
  tx: PrismaTx,
  qtyEpsilon: number = DEFAULT_QTY_EPSILON,
): Promise<SplitSellResult> {
  // Fetch the original sell split
  const sellSplit = await tx.splits.findUnique({
    where: { guid: sellSplitGuid },
  });
  if (!sellSplit) {
    throw new Error(`Sell split not found: ${sellSplitGuid}`);
  }

  const sellQty = toDecimalNumber(sellSplit.quantity_num, sellSplit.quantity_denom); // negative
  const sellVal = toDecimalNumber(sellSplit.value_num, sellSplit.value_denom);       // negative (credit) in native GnuCash data
  const remainingSell = Math.abs(sellQty);

  if (remainingSell < qtyEpsilon) {
    return { subSplitsCreated: [], lotsUsed: [], warning: 'Sell quantity is zero' };
  }

  // Filter lots with shares > 0
  const availableLots = openLots.filter(l => l.shares > qtyEpsilon);

  if (availableLots.length === 0) {
    return { subSplitsCreated: [], lotsUsed: [], warning: 'No open lots available' };
  }

  // Determine how many lots are needed
  interface Allocation {
    lot: OpenLot;
    shares: number;
  }
  const allocations: Allocation[] = [];
  let leftToSell = remainingSell;

  for (const lot of availableLots) {
    if (leftToSell < qtyEpsilon) break;
    const take = Math.min(lot.shares, leftToSell);
    allocations.push({ lot, shares: take });
    leftToSell -= take;
  }

  const isOversell = leftToSell > qtyEpsilon;
  const warning = isOversell
    ? `Sell of ${remainingSell} shares exceeds available lot balance by ${leftToSell.toFixed(8)} — remainder left unassigned`
    : undefined;

  // If sell fits in one lot, just assign the original split — no sub-splits needed
  if (allocations.length === 1 && !isOversell) {
    const alloc = allocations[0];
    await tx.splits.update({
      where: { guid: sellSplitGuid },
      data: { lot_guid: alloc.lot.guid },
    });
    // Mutate shares in-place
    alloc.lot.shares -= alloc.shares;
    return { subSplitsCreated: [], lotsUsed: [alloc.lot.guid] };
  }

  // Multiple lots needed — save original qty/val as slots for revert, then create sub-splits
  // Save original values
  await tx.slots.create({
    data: {
      obj_guid: sellSplitGuid,
      name: 'original_quantity_num',
      slot_type: 4,
      string_val: sellSplit.quantity_num.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: sellSplitGuid,
      name: 'original_quantity_denom',
      slot_type: 4,
      string_val: sellSplit.quantity_denom.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: sellSplitGuid,
      name: 'original_value_num',
      slot_type: 4,
      string_val: sellSplit.value_num.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: sellSplitGuid,
      name: 'original_value_denom',
      slot_type: 4,
      string_val: sellSplit.value_denom.toString(),
    },
  });
  // Tag original split
  await tx.slots.create({
    data: {
      obj_guid: sellSplitGuid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });

  const pricePerShare = Math.abs(sellVal) / remainingSell;
  // Preserve the original split's value sign. Native GnuCash sells carry a
  // NEGATIVE value (credit on the stock account); the sub-splits must too,
  // or the last (remainder) sub-split absorbs a wildly wrong value.
  const valueSign = sellVal < 0 ? -1 : 1;
  const subSplitsCreated: string[] = [];
  const lotsUsed: string[] = [];
  const qtyDenom = Number(sellSplit.quantity_denom);
  const valDenom = Number(sellSplit.value_denom);

  /** Create one tagged sub-split of the original sell. */
  const createSubSplit = async (
    subQty: { num: bigint; denom: bigint },
    subVal: { num: bigint; denom: bigint },
    lotGuid: string | null,
  ): Promise<string> => {
    const subGuid = generateGuid();
    await tx.splits.create({
      data: {
        guid: subGuid,
        tx_guid: sellSplit.tx_guid,
        account_guid: sellSplit.account_guid,
        memo: sellSplit.memo,
        action: sellSplit.action,
        reconcile_state: sellSplit.reconcile_state,
        reconcile_date: sellSplit.reconcile_date,
        value_num: subVal.num,
        value_denom: subVal.denom,
        quantity_num: subQty.num,
        quantity_denom: subQty.denom,
        lot_guid: lotGuid,
      },
    });
    await tagGeneratedSubSplit(tx, subGuid, sellSplitGuid, runId);
    subSplitsCreated.push(subGuid);
    return subGuid;
  };

  // Assign the first allocation to the original split, create sub-splits for the rest
  const firstAlloc = allocations[0];
  const firstQty = fromDecimal(-firstAlloc.shares, qtyDenom);
  const firstVal = fromDecimal(valueSign * firstAlloc.shares * pricePerShare, valDenom);

  await tx.splits.update({
    where: { guid: sellSplitGuid },
    data: {
      lot_guid: firstAlloc.lot.guid,
      quantity_num: firstQty.num,
      quantity_denom: firstQty.denom,
      value_num: firstVal.num,
      value_denom: firstVal.denom,
    },
  });
  firstAlloc.lot.shares -= firstAlloc.shares;
  lotsUsed.push(firstAlloc.lot.guid);

  let usedQtyNum = firstQty.num;
  let usedValNum = firstVal.num;

  // Create sub-splits for remaining allocations
  for (let i = 1; i < allocations.length; i++) {
    const alloc = allocations[i];
    const isLast = i === allocations.length - 1;

    let subQty: { num: bigint; denom: bigint };
    let subVal: { num: bigint; denom: bigint };

    if (isLast && !isOversell) {
      // Last sub-split gets the remainder to absorb rounding drift — but only
      // when the sell fully fits in the lots. On an oversell the excess must
      // NOT be dumped into the last lot (it would go negative); it goes to the
      // unassigned remainder split below instead.
      subQty = { num: sellSplit.quantity_num - usedQtyNum, denom: BigInt(qtyDenom) };
      subVal = { num: sellSplit.value_num - usedValNum, denom: BigInt(valDenom) };
    } else {
      subQty = fromDecimal(-alloc.shares, qtyDenom);
      subVal = fromDecimal(valueSign * alloc.shares * pricePerShare, valDenom);
    }
    usedQtyNum += subQty.num;
    usedValNum += subVal.num;

    await createSubSplit(subQty, subVal, alloc.lot.guid);
    lotsUsed.push(alloc.lot.guid);
    alloc.lot.shares -= alloc.shares;
  }

  // Oversell: the un-allocatable excess becomes an UNASSIGNED sub-split
  // (lot_guid null), exactly like GnuCash desktop leaves the remainder split
  // outside any lot. Quantity/value totals across the original split and all
  // sub-splits still equal the user's original amounts.
  if (isOversell) {
    const remainderQty = { num: sellSplit.quantity_num - usedQtyNum, denom: BigInt(qtyDenom) };
    const remainderVal = { num: sellSplit.value_num - usedValNum, denom: BigInt(valDenom) };
    await createSubSplit(remainderQty, remainderVal, null);
  }

  // Assert transaction balance == 0
  const allTxSplits = await tx.splits.findMany({
    where: { tx_guid: sellSplit.tx_guid },
  });
  const totalValue = allTxSplits.reduce(
    (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom),
    0,
  );
  if (Math.abs(totalValue) > 0.01) {
    throw new Error(
      `Transaction balance invariant violated after split: ${totalValue.toFixed(4)} (tx: ${sellSplit.tx_guid})`,
    );
  }

  return { subSplitsCreated, lotsUsed, warning };
}

// ---------------------------------------------------------------------------
// Carried basis (transfer basis carryover)
// ---------------------------------------------------------------------------

/**
 * Read a lot's `carried_basis` slot (decimal string). Returns 0 when absent.
 * The slot stores the original cost basis carried into a transfer-destination
 * lot, regardless of the transfer transaction's recorded value.
 */
export async function readCarriedBasis(lotGuid: string, tx: PrismaTx): Promise<number> {
  const slot = await tx.slots.findFirst({
    where: { obj_guid: lotGuid, name: 'carried_basis' },
    select: { string_val: true },
  });
  const parsed = slot?.string_val ? parseFloat(slot.string_val) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Compute the cost basis carried by `transferredShares` leaving a source lot:
 * pro-rata share of (buy cost + the source lot's own carried basis) over the
 * shares that entered the lot. Chains correctly across repeated transfers —
 * a scrub-created destination lot has one transfer-in split plus a
 * carried_basis slot, so its basis-per-share is carried_basis / shares. A
 * recorded transfer value is not purchase cost and must not create a step-up.
 *
 * Returns null when the source lot has no incoming shares to derive a basis
 * from (nothing to carry).
 */
export async function computeCarriedBasis(
  sourceLotGuid: string,
  transferredShares: number,
  tx: PrismaTx,
): Promise<number | null> {
  const sourceLotSplits = (await tx.splits.findMany({
    where: { lot_guid: sourceLotGuid },
    select: {
      guid: true,
      tx_guid: true,
      quantity_num: true,
      quantity_denom: true,
      value_num: true,
      value_denom: true,
    },
  })) ?? [];
  const sourceTxGuids = [...new Set(sourceLotSplits
    .map(s => s.tx_guid)
    .filter((guid): guid is string => typeof guid === 'string'))];
  const feeRows = sourceTxGuids.length > 0 ? await tx.splits.findMany({
    where: { tx_guid: { in: sourceTxGuids } },
    include: {
      account: { select: { name: true, account_type: true } },
      transaction: { select: { post_date: true, description: true } },
    },
  }) : [];
  const allocatedFees = allocateTradeFees(feeRows.map(s => ({
    guid: s.guid,
    txGuid: s.tx_guid,
    accountGuid: s.account_guid,
    accountType: s.account?.account_type ?? '',
    accountPath: s.account?.name ?? '',
    value: toDecimalNumber(s.value_num, s.value_denom),
    quantity: toDecimalNumber(s.quantity_num, s.quantity_denom),
    txDescription: s.transaction?.description ?? undefined,
    txDate: s.transaction?.post_date?.toISOString(),
  })));
  const sourceLotSlot = await tx.slots.findFirst({
    where: { obj_guid: sourceLotGuid, name: 'source_lot_guid' },
    select: { string_val: true },
  });
  let boughtShares = 0;
  let buyCost = 0;
  for (const s of sourceLotSplits) {
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    if (qty > 0) {
      boughtShares += qty;
      // A lot linked to a source lot entered through an own-account transfer.
      // Its positive split value is bookkeeping value, not a new acquisition
      // cost; its actual basis is in carried_basis.
      if (!sourceLotSlot?.string_val) {
        buyCost += Math.abs(toDecimalNumber(s.value_num, s.value_denom))
          + (allocatedFees.fees.get(s.guid) ?? 0);
      }
    }
  }
  if (boughtShares <= 0) return null;
  const carried = await readCarriedBasis(sourceLotGuid, tx);
  return ((buyCost + carried) / boughtShares) * transferredShares;
}

/**
 * Store the carried basis on a destination lot as a `carried_basis` slot,
 * tagged like the other transfer-metadata slots. No-op for null/0.
 */
async function writeCarriedBasisSlot(
  lotGuid: string,
  carriedBasis: number | null,
  tx: PrismaTx,
): Promise<void> {
  if (carriedBasis === null || !(Math.abs(carriedBasis) > 0)) return;
  await tx.slots.create({
    data: {
      obj_guid: lotGuid,
      name: 'carried_basis',
      slot_type: 4,
      string_val: String(Math.round(carriedBasis * 1e6) / 1e6),
    },
  });
}

// ---------------------------------------------------------------------------
// linkTransferToLot
// ---------------------------------------------------------------------------

/**
 * For a transfer-in split (positive qty, same commodity sent from another account),
 * create a new lot in the destination account with metadata linking to the source lot.
 *
 * Besides `source_lot_guid` and `acquisition_date`, the destination lot also
 * carries the transferred shares' remaining cost basis in a `carried_basis`
 * slot. This is written even when the transfer has a recorded value: an
 * own-account transfer is not a disposition or a basis step-up.
 * generateCapitalGains consumes it so the eventual real sale computes
 * proceeds − original basis.
 *
 * Idempotency: if the split already has a lot_guid, returns the existing lot.
 *
 * @param splitGuid - GUID of the transfer-in split
 * @param runId - Unique run identifier for tagging
 * @param tx - Prisma transaction client
 */
export async function linkTransferToLot(
  splitGuid: string,
  runId: string,
  tx: PrismaTx,
): Promise<LinkTransferResult> {
  const split = await tx.splits.findUnique({
    where: { guid: splitGuid },
    include: {
      transaction: {
        include: {
          splits: {
            include: {
              account: {
                select: { guid: true, commodity_guid: true, account_type: true },
              },
            },
          },
        },
      },
      account: { select: { commodity_guid: true } },
    },
  });

  if (!split) {
    throw new Error(`Split not found: ${splitGuid}`);
  }

  // Idempotency guard: if split already assigned to a lot, return it
  if (split.lot_guid) {
    return { lotGuid: split.lot_guid, created: false };
  }

  const accountCommodityGuid = split.account?.commodity_guid;

  // Find source split (negative qty, same commodity, non-TRADING)
  const sourceSplit = split.transaction?.splits.find(
    s =>
      s.account_guid !== split.account_guid &&
      s.account?.commodity_guid === accountCommodityGuid &&
      s.account?.account_type !== 'TRADING' &&
      toDecimalNumber(s.quantity_num, s.quantity_denom) < 0,
  );

  // Create a new lot for the destination account
  const lotGuid = generateGuid();
  await tx.lots.create({
    data: {
      guid: lotGuid,
      account_guid: split.account_guid,
      is_closed: 0,
    },
  });

  // Tag the lot
  await tx.slots.create({
    data: {
      obj_guid: lotGuid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });

  // If source split has a lot, link metadata
  if (sourceSplit?.lot_guid) {
    await tx.slots.create({
      data: {
        obj_guid: lotGuid,
        name: 'source_lot_guid',
        slot_type: 4,
        string_val: sourceSplit.lot_guid,
      },
    });

    // Carry original basis for every own-account transfer. A recorded value
    // is not a taxable disposition and must not step up the destination lot.
    const transferQty = toDecimalNumber(split.quantity_num, split.quantity_denom);
    if (transferQty > 0) {
      const carried = await computeCarriedBasis(sourceSplit.lot_guid, transferQty, tx);
      await writeCarriedBasisSlot(lotGuid, carried, tx);
    }

    // Try to find the acquisition date from the source lot
    const acqDateSlot = await tx.slots.findFirst({
      where: { obj_guid: sourceSplit.lot_guid, name: 'acquisition_date' },
      select: { string_val: true },
    });

    if (acqDateSlot?.string_val) {
      await tx.slots.create({
        data: {
          obj_guid: lotGuid,
          name: 'acquisition_date',
          slot_type: 4,
          string_val: acqDateSlot.string_val,
        },
      });
    } else {
      // Fall back to earliest split date in source lot
      const sourceLotSplits = await tx.splits.findMany({
        where: { lot_guid: sourceSplit.lot_guid },
        include: { transaction: { select: { post_date: true } } },
      });
      const dates = sourceLotSplits
        .map(s => s.transaction?.post_date)
        .filter((d): d is Date => d !== null && d !== undefined);
      if (dates.length > 0) {
        const earliest = new Date(Math.min(...dates.map(d => d.getTime())));
        await tx.slots.create({
          data: {
            obj_guid: lotGuid,
            name: 'acquisition_date',
            slot_type: 4,
            string_val: earliest.toISOString(),
          },
        });
      }
    }
  }

  // Set lot title
  const dateStr = split.transaction?.post_date
    ? split.transaction.post_date.toISOString().split('T')[0]
    : 'Unknown';
  await tx.slots.create({
    data: {
      obj_guid: lotGuid,
      name: 'title',
      slot_type: 4,
      string_val: `Transfer ${dateStr}`,
    },
  });

  // Assign the split to the new lot
  await tx.splits.update({
    where: { guid: splitGuid },
    data: { lot_guid: lotGuid },
  });

  return { lotGuid, created: true };
}

// ---------------------------------------------------------------------------
// splitTransferAcrossSourceLots
// ---------------------------------------------------------------------------

/**
 * For a transfer-in split whose source transaction had shares coming from
 * multiple lots, create one destination lot per source lot and sub-split
 * the transfer-in accordingly.
 *
 * Idempotency: if the split already has a lot_guid, returns immediately.
 * Falls back to linkTransferToLot when <= 1 lotted source split.
 *
 * @param splitGuid - GUID of the transfer-in split
 * @param runId - Unique run identifier for tagging
 * @param tx - Prisma transaction client
 */
export async function splitTransferAcrossSourceLots(
  splitGuid: string,
  runId: string,
  tx: PrismaTx,
): Promise<SplitTransferResult> {
  // Fetch split with transaction + splits + accounts
  const split = await tx.splits.findUnique({
    where: { guid: splitGuid },
    include: {
      transaction: {
        include: {
          splits: {
            include: {
              account: {
                select: { guid: true, commodity_guid: true, account_type: true },
              },
            },
          },
        },
      },
      account: { select: { commodity_guid: true } },
    },
  });

  if (!split) {
    throw new Error(`Split not found: ${splitGuid}`);
  }

  // Idempotency: if split already assigned to a lot, return
  if (split.lot_guid) {
    return { lotsCreated: 0, subSplitsCreated: 0, lotGuids: [] };
  }

  const accountCommodityGuid = split.account?.commodity_guid;

  // Find source transfer-out splits (negative qty, same commodity, non-TRADING)
  const sourceSplits = (split.transaction?.splits ?? []).filter(
    s =>
      s.account_guid !== split.account_guid &&
      s.account?.commodity_guid === accountCommodityGuid &&
      s.account?.account_type !== 'TRADING' &&
      toDecimalNumber(s.quantity_num, s.quantity_denom) < 0,
  );

  // Filter to only those with lot_guid
  const lottedSourceSplits = sourceSplits.filter(s => s.lot_guid !== null);

  // If <= 1 lotted source splits, delegate to linkTransferToLot
  if (lottedSourceSplits.length <= 1) {
    const result = await linkTransferToLot(splitGuid, runId, tx);
    return {
      lotsCreated: result.created ? 1 : 0,
      subSplitsCreated: 0,
      lotGuids: result.created ? [result.lotGuid] : [],
    };
  }

  // Multi-lot path: calculate allocations proportional to each source split's quantity
  const transferQty = toDecimalNumber(split.quantity_num, split.quantity_denom);
  const transferVal = toDecimalNumber(split.value_num, split.value_denom);
  const qtyDenom = Number(split.quantity_denom);
  const valDenom = Number(split.value_denom);

  interface Allocation {
    sourceLotGuid: string;
    shares: number;
  }
  const totalSourceQty = lottedSourceSplits.reduce(
    (sum, s) => sum + Math.abs(toDecimalNumber(s.quantity_num, s.quantity_denom)), 0,
  );

  const allocations: Allocation[] = lottedSourceSplits.map(s => ({
    sourceLotGuid: s.lot_guid!,
    shares: (Math.abs(toDecimalNumber(s.quantity_num, s.quantity_denom)) / totalSourceQty) * transferQty,
  }));

  // Helper: create a destination lot for a source lot
  async function createDestLot(
    sourceLotGuid: string,
    postDate: Date | null | undefined,
    allocShares: number,
  ): Promise<string> {
    const lotGuid = generateGuid();
    await tx.lots.create({
      data: {
        guid: lotGuid,
        account_guid: split!.account_guid,
        is_closed: 0,
      },
    });

    // Tag the lot
    await tx.slots.create({
      data: {
        obj_guid: lotGuid,
        name: 'gnucash_web_generated',
        slot_type: 4,
        string_val: runId,
      },
    });

    // Link source_lot_guid
    await tx.slots.create({
      data: {
        obj_guid: lotGuid,
        name: 'source_lot_guid',
        slot_type: 4,
        string_val: sourceLotGuid,
      },
    });

    // Carry original basis for every own-account transfer (see
    // linkTransferToLot — same rule, per source lot here).
    if (allocShares > 0) {
      const carried = await computeCarriedBasis(sourceLotGuid, allocShares, tx);
      await writeCarriedBasisSlot(lotGuid, carried, tx);
    }

    // Carry acquisition_date: check slot first, fall back to earliest split date
    const acqDateSlot = await tx.slots.findFirst({
      where: { obj_guid: sourceLotGuid, name: 'acquisition_date' },
      select: { string_val: true },
    });

    if (acqDateSlot?.string_val) {
      await tx.slots.create({
        data: {
          obj_guid: lotGuid,
          name: 'acquisition_date',
          slot_type: 4,
          string_val: acqDateSlot.string_val,
        },
      });
    } else {
      const sourceLotSplits = await tx.splits.findMany({
        where: { lot_guid: sourceLotGuid },
        include: { transaction: { select: { post_date: true } } },
      });
      const dates = sourceLotSplits
        .map(s => s.transaction?.post_date)
        .filter((d): d is Date => d !== null && d !== undefined);
      if (dates.length > 0) {
        const earliest = new Date(Math.min(...dates.map((d: Date) => d.getTime())));
        await tx.slots.create({
          data: {
            obj_guid: lotGuid,
            name: 'acquisition_date',
            slot_type: 4,
            string_val: earliest.toISOString(),
          },
        });
      }
    }

    // Set lot title
    const dateStr = postDate
      ? new Date(postDate).toISOString().split('T')[0]
      : 'Unknown';
    await tx.slots.create({
      data: {
        obj_guid: lotGuid,
        name: 'title',
        slot_type: 4,
        string_val: `Transfer ${dateStr}`,
      },
    });

    return lotGuid;
  }

  // Save original values on transfer-in split as slots for revert
  await tx.slots.create({
    data: {
      obj_guid: splitGuid,
      name: 'original_quantity_num',
      slot_type: 4,
      string_val: split.quantity_num.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: splitGuid,
      name: 'original_quantity_denom',
      slot_type: 4,
      string_val: split.quantity_denom.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: splitGuid,
      name: 'original_value_num',
      slot_type: 4,
      string_val: split.value_num.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: splitGuid,
      name: 'original_value_denom',
      slot_type: 4,
      string_val: split.value_denom.toString(),
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: splitGuid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });

  const lotGuids: string[] = [];
  let usedQtyNum = 0n;
  let usedValNum = 0n;

  // First allocation reuses the original split
  const firstAlloc = allocations[0];
  const firstLotGuid = await createDestLot(firstAlloc.sourceLotGuid, split.transaction?.post_date, firstAlloc.shares);
  lotGuids.push(firstLotGuid);

  const firstQty = fromDecimal(firstAlloc.shares, qtyDenom);
  const firstValProportion = transferQty > 0 ? (firstAlloc.shares / transferQty) * transferVal : 0;
  const firstVal = fromDecimal(firstValProportion, valDenom);

  await tx.splits.update({
    where: { guid: splitGuid },
    data: {
      lot_guid: firstLotGuid,
      quantity_num: firstQty.num,
      quantity_denom: firstQty.denom,
      value_num: firstVal.num,
      value_denom: firstVal.denom,
    },
  });

  usedQtyNum += firstQty.num;
  usedValNum += firstVal.num;

  // Remaining allocations create new sub-splits
  let subSplitsCreated = 0;
  for (let i = 1; i < allocations.length; i++) {
    const alloc = allocations[i];
    const isLast = i === allocations.length - 1;
    const lotGuid = await createDestLot(alloc.sourceLotGuid, split.transaction?.post_date, alloc.shares);
    lotGuids.push(lotGuid);

    let subQty: { num: bigint; denom: bigint };
    let subVal: { num: bigint; denom: bigint };

    if (isLast) {
      // Last sub-split gets remainder to avoid rounding drift
      subQty = { num: split.quantity_num - usedQtyNum, denom: BigInt(qtyDenom) };
      subVal = { num: split.value_num - usedValNum, denom: BigInt(valDenom) };
    } else {
      subQty = fromDecimal(alloc.shares, qtyDenom);
      const valProportion = transferQty > 0 ? (alloc.shares / transferQty) * transferVal : 0;
      subVal = fromDecimal(valProportion, valDenom);
      usedQtyNum += subQty.num;
      usedValNum += subVal.num;
    }

    const subGuid = generateGuid();
    await tx.splits.create({
      data: {
        guid: subGuid,
        tx_guid: split.tx_guid,
        account_guid: split.account_guid,
        memo: split.memo,
        action: split.action,
        reconcile_state: split.reconcile_state,
        reconcile_date: split.reconcile_date,
        value_num: subVal.num,
        value_denom: subVal.denom,
        quantity_num: subQty.num,
        quantity_denom: subQty.denom,
        lot_guid: lotGuid,
      },
    });

    // Tag sub-split with its run and the transfer-in split it came from
    await tagGeneratedSubSplit(tx, subGuid, splitGuid, runId);

    subSplitsCreated++;
  }

  // Assert transaction balance == 0 (skip for $0 transfers where it's trivially satisfied)
  if (transferVal !== 0) {
    const allTxSplits = await tx.splits.findMany({
      where: { tx_guid: split.tx_guid },
    });
    const totalValue = allTxSplits.reduce(
      (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom), 0,
    );
    if (Math.abs(totalValue) > 0.01) {
      throw new Error(
        `Transaction balance invariant violated after transfer split: ${totalValue.toFixed(4)} (tx: ${split.tx_guid})`,
      );
    }
  }

  return { lotsCreated: lotGuids.length, subSplitsCreated, lotGuids };
}

// ---------------------------------------------------------------------------
// valueZeroValueTrade
// ---------------------------------------------------------------------------

/** Latest price for a commodity on or before a date, preferring the given currency. */
async function lookupPriceOn(
  commodityGuid: string,
  preferredCurrencyGuid: string | null,
  date: Date,
  tx: PrismaTx,
): Promise<number | null> {
  const where = (withCurrency: boolean) => ({
    commodity_guid: commodityGuid,
    ...(withCurrency && preferredCurrencyGuid ? { currency_guid: preferredCurrencyGuid } : {}),
    date: { lte: date },
  });
  let row = preferredCurrencyGuid
    ? await tx.prices.findFirst({
        where: where(true),
        orderBy: { date: 'desc' },
        select: { value_num: true, value_denom: true },
      })
    : null;
  if (!row) {
    row = await tx.prices.findFirst({
      where: where(false),
      orderBy: { date: 'desc' },
      select: { value_num: true, value_denom: true },
    });
  }
  if (!row) return null;
  const price = toDecimalNumber(row.value_num, row.value_denom);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Value a zero-value commodity-for-commodity trade from the price DB.
 *
 * Shape: a STOCK/MUTUAL split changes quantity with value ≈ 0 and the
 * transaction's counter-split is a DIFFERENT commodity also changing quantity
 * at value ≈ 0 (e.g. "Buy ETH": ETH +3 / BTC −0.0696, both $0). Without a
 * value, the scrub treats the negative side as a $0-proceeds sell (phantom
 * loss) and the positive side as a zero-cost buy lot (phantom gain later).
 *
 * This rewrites BOTH legs' values to ± the trade's market value on the trade
 * date, derived from the price DB (disposal leg's commodity preferred, then
 * the acquisition leg's), keeping the transaction balanced. Original values
 * are preserved in original_* slots and both legs are tagged with the runId so
 * clear/revert restores them.
 *
 * Idempotent: returns immediately when the split already carries a value.
 * When NO price exists for either commodity, nothing is rewritten and a
 * warning is returned — the caller must not book a gain/loss from a $0 sell.
 */
export async function valueZeroValueTrade(
  splitGuid: string,
  runId: string,
  tx: PrismaTx,
): Promise<ValueTradeResult> {
  // Canonical parent lock BEFORE anything is read. The lot engine's book-wide
  // advisory lock (guardBookLock) serializes lot operations against each other
  // but not against the reconcile routes, which take the parent TRANSACTION
  // row lock — so take that lock here too, or the reconcile-state check below
  // can be raced. Resolution and locking happen in one statement, so this is
  // literally lock-then-read with no caveat. Both legs live in the same
  // transaction, so the single lock covers them.
  await lockTransactionsForSplits([splitGuid], tx);

  const split = await tx.splits.findUnique({
    where: { guid: splitGuid },
    include: {
      transaction: {
        include: {
          splits: {
            include: {
              account: {
                select: { guid: true, commodity_guid: true, account_type: true },
              },
            },
          },
        },
      },
      account: { select: { commodity_guid: true } },
    },
  });
  if (!split) {
    throw new Error(`Split not found: ${splitGuid}`);
  }

  const ownValue = toDecimalNumber(split.value_num, split.value_denom);
  const ownQty = toDecimalNumber(split.quantity_num, split.quantity_denom);
  if (Math.abs(ownValue) > 0.005) {
    return { valued: true }; // already valued (or a second visit from the counter account's scrub)
  }
  if (!(Math.abs(ownQty) > 0)) {
    return { valued: false, warning: 'Zero-quantity split is not a trade leg' };
  }

  const ownCommodity = split.account?.commodity_guid ?? null;
  const txCurrencyGuid = split.transaction?.currency_guid ?? null;
  const postDate = split.transaction?.post_date ?? new Date();

  // Counter legs: other accounts, DIFFERENT commodity, nonzero quantity,
  // zero value (the other side of the barter trade).
  const counterLegs = (split.transaction?.splits ?? []).filter(s => {
    if (s.guid === split.guid || s.account_guid === split.account_guid) return false;
    if (!s.account?.commodity_guid || s.account.commodity_guid === ownCommodity) return false;
    if (s.account.account_type === 'TRADING') return false;
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    const val = toDecimalNumber(s.value_num, s.value_denom);
    return Math.abs(qty) > 0 && Math.abs(val) < 0.005;
  });
  if (counterLegs.length === 0) {
    return { valued: false, warning: 'No opposite-commodity counter leg found for zero-value trade' };
  }
  // Primary counter = largest |quantity|.
  const counter = counterLegs.reduce((best, cur) => {
    const b = Math.abs(toDecimalNumber(best.quantity_num, best.quantity_denom));
    const c = Math.abs(toDecimalNumber(cur.quantity_num, cur.quantity_denom));
    return c > b ? cur : best;
  });
  const counterQty = toDecimalNumber(counter.quantity_num, counter.quantity_denom);
  const counterCommodity = counter.account!.commodity_guid!;

  // Trade value: FMV of the DISPOSAL side at the trade date (IRS: proceeds of
  // the disposed asset = FMV of property received; a same-moment trade makes
  // the two equal, and the disposal side's price is the better-attested one).
  const disposal = ownQty < 0
    ? { qty: ownQty, commodity: ownCommodity }
    : { qty: counterQty, commodity: counterCommodity };
  const acquisition = ownQty < 0
    ? { qty: counterQty, commodity: counterCommodity }
    : { qty: ownQty, commodity: ownCommodity };

  let tradeValue: number | null = null;
  if (disposal.commodity) {
    const p = await lookupPriceOn(disposal.commodity, txCurrencyGuid, postDate, tx);
    if (p !== null) tradeValue = Math.abs(disposal.qty) * p;
  }
  if (tradeValue === null && acquisition.commodity) {
    const p = await lookupPriceOn(acquisition.commodity, txCurrencyGuid, postDate, tx);
    if (p !== null) tradeValue = Math.abs(acquisition.qty) * p;
  }
  if (tradeValue === null || !(tradeValue > 0)) {
    return {
      valued: false,
      warning: `No price found on/before ${postDate.toISOString().slice(0, 10)} to value zero-value trade (tx ${split.tx_guid}) — refusing to book a gain/loss from a $0-value trade`,
    };
  }

  // Reconciled/frozen guard. Unlike splitSellAcrossLots — which re-partitions
  // a split into sub-splits that inherit reconcile metadata and sum back to
  // the original, leaving every reconciled balance untouched — this function
  // REWRITES a leg's value from 0 to ±FMV. That is a real change to an amount
  // the user may have agreed against a statement, so it is refused rather than
  // exempted. Checked before the original_* slot writes below, so a blocked
  // trade leaves no half-written revert metadata behind, and read under the
  // parent lock taken at the top of this function.
  assertSplitsNotProtected('value this zero-value trade', [
    { ...split, account: null },
    { ...counter, account: null },
  ]);

  // Rewrite both legs: positive-qty leg debits +value, negative-qty leg
  // credits −value; the transaction stays balanced.
  const legs = [
    { guid: split.guid, qty: ownQty, value_num: split.value_num, value_denom: split.value_denom, quantity_num: split.quantity_num, quantity_denom: split.quantity_denom },
    { guid: counter.guid, qty: counterQty, value_num: counter.value_num, value_denom: counter.value_denom, quantity_num: counter.quantity_num, quantity_denom: counter.quantity_denom },
  ];
  for (const leg of legs) {
    const denom = Number(leg.value_denom) > 0 ? Number(leg.value_denom) : 100;
    const newVal = fromDecimal(leg.qty > 0 ? tradeValue : -tradeValue, denom);
    // Save originals (quantity too — the revert path restores splits keyed on
    // the original_quantity_num slot).
    for (const [name, val] of [
      ['original_quantity_num', leg.quantity_num.toString()],
      ['original_quantity_denom', leg.quantity_denom.toString()],
      ['original_value_num', leg.value_num.toString()],
      ['original_value_denom', leg.value_denom.toString()],
      ['gnucash_web_generated', runId],
    ] as const) {
      await tx.slots.create({
        data: { obj_guid: leg.guid, name, slot_type: 4, string_val: val },
      });
    }
    await tx.splits.update({
      where: { guid: leg.guid },
      data: { value_num: newVal.num, value_denom: newVal.denom },
    });
  }

  return { valued: true };
}

// ---------------------------------------------------------------------------
// assignAdjustmentToLots
// ---------------------------------------------------------------------------

/**
 * Assign a stock-split / reverse-split adjustment split (single-account
 * quantity change with zero value and no counter-quantity splits anywhere in
 * the transaction) across the account's open lots, SCALING them pro-rata by
 * their current shares instead of opening a zero-cost lot (forward split) or
 * realizing a $0-proceeds "sale" (reverse split).
 *
 * The adjustment splits carry zero value, so lot basis is untouched — exactly
 * what a stock split means economically.
 *
 * **IMPORTANT**: Mutates `openLots[].shares` in-place.
 */
export async function assignAdjustmentToLots(
  adjSplitGuid: string,
  openLots: OpenLot[],
  runId: string,
  tx: PrismaTx,
  qtyEpsilon: number = DEFAULT_QTY_EPSILON,
): Promise<AdjustmentResult> {
  const adjSplit = await tx.splits.findUnique({ where: { guid: adjSplitGuid } });
  if (!adjSplit) {
    throw new Error(`Adjustment split not found: ${adjSplitGuid}`);
  }

  const adjQty = toDecimalNumber(adjSplit.quantity_num, adjSplit.quantity_denom);
  const targets = openLots.filter(l => l.shares > qtyEpsilon);
  if (targets.length === 0) {
    return { subSplitsCreated: [], lotsUsed: [], warning: 'Stock split adjustment with no open lots — left unassigned' };
  }

  // Single open lot: assign the original split to it directly.
  if (targets.length === 1) {
    await tx.splits.update({
      where: { guid: adjSplitGuid },
      data: { lot_guid: targets[0].guid },
    });
    targets[0].shares += adjQty;
    return { subSplitsCreated: [], lotsUsed: [targets[0].guid] };
  }

  // Multiple open lots: distribute pro-rata by current shares, sub-splitting
  // like splitSellAcrossLots (original split takes the first allocation, the
  // last allocation absorbs rounding).
  const totalShares = targets.reduce((sum, l) => sum + l.shares, 0);
  const qtyDenom = Number(adjSplit.quantity_denom);

  for (const [name, val] of [
    ['original_quantity_num', adjSplit.quantity_num.toString()],
    ['original_quantity_denom', adjSplit.quantity_denom.toString()],
    ['original_value_num', adjSplit.value_num.toString()],
    ['original_value_denom', adjSplit.value_denom.toString()],
    ['gnucash_web_generated', runId],
  ] as const) {
    await tx.slots.create({
      data: { obj_guid: adjSplitGuid, name, slot_type: 4, string_val: val },
    });
  }

  const subSplitsCreated: string[] = [];
  const lotsUsed: string[] = [];
  let usedQtyNum = 0n;

  for (let i = 0; i < targets.length; i++) {
    const lot = targets[i];
    const isLast = i === targets.length - 1;
    const allocQty = isLast
      ? { num: adjSplit.quantity_num - usedQtyNum, denom: BigInt(qtyDenom) }
      : fromDecimal(adjQty * (lot.shares / totalShares), qtyDenom);
    usedQtyNum += allocQty.num;
    const allocDecimal = toDecimalNumber(allocQty.num, allocQty.denom);

    if (i === 0) {
      await tx.splits.update({
        where: { guid: adjSplitGuid },
        data: {
          lot_guid: lot.guid,
          quantity_num: allocQty.num,
          quantity_denom: allocQty.denom,
        },
      });
    } else {
      const subGuid = generateGuid();
      await tx.splits.create({
        data: {
          guid: subGuid,
          tx_guid: adjSplit.tx_guid,
          account_guid: adjSplit.account_guid,
          memo: adjSplit.memo,
          action: adjSplit.action,
          reconcile_state: adjSplit.reconcile_state,
          reconcile_date: adjSplit.reconcile_date,
          value_num: 0n,
          value_denom: adjSplit.value_denom,
          quantity_num: allocQty.num,
          quantity_denom: allocQty.denom,
          lot_guid: lot.guid,
        },
      });
      await tagGeneratedSubSplit(tx, subGuid, adjSplitGuid, runId);
      subSplitsCreated.push(subGuid);
    }
    lot.shares += allocDecimal;
    lotsUsed.push(lot.guid);
  }

  return { subSplitsCreated, lotsUsed };
}

// ---------------------------------------------------------------------------
// generateCapitalGains
// ---------------------------------------------------------------------------

/**
 * For a closed lot (shares sum to ~0), create a GnuCash double-balance gains transaction:
 * - Adjusting split in investment account (zero shares, +gainLoss value —
 *   offsets the lot's basis-minus-proceeds so the lot totals to zero)
 * - Corresponding entry in a capital-gains income account (zero shares,
 *   -gainLoss value — a credit, i.e. income, for a gain)
 *
 * Currency: uses the source transaction's currency only when it is a real
 * CURRENCY commodity; otherwise falls back to the nearest ancestor account's
 * currency, then the most-common currency across accounts. Split VALUES are
 * denominated in the currency's fraction; split QUANTITIES use the investment
 * account's `commodity_scu`.
 *
 * Gains account: prefers an existing INCOME account under the lot's book root
 * whose full name contains "capital gain" and matches the holding period
 * (honoring taxable/non-taxable naming for the tax classification); only
 * creates `Income:Capital Gains:...` when no match exists.
 *
 * Classifies ST/LT by holding period; handles TAX_EXEMPT (skip) and TAX_DEFERRED.
 *
 * Skip rules (the lot is still marked closed):
 * - TRANSFER-CLOSED lots: a lot whose only share-consuming splits are
 *   transfer-outs (same-commodity positive counter-split in another
 *   non-TRADING account) books NO gains — a transfer is not a taxable event.
 *   The basis travels to the destination lot via its `carried_basis` slot.
 * - Break-even lots (|gain| < $0.005): no $0-value bookkeeping transaction.
 * - Zero-proceeds sells: when shares were disposed with ~$0 total proceeds
 *   (an unvalued trade with no price in the price DB), no gain/loss is booked.
 *
 * Basis: a destination lot's `carried_basis` slot (written by the transfer
 * linking functions) counts as additional basis. Mixed lots (partial sale +
 * transfer-out) realize only the SOLD shares' pro-rata gain.
 *
 * @param lotGuid - GUID of the closed lot
 * @param runId - Unique run identifier for tagging
 * @param tx - Prisma transaction client
 */
export async function generateCapitalGains(
  lotGuid: string,
  runId: string,
  tx: PrismaTx,
): Promise<CapitalGainsResult> {
  // Fetch the lot with splits
  const lot = await tx.lots.findUnique({
    where: { guid: lotGuid },
    include: {
      splits: {
        include: {
          transaction: { select: { post_date: true, currency_guid: true } },
        },
      },
      account: {
        select: {
          guid: true,
          commodity_guid: true,
          commodity_scu: true,
          parent_guid: true,
        },
      },
    },
  });

  if (!lot || !lot.account) {
    throw new Error(`Lot or account not found: ${lotGuid}`);
  }

  // Commodity-aware share epsilon: 0.0001 shares of a 1e8-precision crypto is
  // real money, so the closure threshold shrinks with the commodity's scu.
  const qtyEps = qtyEpsilonForScu(lot.account.commodity_scu);

  // Check if lot is actually closed (shares ~0)
  const totalShares = lot.splits.reduce(
    (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom),
    0,
  );
  if (Math.abs(totalShares) > qtyEps) {
    return {
      gainsTransactionGuid: null,
      skippedReason: `Lot is not closed (remaining shares: ${totalShares.toFixed(8)})`,
      gainLoss: 0,
      holdingPeriod: null,
      taxClassification: 'TAX_NORMAL',
    };
  }

  // Check for pre-existing gains split (already has a zero-quantity split)
  const existingGainsSplit = lot.splits.find(s => {
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    const val = toDecimalNumber(s.value_num, s.value_denom);
    return Math.abs(qty) < qtyEps && Math.abs(val) > 0.0001;
  });
  if (existingGainsSplit) {
    return {
      gainsTransactionGuid: null,
      skippedReason: 'Pre-existing gains split found',
      gainLoss: 0,
      holdingPeriod: null,
      taxClassification: 'TAX_NORMAL',
    };
  }

  // ── Classify the lot's share-moving splits ────────────────────────────────
  // A negative split whose transaction carries a same-commodity positive
  // counter-split in ANOTHER non-TRADING account is a TRANSFER-OUT (the same
  // predicate splitTransferAcrossSourceLots uses), not a sale.
  const accountCommodityGuid = lot.account.commodity_guid;
  type LotSplit = (typeof lot.splits)[number];
  const buySplits: LotSplit[] = [];
  const sellSplits: LotSplit[] = [];
  const transferOutSplits: LotSplit[] = [];
  for (const s of lot.splits) {
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    if (qty > qtyEps) {
      buySplits.push(s);
    } else if (qty < -qtyEps) {
      const siblings = (await tx.splits.findMany({
        where: { tx_guid: s.tx_guid },
        include: {
          account: { select: { guid: true, commodity_guid: true, account_type: true } },
        },
      })) ?? [];
      const isTransferOut = isOwnAccountCommodityTransfer(
        { ...s, account_guid: lot.account!.guid, transaction: { splits: siblings } },
        accountCommodityGuid,
        'out',
      );
      (isTransferOut ? transferOutSplits : sellSplits).push(s);
    }
  }

  // TRANSFER-CLOSED lot: not a taxable event. Booking proceeds − basis here
  // would fabricate a phantom gain/loss. Close the lot and skip.
  if (transferOutSplits.length > 0 && sellSplits.length === 0) {
    await tx.lots.update({
      where: { guid: lotGuid },
      data: { is_closed: 1 },
    });
    return {
      gainsTransactionGuid: null,
      skippedReason: 'Closed by transfer — not a taxable event',
      gainLoss: 0,
      holdingPeriod: null,
      taxClassification: 'TAX_NORMAL',
    };
  }

  // ── Calculate gain/loss ──────────────────────────────────────────────────
  // Native GnuCash sign convention: a buy split has POSITIVE value (debit)
  // and a sell split NEGATIVE value (credit), so the lot's splits sum to
  // basis - proceeds and gain = -(sum). That legacy form only holds when every
  // consumed share was SOLD and no basis was carried in from a transfer;
  // otherwise realize the sold shares' pro-rata share of the total basis
  // (buy cost + carried_basis).
  const carriedBasis = await readCarriedBasis(lotGuid, tx);
  const soldShares = sellSplits.reduce(
    (sum, s) => sum + Math.abs(toDecimalNumber(s.quantity_num, s.quantity_denom)), 0,
  );
  const saleProceeds = -sellSplits.reduce(
    (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom), 0,
  );

  let gainLoss: number;
  if (transferOutSplits.length === 0 && Math.abs(carriedBasis) < 0.005) {
    gainLoss = -lot.splits.reduce(
      (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom),
      0,
    );
  } else {
    const boughtShares = buySplits.reduce(
      (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom), 0,
    );
    // Only a carried-basis transfer replaces its recorded transfer-in value.
    // Legacy source-linked lots have no replacement basis and retain their
    // recorded value until they are explicitly re-scrubbed.
    const transferInSplitGuids = new Set<string>();
    if (Math.abs(carriedBasis) >= 0.005) {
      for (const buy of buySplits) {
        const siblings = await tx.splits.findMany({
          where: { tx_guid: buy.tx_guid },
          include: { account: { select: { guid: true, commodity_guid: true, account_type: true } } },
        });
        if (isOwnAccountCommodityTransfer(
          { ...buy, account_guid: lot.account!.guid, transaction: { splits: siblings } },
          accountCommodityGuid,
          'in',
        )) {
          transferInSplitGuids.add(buy.guid);
        }
      }
    }
    const buyCost = buySplits.reduce(
      (sum, s) => sum + (transferInSplitGuids.has(s.guid)
        ? 0
        : Math.abs(toDecimalNumber(s.value_num, s.value_denom))),
      0,
    );
    const basisPerShare = boughtShares > qtyEps ? (buyCost + carriedBasis) / boughtShares : 0;
    gainLoss = saleProceeds - soldShares * basisPerShare;
  }

  // Break-even: a $0-value gains transaction is pure noise — the lot already
  // sums to zero. Close it and skip the booking.
  if (Math.abs(gainLoss) < 0.005) {
    await tx.lots.update({
      where: { guid: lotGuid },
      data: { is_closed: 1 },
    });
    return {
      gainsTransactionGuid: null,
      skippedReason: 'Break-even — no gains entry needed',
      gainLoss: 0,
      holdingPeriod: null,
      taxClassification: 'TAX_NORMAL',
    };
  }

  // Zero-proceeds disposal: shares left the lot with ~$0 total proceeds. This
  // is an unvalued trade (no price in the price DB — see valueZeroValueTrade),
  // not a real sale at zero; refusing to book prevents a phantom loss equal to
  // the entire basis.
  if (soldShares > qtyEps && Math.abs(saleProceeds) < 0.005) {
    await tx.lots.update({
      where: { guid: lotGuid },
      data: { is_closed: 1 },
    });
    return {
      gainsTransactionGuid: null,
      skippedReason: 'Zero-proceeds disposal (no price to value the trade) — refusing to book a gain/loss from a $0-value sell',
      gainLoss: 0,
      holdingPeriod: null,
      taxClassification: 'TAX_NORMAL',
    };
  }

  // Classify tax status
  const taxClassification = await classifyAccountTax(lot.account.guid, tx);

  // TAX_EXEMPT: skip gains generation
  if (taxClassification === 'TAX_EXEMPT') {
    // Still close the lot
    await tx.lots.update({
      where: { guid: lotGuid },
      data: { is_closed: 1 },
    });
    return {
      gainsTransactionGuid: null,
      skippedReason: 'Tax-exempt account — gains not recorded',
      gainLoss,
      holdingPeriod: null,
      taxClassification,
    };
  }

  // Determine holding period
  // Check for acquisition_date slot first (from transfer linking)
  const acqDateSlot = await tx.slots.findFirst({
    where: { obj_guid: lotGuid, name: 'acquisition_date' },
    select: { string_val: true },
  });

  const dates = lot.splits
    .map(s => s.transaction?.post_date)
    .filter((d): d is Date => d !== null && d !== undefined)
    .sort((a, b) => a.getTime() - b.getTime());

  const openDate = acqDateSlot?.string_val
    ? new Date(acqDateSlot.string_val)
    : dates[0] || null;
  const closeDate = dates[dates.length - 1] || null;

  let holdingPeriod: HoldingPeriod | null = null;
  if (openDate && closeDate) {
    holdingPeriod = classifyHoldingPeriod(openDate, closeDate);
  }

  // Load all accounts once — used for the currency fallback walk, the
  // book-root walk, and existing gains-account discovery. Walking in JS keeps
  // this compatible with the in-memory fake prisma used in tests.
  const allAccounts: Array<{
    guid: string;
    name: string;
    parent_guid: string | null;
    account_type: string;
    commodity_guid: string | null;
  }> = await tx.accounts.findMany({
    select: {
      guid: true,
      name: true,
      parent_guid: true,
      account_type: true,
      commodity_guid: true,
    },
  });
  const accountsByGuid = new Map(allAccounts.map(a => [a.guid, a]));

  // --- Resolve the transaction currency -------------------------------------
  // The source transaction's currency is only trustworthy when it is a real
  // CURRENCY commodity. Imported crypto/stock data can produce transactions
  // denominated in the commodity itself, which would make the gains
  // transaction nonsense (unbalanced in registers).
  const commodityCache = new Map<string, { namespace: string; fraction: number } | null>();
  const getCommodity = async (guid: string | null | undefined) => {
    if (!guid) return null;
    if (!commodityCache.has(guid)) {
      const c = await tx.commodities.findUnique({
        where: { guid },
        select: { namespace: true, fraction: true },
      });
      commodityCache.set(guid, c);
    }
    return commodityCache.get(guid) ?? null;
  };

  let currencyGuid: string | null = null;
  let currencyFraction = 100;

  const sourceCurrencyGuid = lot.splits[0]?.transaction?.currency_guid ?? null;
  const sourceCommodity = await getCommodity(sourceCurrencyGuid);
  if (sourceCurrencyGuid && sourceCommodity?.namespace === 'CURRENCY') {
    currencyGuid = sourceCurrencyGuid;
    currencyFraction = sourceCommodity.fraction || 100;
  } else {
    // Walk up the investment account's ancestors and use the first account
    // whose commodity is a currency.
    let ancestorGuid = lot.account.parent_guid;
    for (let i = 0; i < 20 && ancestorGuid && !currencyGuid; i++) {
      const ancestor = accountsByGuid.get(ancestorGuid);
      if (!ancestor) break;
      const commodity = await getCommodity(ancestor.commodity_guid);
      if (ancestor.commodity_guid && commodity?.namespace === 'CURRENCY') {
        currencyGuid = ancestor.commodity_guid;
        currencyFraction = commodity.fraction || 100;
      }
      ancestorGuid = ancestor.parent_guid;
    }

    if (!currencyGuid) {
      // Last resort: the most-common CURRENCY commodity across accounts
      // (deterministic: account count desc, then guid).
      const currencies: Array<{ guid: string; fraction: number }> =
        await tx.commodities.findMany({
          where: { namespace: 'CURRENCY' },
          select: { guid: true, fraction: true },
        });
      const counts = new Map<string, number>();
      for (const a of allAccounts) {
        if (a.commodity_guid) {
          counts.set(a.commodity_guid, (counts.get(a.commodity_guid) || 0) + 1);
        }
      }
      const ranked = [...currencies].sort((a, b) => {
        const diff = (counts.get(b.guid) || 0) - (counts.get(a.guid) || 0);
        if (diff !== 0) return diff;
        return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
      });
      if (ranked.length > 0) {
        currencyGuid = ranked[0].guid;
        currencyFraction = ranked[0].fraction || 100;
      }
    }
  }

  if (!currencyGuid) {
    throw new Error('Cannot determine currency for gains transaction');
  }

  // --- Resolve the gains account ---------------------------------------------
  // Walk up from the lot's account to its book root.
  let rootGuid: string | null = null;
  {
    let cursor = accountsByGuid.get(lot.account.guid) ?? null;
    for (let i = 0; i < 20 && cursor; i++) {
      if (!cursor.parent_guid) {
        rootGuid = cursor.guid;
        break;
      }
      cursor = accountsByGuid.get(cursor.parent_guid) ?? null;
    }
  }
  if (!rootGuid) {
    // Broken parent chain — fall back to the first book's root.
    const book = await tx.books.findFirst({ select: { root_account_guid: true } });
    rootGuid = book?.root_account_guid ?? null;
  }
  if (!rootGuid) {
    throw new Error('Cannot determine book root for gains transaction');
  }

  // Build a fullname (root excluded, ":"-joined) plus the root it belongs to.
  const fullnameOf = (guid: string): { fullname: string; root: string | null } => {
    const parts: string[] = [];
    let cur = accountsByGuid.get(guid) ?? null;
    let root: string | null = null;
    for (let i = 0; i < 25 && cur; i++) {
      if (!cur.parent_guid) {
        root = cur.guid;
        break;
      }
      parts.unshift(cur.name);
      cur = accountsByGuid.get(cur.parent_guid) ?? null;
    }
    return { fullname: parts.join(':'), root };
  };

  // Candidates: INCOME accounts under this book root whose fullname mentions
  // capital gains and matches the holding period.
  const periodRe = holdingPeriod === 'long_term' ? /long[ -]?term/ : /short[ -]?term/;
  let candidates = allAccounts
    .filter(a => a.account_type === 'INCOME')
    .map(a => ({ guid: a.guid, ...fullnameOf(a.guid) }))
    .filter(c => {
      if (c.root !== rootGuid) return false;
      const lower = c.fullname.toLowerCase();
      return lower.includes('capital gain') && periodRe.test(lower);
    });

  // Taxability preference.
  const nonTaxableRe = /non.?taxable|tax.?deferred/;
  const taxableRe = /(^|[^-\w])taxable\b|:taxable/;
  if (taxClassification === 'TAX_DEFERRED') {
    const sheltered = candidates.filter(c => nonTaxableRe.test(c.fullname.toLowerCase()));
    if (sheltered.length > 0) candidates = sheltered;
  } else {
    const notSheltered = candidates.filter(c => !nonTaxableRe.test(c.fullname.toLowerCase()));
    if (notSheltered.length > 0) candidates = notSheltered;
    const explicitlyTaxable = candidates.filter(c => taxableRe.test(c.fullname.toLowerCase()));
    if (explicitlyTaxable.length > 0) candidates = explicitlyTaxable;
  }

  // Deterministic pick: deepest path first, then alphabetical.
  candidates.sort((a, b) => {
    const depthDiff = b.fullname.split(':').length - a.fullname.split(':').length;
    if (depthDiff !== 0) return depthDiff;
    return a.fullname < b.fullname ? -1 : a.fullname > b.fullname ? 1 : 0;
  });

  let gainsAccountGuid: string;
  if (candidates.length > 0) {
    gainsAccountGuid = candidates[0].guid;
  } else {
    // No existing account matches — create the default hierarchy.
    const periodLabel = holdingPeriod === 'long_term' ? 'Long Term' : 'Short Term';
    const gainsAccountPath =
      taxClassification === 'TAX_DEFERRED'
        ? `Income:Capital Gains:Tax-Deferred:${periodLabel}`
        : `Income:Capital Gains:${periodLabel}`;
    // A scrub closes many lots in one transaction and each closed lot lands
    // here, so a run that closes a short-term lot before a long-term one
    // claims the two sibling leaves in the wrong order. Registered rather than
    // fixed: ordering the loop needs the per-lot holding period, which is
    // computed halfway through this function's own work. See
    // UNORDERED_CLAIM_SITES in src/lib/account-lock-order.ts.
    gainsAccountGuid = await findOrCreateAccount(gainsAccountPath, rootGuid, currencyGuid, tx, {
      bookRootGuid: rootGuid,
      prefix: [],
      unorderedSite: 'lot-scrub:capital-gains',
    });
  }

  // Split VALUES are denominated in the transaction currency's fraction;
  // split QUANTITIES use the investment account's commodity_scu.
  const scu = lot.account.commodity_scu || 100;
  const valFrac = fromDecimal(Math.abs(gainLoss), currencyFraction);

  // Create the gains transaction
  const txGuid = generateGuid();
  const now = new Date();
  const postDate = closeDate || now;

  await tx.transactions.create({
    data: {
      guid: txGuid,
      currency_guid: currencyGuid,
      num: '',
      post_date: postDate,
      enter_date: now,
      description: `Realized ${gainLoss >= 0 ? 'Gain' : 'Loss'} — Lot ${lotGuid.substring(0, 8)}`,
    },
  });

  // Tag the transaction
  await tx.slots.create({
    data: {
      obj_guid: txGuid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });

  // Investment account split: zero shares, +gainLoss value.
  // The lot's splits sum to basis - proceeds = -gainLoss, so adding a split
  // valued +gainLoss makes the lot total zero after gains.
  const investSplitGuid = generateGuid();
  const investValNum = gainLoss >= 0 ? valFrac.num : -valFrac.num;
  await tx.splits.create({
    data: {
      guid: investSplitGuid,
      tx_guid: txGuid,
      account_guid: lot.account.guid,
      memo: '',
      action: '',
      reconcile_state: 'n',
      value_num: investValNum,
      value_denom: valFrac.denom,
      quantity_num: 0n,
      quantity_denom: BigInt(scu),
      lot_guid: lotGuid,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: investSplitGuid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });

  // Income account split: zero shares, -gainLoss value (opposite of invest
  // split). A gain credits the income account (negative value = income).
  const gainsSplitGuid = generateGuid();
  const gainsValNum = gainLoss >= 0 ? -valFrac.num : valFrac.num;
  await tx.splits.create({
    data: {
      guid: gainsSplitGuid,
      tx_guid: txGuid,
      account_guid: gainsAccountGuid,
      memo: '',
      action: '',
      reconcile_state: 'n',
      value_num: gainsValNum,
      value_denom: valFrac.denom,
      quantity_num: 0n,
      quantity_denom: BigInt(scu),
      lot_guid: null,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: gainsSplitGuid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });

  // Close the lot
  await tx.lots.update({
    where: { guid: lotGuid },
    data: { is_closed: 1 },
  });

  return {
    gainsTransactionGuid: txGuid,
    gainLoss,
    holdingPeriod,
    taxClassification,
  };
}
