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
import { allocateTradeFees, NO_TRADE_FEES, type TradeFeeBySplit } from './trade-fees';
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
// Book boundaries
// ---------------------------------------------------------------------------

/**
 * THE BOOK BOUNDARY. Every upward parent walk in this module stops here.
 *
 * GnuCash accounts carry no book foreign key: an account's book is defined by
 * walking `parent_guid` until an account that some book names as its
 * `root_account_guid` is reached — the same rule assertPostableAccount
 * (@/lib/inventory-engine) enforces for postings. That makes a book root the
 * ONLY structural end of an upward walk, and a root whose `parent_guid` is
 * corrupt (non-null) the ONLY way a walk can leave the book it started in.
 *
 * While the walks were hop-capped, the cap incidentally limited how far such
 * a walk could stray. Uncapping them without this boundary would let one
 * corrupt pointer climb out of Book A and keep reading Book B, which is not
 * a truncated string but a WRONG BOOK's answer:
 *
 *   - classifyAccountTax would find Book B's "Roth IRA" above a Book A
 *     brokerage account and return TAX_EXEMPT for a fully taxable sale —
 *     under-reported tax, presented as correct.
 *   - the gains-account walk would adopt Book B's ROOT and then post Book A's
 *     realized gain into BOOK B's capital-gains account — the cross-book
 *     posting hole this repository has already had once.
 *
 * So the walks stop AT the boundary and never climb past it. The boundary
 * account itself is still read (its own name/commodity are part of its book);
 * only its parent is refused.
 */
interface BookBoundaryNode {
  guid: string;
  parent_guid?: string | null;
  account_type?: string | null;
}

/**
 * The guids that end an upward walk: every book's `root_account_guid`.
 *
 * Queried defensively. Mocked test clients and pre-migration databases may not
 * expose `books.findMany`; an empty set degrades to the structural checks in
 * `isBookBoundary` (a ROOT-typed account, or one with no parent), which is
 * strictly the OLD stopping rule — never a wider walk than before.
 */
async function loadBookRootGuids(db: PrismaTx | typeof prisma): Promise<Set<string>> {
  try {
    const books = await (db as unknown as {
      books: { findMany: (args: unknown) => Promise<Array<{ root_account_guid: string | null }>> };
    }).books.findMany({ select: { root_account_guid: true } });
    return new Set(
      (books ?? [])
        .map(b => b.root_account_guid)
        .filter((guid): guid is string => typeof guid === 'string' && guid.length > 0),
    );
  } catch {
    return new Set();
  }
}

/**
 * True when `node` ends an upward walk: it is a book's root account, it is
 * typed ROOT, or it simply has no parent. Climbing past any of these leaves
 * the book.
 */
function isBookBoundary(node: BookBoundaryNode, bookRoots: ReadonlySet<string>): boolean {
  return !node.parent_guid || node.account_type === 'ROOT' || bookRoots.has(node.guid);
}

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

  // Walk to the BOOK BOUNDARY (see isBookBoundary), and no further.
  //
  // No level cap: BOTH signals this function reads live in the ANCESTORS —
  // the name patterns below, and the explicit is_retirement preference looked
  // up over `walkGuids`. A cap stops the climb before the "Roth IRA" / "401k"
  // ancestor and the account silently reads TAX_NORMAL, so a sheltered sale is
  // booked as taxable and routed to the taxable gains account.
  //
  // But uncapped is only safe because the walk stops at the boundary. The
  // opposite error is the worse one: reading a "Roth IRA" that belongs to
  // ANOTHER BOOK returns TAX_EXEMPT for a fully taxable sale, which
  // under-reports tax. Stopping at the boundary answers TAX_NORMAL there,
  // which is both the conservative answer and the true one for this book.
  //
  // Termination is `seen`, so a corrupt parent cycle closes instead of
  // spinning: every guid is read at most once.
  const bookRoots = await loadBookRootGuids(db);
  const seen = new Set<string>();
  let currentGuid: string | null = accountGuid;
  while (currentGuid && !seen.has(currentGuid)) {
    seen.add(currentGuid);
    const acct: { name: string; parent_guid: string | null; account_type?: string | null } | null =
      await db.accounts.findUnique({
        where: { guid: currentGuid },
        select: { name: true, parent_guid: true, account_type: true },
      });
    if (!acct) break;
    walkGuids.push(currentGuid);
    names.push(acct.name.toLowerCase());
    // The boundary account is read (it belongs to this book); its parent is
    // not (it does not).
    if (isBookBoundary({ guid: currentGuid, ...acct }, bookRoots)) break;
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
// Trade fees (brokerage commissions riding on the lot's own trades)
// ---------------------------------------------------------------------------

/** The account fields the path builder needs, however they were selected. */
interface FeeAccountNode {
  guid: string;
  name: string | null;
  parent_guid: string | null;
  account_type: string | null;
}

/**
 * Build full ":"-joined account paths ("Expenses:Brokerage:Commissions"),
 * root account excluded — the SAME shape buildAccountPathMap
 * (@/lib/reports/utils) hands the Investment Lots report and Form 8949.
 *
 * Fee classification reads the PATH, never the leaf name. Classifying on the
 * bare leaf both drops real fees (a "Schwab" account under
 * "Expenses:Commissions" reads as unrecognized on its own) and, worse, loses
 * the ancestors that carry the DENY words: only the full path can see that
 * "Fees" sits under "Expenses:Brokerage:Interest". Because adding ancestor
 * text can only ADD matches and deny always beats allow, widening leaf ->
 * path can never turn a non-fee into a fee; it can only recover a fee or
 * refuse one. That is the conservative direction.
 */
async function buildFeeAccountPaths(
  seeds: FeeAccountNode[],
  tx: PrismaTx,
): Promise<Map<string, string>> {
  const byGuid = new Map<string, FeeAccountNode>();
  for (const node of seeds) if (node.guid) byGuid.set(node.guid, node);
  const bookRoots = await loadBookRootGuids(tx);

  // Pull in the ancestors the seed rows do not already carry, one level of
  // the chart per round, UP TO THE BOOK BOUNDARY (see isBookBoundary).
  //
  // NO DEPTH CAP, because a cap here does not merely shorten a display
  // string: fee classification reads this path, and the words that REFUSE a
  // charge ("Interest", "Taxes", "Accrued") normally sit HIGH in the chart,
  // near "Expenses" — exactly the part a cap drops first. Truncating the top
  // of "Expenses:Margin Interest:...:Commissions" leaves a path that reads as
  // a plain commission, so a charge that must be expensed is capitalized into
  // COST BASIS instead, with no error and no warning: a wrong gain presented
  // as correct, on a figure that ends up on a tax return. A 30-level chart of
  // accounts is unusual bookkeeping, not corruption, and it must not be
  // silently mis-costed.
  //
  // The lots report and Form 8949 build the SAME path for the same sale with
  // their own walker, buildAccountPathMap (@/lib/reports/utils). Be precise
  // about what that means: the two agree BEHAVIORALLY, not structurally.
  // They are two independent implementations that happen to walk to the book
  // root, and it was exactly such a divergence — a cap here, none there —
  // that reported one sale as a $440 gain in the ledger and a $500 gain on
  // both reports. Nothing in the type system keeps them in step; only
  // 'produces the same path as the report builder' in the test suite does.
  // They cannot simply be merged today: this walker must read through the
  // scrub's own transaction client, while buildAccountPathMap reads the
  // global prisma client and would not see uncommitted rows.
  //
  // Termination is structural rather than numeric. A guid is queried only
  // while it is absent from `byGuid`, and every row returned is inserted, so
  // each account enters at most once and the walk is bounded by the number of
  // accounts in the book. That holds for a corrupt parent CYCLE too: the
  // cycle's accounts are all resolved on the way up, after which nothing is
  // missing and the loop ends. `resolve` below carries its own `seen` set, so
  // a cycle yields a truncated path rather than infinite recursion.
  for (;;) {
    const missing = [...new Set(
      [...byGuid.values()]
        // A boundary account's parent is never fetched: past it lies another
        // book, whose names must not enter this book's fee decision.
        .filter(node => !isBookBoundary(node, bookRoots))
        .map(node => node.parent_guid)
        .filter((guid): guid is string => !!guid && !byGuid.has(guid)),
    )];
    if (missing.length === 0) break;
    const parents = (await tx.accounts.findMany({
      where: { guid: { in: missing } },
      select: { guid: true, name: true, parent_guid: true, account_type: true },
    })) ?? [];
    const before = byGuid.size;
    for (const parent of parents) byGuid.set(parent.guid, parent as FeeAccountNode);
    // Nothing NEW resolved: the outstanding parent guids are dangling
    // references, not a deeper chart. Stop rather than re-issue the same
    // query forever. Checking growth rather than `parents.length` keeps the
    // loop terminating even if a driver ever answered with rows it was not
    // asked for.
    if (byGuid.size === before) break;
  }

  const paths = new Map<string, string>();
  const resolve = (guid: string, seen: Set<string>): string => {
    const cached = paths.get(guid);
    if (cached !== undefined) return cached;
    const node = byGuid.get(guid);
    if (!node || seen.has(guid)) return '';
    // Book roots never appear in a path, and nothing above one is read.
    if (node.account_type === 'ROOT' || bookRoots.has(guid)) {
      paths.set(guid, '');
      return '';
    }
    seen.add(guid);
    const parentPath = node.parent_guid ? resolve(node.parent_guid, seen) : '';
    const own = node.name ?? '';
    const path = parentPath ? `${parentPath}:${own}` : own;
    paths.set(guid, path);
    return path;
  };
  for (const guid of byGuid.keys()) resolve(guid, new Set());
  return paths;
}

/**
 * Allocate the brokerage commissions attached to the trades that produced
 * `lotSplits`, keyed by the security split each one belongs to.
 *
 * EVERY fee decision is delegated to allocateTradeFees (@/lib/trade-fees) —
 * the one classifier the Investment Lots report and Form 8949 also call. This
 * module deliberately owns no fee predicate of its own: a fourth opinion on
 * "what is a fee" is precisely how the ledger and the two reports came to
 * report three different numbers for the same sale.
 */
async function allocateLotTradeFees(
  lotSplits: Array<{ tx_guid?: string | null }>,
  tx: PrismaTx,
): Promise<TradeFeeBySplit> {
  const txGuids = [...new Set(
    lotSplits
      .map(split => split.tx_guid)
      .filter((guid): guid is string => typeof guid === 'string' && guid.length > 0),
  )];
  if (txGuids.length === 0) return NO_TRADE_FEES;

  const rows = (await tx.splits.findMany({
    where: { tx_guid: { in: txGuids } },
    include: {
      account: { select: { guid: true, name: true, parent_guid: true, account_type: true } },
      transaction: { select: { post_date: true, description: true } },
    },
  })) ?? [];
  // No expense leg means there is no charge to classify at all, so skip the
  // ancestor walk rather than paying for paths nothing will read.
  if (!rows.some(split => split.account?.account_type === 'EXPENSE')) return NO_TRADE_FEES;

  const paths = await buildFeeAccountPaths(
    rows.map(split => ({
      guid: split.account_guid,
      name: split.account?.name ?? null,
      parent_guid: split.account?.parent_guid ?? null,
      account_type: split.account?.account_type ?? null,
    })),
    tx,
  );

  return allocateTradeFees(rows.map(split => ({
    guid: split.guid,
    txGuid: split.tx_guid,
    accountGuid: split.account_guid,
    accountType: split.account?.account_type ?? '',
    accountPath: paths.get(split.account_guid) || split.account?.name || '',
    value: toDecimalNumber(split.value_num, split.value_denom),
    quantity: toDecimalNumber(split.quantity_num, split.quantity_denom),
    txDescription: split.transaction?.description ?? undefined,
    txDate: split.transaction?.post_date?.toISOString(),
  }))).fees;
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
 * Slot naming the source-lot OUTFLOW SPLIT a destination lot's basis left on,
 * alongside the `source_lot_guid` that names the lot itself.
 *
 * A source lot can send shares out several times, and each outflow's slice
 * depends on where it falls in the lot's outflow order — so re-deriving those
 * slices (reconcileCarriedBasisForSourceLots) needs to know which destination
 * lot belongs to which outflow, not merely to which source lot. Both revert
 * paths delete it with the rest of a generated lot's slots.
 */
const SOURCE_SPLIT_SLOT = 'source_split_guid';

/**
 * The `carried_basis` slot stores a decimal string with six-decimal
 * resolution, so basis is apportioned in integer millionths.
 */
const BASIS_UNITS_PER_DOLLAR = 1e6;

/** Quantize a basis amount to the slot's stored resolution (integer millionths). */
function toBasisUnits(amount: number): number {
  return Math.round(amount * BASIS_UNITS_PER_DOLLAR);
}

/**
 * Apportion a source lot's basis to ONE outflow of `shares`, given the shares
 * that already left the lot ahead of it.
 *
 * Rounding each outflow's own pro-rata slice independently duplicates or loses
 * fractions of a cent, and the slot only holds six decimals: 50,000 shares
 * bought for $50,000.00 plus a $0.03 commission carry $1.0000006 each, which
 * every destination lot rounds up to $1.000001 — $50,000.05 of stored basis
 * against the $50,000.03 actually paid, so a later sale of all of them
 * understates the aggregate gain by $0.02.
 *
 * So round the CUMULATIVE allocation and hand each outflow the difference — a
 * running-residual carry. The differences telescope, so the apportioned
 * amounts sum to exactly the quantized source basis once the lot has drained,
 * however many outflows it took and however the per-share figure rounds.
 */
export function apportionCarriedBasis(params: {
  /** The source lot's whole basis: buy cost + capitalized fees + basis carried in. */
  totalBasis: number;
  /** Shares that entered the source lot. */
  boughtShares: number;
  /** Shares that left the lot ahead of this outflow (sales included). */
  sharesOutBefore: number;
  /** Shares leaving in this outflow. */
  shares: number;
}): number {
  const { totalBasis, boughtShares, sharesOutBefore, shares } = params;
  if (!(boughtShares > 0) || !(shares > 0)) return 0;

  const totalUnits = toBasisUnits(totalBasis);
  // Shares are summed from fractions, so "drained" needs a tolerance; at this
  // scale it is far below the smallest share GnuCash can represent.
  const drainedEpsilon = Math.max(1e-9, boughtShares * 1e-12);
  const cumulativeUnitsAt = (sharesOut: number): number => {
    if (sharesOut <= 0) return 0;
    // Draining the lot yields the WHOLE basis, never a rounded fraction of it.
    if (sharesOut >= boughtShares - drainedEpsilon) return totalUnits;
    return Math.round(totalUnits * (sharesOut / boughtShares));
  };

  const before = Math.min(Math.max(sharesOutBefore, 0), boughtShares);
  const after = Math.min(before + shares, boughtShares);
  return (cumulativeUnitsAt(after) - cumulativeUnitsAt(before)) / BASIS_UNITS_PER_DOLLAR;
}

/** Lexicographic string compare, for the tiebreak chains below. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The fields the outflow ordering reads, however the caller selected them. */
export interface LotOutflowInput {
  guid: string;
  tx_guid?: string | null;
  quantity_num: bigint;
  quantity_denom: bigint;
  transaction?: { post_date: Date | null } | null;
}

/** One outflow of a source lot, in the canonical order. */
export interface LotOutflow {
  guid: string;
  txGuid: string;
  postedAt: number;
  /** Shares leaving, as a positive magnitude. */
  shares: number;
}

/**
 * A source lot's outflows in a STABLE TOTAL ORDER.
 *
 * This order decides which outflow receives the residual millionth of the
 * lot's basis (see apportionCarriedBasis), so it must be a function of data
 * that survives a revert-and-re-scrub — otherwise selling one specific lot
 * yields a different taxable gain depending on scrub history alone.
 *
 * Split GUIDs do NOT survive: splitSellAcrossLots repartitions an outflow that
 * spans several lots into sub-splits with FRESHLY GENERATED guids, so a
 * guid-keyed order shuffles on every re-scrub. The keys, in order:
 *
 *   1. transaction post date — the economic order of the outflows;
 *   2. tx_guid — the outflow's transaction is the user's own row and is never
 *      regenerated by the engine (sub-splits inherit their parent's tx_guid),
 *      so this is stable across revert-and-re-scrub;
 *   3. shares descending — separates two outflows of one transaction out of
 *      one lot, which the engine itself never produces (each sub-split of a
 *      repartitioned outflow lands in a DIFFERENT lot) but a hand-edited book
 *      can hold;
 *   4. split guid — last resort, reachable only for outflows identical in date,
 *      transaction AND size.
 *
 * WHAT KEY 4 DOES AND DOES NOT GUARANTEE. Being last resort, it is the one key
 * that is not stable across a revert-and-re-scrub, so its limits are worth
 * stating exactly rather than waving at.
 *
 * Guaranteed. The keys ahead of it — date, tx_guid, shares — are all stable
 * (tx_guid in particular survives, because a repartitioned outflow's sub-splits
 * inherit their parent's tx_guid), so key 4 is never consulted unless the
 * outflows it is separating agree on all three. Whatever permutation it picks,
 * the MULTISET of slices apportioned out of the source lot is the same, because
 * apportionCarriedBasis derives each slice from the cumulative shares ahead of
 * it and these outflows are the same size. So the source lot's basis is fully
 * conserved, and any figure that aggregates over the whole set — the account's
 * total basis, its total realized gain, the Form 8949 total — is unaffected by
 * which permutation was chosen.
 *
 * NOT guaranteed. The slices in that multiset are not necessarily equal: when
 * the source basis does not divide evenly, one of them carries the residual
 * millionth. Two same-date, same-transaction, same-size outflows can land in
 * DISTINCT destination lots, and those lots can later be disposed of
 * separately — different years, different holding periods, one sold and one
 * held. Which of them carries the residual therefore does affect an INDIVIDUAL
 * lot's reported basis and its individual taxable gain, and a re-scrub can move
 * it between them. The slices are interchangeable in aggregate, NOT per lot.
 *
 * Why that is acceptable here rather than merely tolerated: reaching key 4 at
 * all requires a book the engine does not produce (see key 3), the two outflows
 * differ by at most one millionth of a dollar, and no total moves. The
 * regression this ordering exists to fix — a FRESHLY GENERATED guid reshuffling
 * ordinary engine-produced outflows on every scrub, moving whole slices between
 * lots — is fixed by keys 1-3, which never fall through to here.
 */
export function orderLotOutflows(splits: LotOutflowInput[]): LotOutflow[] {
  return splits
    .map(s => ({
      guid: s.guid,
      txGuid: s.tx_guid ?? '',
      postedAt: s.transaction?.post_date ? new Date(s.transaction.post_date).getTime() : 0,
      shares: -toDecimalNumber(s.quantity_num, s.quantity_denom),
    }))
    .filter(o => o.shares > 0)
    .sort((a, b) =>
      a.postedAt - b.postedAt
      || cmpStr(a.txGuid, b.txGuid)
      || (b.shares - a.shares)
      || cmpStr(a.guid, b.guid));
}

/**
 * Shares that left the source lot ahead of `splitGuid`, in the lot's own
 * outflow order (see orderLotOutflows).
 *
 * Every outflow counts, sale or transfer: each consumes its slice of the lot's
 * basis, so a transfer that follows a sale starts where the sale left off
 * rather than back at zero.
 *
 * An outflow that is not in the lot (an unlotted source split, or a caller
 * that has no split to name) reads as the first one — the pre-existing
 * straight pro-rata behavior.
 */
function sharesOutBeforeSplit(splits: LotOutflowInput[], splitGuid?: string): number {
  if (!splitGuid) return 0;
  let sharesOut = 0;
  for (const outflow of orderLotOutflows(splits)) {
    if (outflow.guid === splitGuid) return sharesOut;
    sharesOut += outflow.shares;
  }
  return 0;
}

/**
 * Compute the cost basis carried by `transferredShares` leaving a source lot:
 * that outflow's slice of (buy cost + the source lot's own carried basis),
 * apportioned over the shares that entered the lot. Chains correctly across
 * repeated transfers — a scrub-created destination lot has one transfer-in
 * split plus a carried_basis slot, so its basis-per-share is
 * carried_basis / shares. A recorded transfer value is not purchase cost and
 * must not create a step-up.
 *
 * Pass `sourceSplitGuid` (the transfer-out split this basis is leaving on) so
 * repeated partial transfers out of one lot conserve the basis exactly rather
 * than each rounding their own slice — see apportionCarriedBasis.
 *
 * Returns null when the source lot has no incoming shares to derive a basis
 * from (nothing to carry).
 */
export async function computeCarriedBasis(
  sourceLotGuid: string,
  transferredShares: number,
  tx: PrismaTx,
  sourceSplitGuid?: string,
): Promise<number | null> {
  const source = await readSourceLotBasis(sourceLotGuid, tx);
  if (!source) return null;
  return apportionCarriedBasis({
    totalBasis: source.totalBasis,
    boughtShares: source.boughtShares,
    sharesOutBefore: sharesOutBeforeSplit(source.splits, sourceSplitGuid),
    shares: transferredShares,
  });
}

/** A source lot's split, as the basis apportionment reads it. */
interface SourceLotSplit extends LotOutflowInput {
  value_num: bigint;
  value_denom: bigint;
}

/** Everything the apportionment needs about one source lot, read once. */
interface SourceLotBasis {
  /** buy cost + capitalized trade fees + basis carried in from an earlier transfer. */
  totalBasis: number;
  /** Shares that entered the lot. */
  boughtShares: number;
  /** The lot's own splits, for the outflow ordering. */
  splits: SourceLotSplit[];
}

/**
 * Read a source lot's whole basis and the shares it was acquired with.
 *
 * Fee classification runs on the FULL account path, exactly as it does on the
 * Investment Lots and Form 8949 paths. This used to pass the bare leaf name,
 * which silently dropped every commission whose account is named for the
 * broker rather than the charge ("Expenses:Commissions:Schwab") and left the
 * carried basis short by that amount on transfer.
 *
 * Returns null when nothing entered the lot, so there is no basis to carry.
 */
async function readSourceLotBasis(
  sourceLotGuid: string,
  tx: PrismaTx,
): Promise<SourceLotBasis | null> {
  const sourceLotSplits = (await tx.splits.findMany({
    where: { lot_guid: sourceLotGuid },
    select: {
      guid: true,
      tx_guid: true,
      quantity_num: true,
      quantity_denom: true,
      value_num: true,
      value_denom: true,
      transaction: { select: { post_date: true } },
    },
  })) ?? [];
  const allocatedFees = await allocateLotTradeFees(sourceLotSplits, tx);
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
          + (allocatedFees.get(s.guid) ?? 0);
      }
    }
  }
  if (boughtShares <= 0) return null;
  const carried = await readCarriedBasis(sourceLotGuid, tx);
  return { totalBasis: buyCost + carried, boughtShares, splits: sourceLotSplits };
}

/**
 * The `carried_basis` slot's stored text for an amount, or null when there is
 * no basis to store.
 *
 * apportionCarriedBasis already hands over a whole number of millionths, so
 * quantizing here is a no-op on that path and only guards a hand-built caller.
 */
function carriedBasisSlotValue(carriedBasis: number | null): string | null {
  if (carriedBasis === null || !(Math.abs(carriedBasis) > 0)) return null;
  return String(toBasisUnits(carriedBasis) / BASIS_UNITS_PER_DOLLAR);
}

/**
 * Store the carried basis on a destination lot as a `carried_basis` slot,
 * tagged like the other transfer-metadata slots.
 *
 * REPLACES any slot already there rather than adding a second one: a
 * destination lot's slice is re-derived whenever the source lot's outflow set
 * changes (see reconcileCarriedBasisForSourceLots), and readCarriedBasis takes
 * the first row it finds. A null/0 basis leaves the lot with no slot at all.
 */
async function writeCarriedBasisSlot(
  lotGuid: string,
  carriedBasis: number | null,
  tx: PrismaTx,
): Promise<void> {
  await tx.slots.deleteMany({ where: { obj_guid: lotGuid, name: 'carried_basis' } });
  const stored = carriedBasisSlotValue(carriedBasis);
  if (stored === null) return;
  await tx.slots.create({
    data: {
      obj_guid: lotGuid,
      name: 'carried_basis',
      slot_type: 4,
      string_val: stored,
    },
  });
}

/** A destination lot whose `carried_basis` slot this reconcile pass rewrote. */
export interface ReconciledDestinationLot {
  lotGuid: string;
  accountGuid: string | null;
  carriedBasis: number;
}

/**
 * Re-apportion each named source lot's basis over its WHOLE outflow set and
 * rewrite every destination lot's `carried_basis` accordingly.
 *
 * Why this exists. apportionCarriedBasis conserves basis by rounding the
 * CUMULATIVE allocation, so an outflow's slice depends on the shares that left
 * ahead of it. Computing a slice once, at the moment its transfer is linked,
 * only conserves while outflows arrive in date order. Routine bookkeeping
 * breaks that: a BACKDATED transfer (or sale) inserted later moves ahead of
 * outflows already apportioned, shifting every slice behind it. Left alone,
 * the stored slices no longer sum to the source basis — a $1,000.01 lot drifts
 * to $1,000.010001 of stored basis and the eventual full sale understates the
 * gain by the difference.
 *
 * So the slices are never treated as final: any pass that can have changed a
 * lot's outflow set re-derives all of them from the current set. The walk is
 * the same running-residual carry, which makes the write idempotent — a lot
 * whose slice is unchanged is not rewritten, and the returned list holds only
 * the lots that actually moved.
 *
 * Destination lots are found by their `source_lot_guid` slot and matched to
 * their outflow by `source_split_guid`. Lots written before that slot existed
 * are matched by the transaction their transfer-in sits on, which identifies
 * the outflow just as well: the engine never puts two outflows of one
 * transaction into one lot.
 */
export async function reconcileCarriedBasisForSourceLots(
  sourceLotGuids: string[],
  tx: PrismaTx,
): Promise<ReconciledDestinationLot[]> {
  // Transfers chain: a destination lot whose basis just moved is itself the
  // source of any onward transfer, and that lot's slices are derived from the
  // basis this pass rewrote. Follow the chain from each rewritten lot rather
  // than leaving the far end stale until its own account is next scrubbed.
  //
  // WALKED TO EXHAUSTION, with `visited` as the ONLY termination condition.
  // There is deliberately no hop limit. A depth cap here would silently stop
  // partway down a long A -> B -> C -> ... chain and leave every lot beyond it
  // holding a stale carried basis, with no error and no signal: a wrong cost
  // basis presented as correct, on a figure that ends up on a tax return. A
  // chain of 30 accounts is unusual bookkeeping but it is not corruption, and
  // it must not be silently mis-costed.
  //
  // Termination is structural rather than numeric. Every lot enters `frontier`
  // at most once — each iteration adds its whole frontier to `visited` and the
  // next frontier is filtered against it — so `visited` grows by at least one
  // lot per iteration and is bounded by the number of lots in the book. That
  // holds for a corrupted source_lot_guid CYCLE too: the cycle's lots are all
  // visited on the way in, so the walk closes instead of looping. It also stops
  // a diamond (two source lots feeding one destination) being walked twice.
  const rewritten: ReconciledDestinationLot[] = [];
  const visited = new Set<string>();
  let frontier = [...new Set(sourceLotGuids.filter(Boolean))];
  while (frontier.length > 0) {
    frontier.forEach(guid => visited.add(guid));
    const level = await reconcileOneTransferLevel(frontier, tx);
    rewritten.push(...level);
    frontier = [...new Set(level.map(l => l.lotGuid))].filter(guid => !visited.has(guid));
  }
  return rewritten;
}

/** One transfer hop of reconcileCarriedBasisForSourceLots. */
async function reconcileOneTransferLevel(
  sourceLotGuids: string[],
  tx: PrismaTx,
): Promise<ReconciledDestinationLot[]> {
  const wanted = [...new Set(sourceLotGuids.filter(Boolean))].sort();
  if (wanted.length === 0) return [];

  const linkSlots = (await tx.slots.findMany({
    where: { name: 'source_lot_guid', string_val: { in: wanted } },
    select: { obj_guid: true, string_val: true },
  })) ?? [];
  if (linkSlots.length === 0) return [];

  const destBySource = new Map<string, string[]>();
  for (const slot of linkSlots) {
    if (!slot.string_val) continue;
    const dests = destBySource.get(slot.string_val) ?? [];
    dests.push(slot.obj_guid);
    destBySource.set(slot.string_val, dests);
  }
  const destLotGuids = [...new Set(linkSlots.map(s => s.obj_guid))];

  const destLots = (await tx.lots.findMany({
    where: { guid: { in: destLotGuids } },
    select: { guid: true, account_guid: true },
  })) ?? [];
  const accountOfLot = new Map(destLots.map(l => [l.guid, l.account_guid ?? null]));

  const sourceSplitSlots = (await tx.slots.findMany({
    where: { name: SOURCE_SPLIT_SLOT, obj_guid: { in: destLotGuids } },
    select: { obj_guid: true, string_val: true },
  })) ?? [];
  const sourceSplitOfLot = new Map<string, string>();
  for (const slot of sourceSplitSlots) {
    if (slot.string_val) sourceSplitOfLot.set(slot.obj_guid, slot.string_val);
  }

  // Legacy destination lots (written before source_split_guid existed) are
  // placed by the transaction their transfer-in sits on.
  const txOfLegacyLot = new Map<string, string>();
  const legacyLotGuids = destLotGuids.filter(g => !sourceSplitOfLot.has(g));
  if (legacyLotGuids.length > 0) {
    const inSplits = (await tx.splits.findMany({
      where: { lot_guid: { in: legacyLotGuids } },
      select: {
        lot_guid: true, tx_guid: true, quantity_num: true, quantity_denom: true,
      },
    })) ?? [];
    for (const s of inSplits) {
      if (!s.lot_guid || !s.tx_guid || txOfLegacyLot.has(s.lot_guid)) continue;
      if (toDecimalNumber(s.quantity_num, s.quantity_denom) <= 0) continue;
      txOfLegacyLot.set(s.lot_guid, s.tx_guid);
    }
  }

  const storedSlots = (await tx.slots.findMany({
    where: { name: 'carried_basis', obj_guid: { in: destLotGuids } },
    select: { obj_guid: true, string_val: true },
  })) ?? [];
  const storedOfLot = new Map<string, string | null>();
  for (const slot of storedSlots) {
    if (!storedOfLot.has(slot.obj_guid)) storedOfLot.set(slot.obj_guid, slot.string_val ?? null);
  }

  const rewritten: ReconciledDestinationLot[] = [];
  for (const sourceLotGuid of wanted) {
    const dests = destBySource.get(sourceLotGuid);
    if (!dests || dests.length === 0) continue;
    const source = await readSourceLotBasis(sourceLotGuid, tx);
    if (!source) continue;

    const lotBySourceSplit = new Map<string, string>();
    const lotByTx = new Map<string, string>();
    for (const destLotGuid of dests) {
      const sourceSplitGuid = sourceSplitOfLot.get(destLotGuid);
      if (sourceSplitGuid) {
        lotBySourceSplit.set(sourceSplitGuid, destLotGuid);
        continue;
      }
      const txGuid = txOfLegacyLot.get(destLotGuid);
      if (txGuid && !lotByTx.has(txGuid)) lotByTx.set(txGuid, destLotGuid);
    }

    let sharesOut = 0;
    for (const outflow of orderLotOutflows(source.splits)) {
      const slice = apportionCarriedBasis({
        totalBasis: source.totalBasis,
        boughtShares: source.boughtShares,
        sharesOutBefore: sharesOut,
        shares: outflow.shares,
      });
      sharesOut += outflow.shares;

      const destLotGuid = lotBySourceSplit.get(outflow.guid) ?? lotByTx.get(outflow.txGuid);
      if (!destLotGuid) continue;
      const next = carriedBasisSlotValue(slice);
      if ((storedOfLot.get(destLotGuid) ?? null) === next) continue;

      await writeCarriedBasisSlot(destLotGuid, slice, tx);
      storedOfLot.set(destLotGuid, next);
      rewritten.push({
        lotGuid: destLotGuid,
        accountGuid: accountOfLot.get(destLotGuid) ?? null,
        carriedBasis: slice,
      });
    }
  }
  return rewritten;
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

    // Name the outflow this lot's shares left on, so its basis slice can be
    // re-derived when the source lot's outflow set changes underneath it.
    await tx.slots.create({
      data: {
        obj_guid: lotGuid,
        name: SOURCE_SPLIT_SLOT,
        slot_type: 4,
        string_val: sourceSplit.guid,
      },
    });

    // Carry original basis for every own-account transfer. A recorded value
    // is not a taxable disposition and must not step up the destination lot.
    // This is the slice as of THIS outflow's place in the source lot's order;
    // the reconcile pass at the end re-derives it (and every sibling's) once
    // the lot exists, which is what keeps the total conserved when a later
    // backdated outflow moves ahead of it.
    const transferQty = toDecimalNumber(split.quantity_num, split.quantity_denom);
    if (transferQty > 0) {
      const carried = await computeCarriedBasis(
        sourceSplit.lot_guid, transferQty, tx, sourceSplit.guid,
      );
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

  // Apportion the source lot's basis over its WHOLE outflow set, this new one
  // included. Writing only this lot's slice would conserve basis solely while
  // transfers are linked in date order; a backdated one moves ahead of slices
  // already stored — see reconcileCarriedBasisForSourceLots.
  if (sourceSplit?.lot_guid) {
    await reconcileCarriedBasisForSourceLots([sourceSplit.lot_guid], tx);
  }

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

  // Filter to only those with lot_guid, in the canonical outflow order. The
  // order decides which source lot the original split (rather than a generated
  // sub-split) is assigned to and which allocation absorbs the share
  // remainder, so it must not be left to however the driver returned the rows.
  //
  // These all share one transaction, so they are separated by size. Two source
  // lots contributing EXACTLY equal shares to one transfer still fall through
  // to the guid tiebreak; that only moves a sub-cent quantity remainder
  // between two equal-sized destination lots, and never the carried basis,
  // which each lot derives from its own source lot's outflow order.
  const lottedSourceSplits = orderLotOutflows(sourceSplits.filter(s => s.lot_guid !== null))
    .map(o => sourceSplits.find(s => s.guid === o.guid)!)
    .filter(Boolean);

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
    /** The transfer-out split this allocation draws from, for basis apportionment. */
    sourceSplitGuid: string;
    shares: number;
  }
  const totalSourceQty = lottedSourceSplits.reduce(
    (sum, s) => sum + Math.abs(toDecimalNumber(s.quantity_num, s.quantity_denom)), 0,
  );

  const allocations: Allocation[] = lottedSourceSplits.map(s => ({
    sourceLotGuid: s.lot_guid!,
    sourceSplitGuid: s.guid,
    shares: (Math.abs(toDecimalNumber(s.quantity_num, s.quantity_denom)) / totalSourceQty) * transferQty,
  }));

  // Helper: create a destination lot for a source lot
  async function createDestLot(
    sourceLotGuid: string,
    postDate: Date | null | undefined,
    allocShares: number,
    sourceSplitGuid: string,
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

    // Name the outflow this lot's shares left on, then carry that outflow's
    // basis slice (see linkTransferToLot — same rule, per source lot here).
    // The reconcile pass at the end of this function re-derives every slice
    // once all the destination lots exist.
    await tx.slots.create({
      data: {
        obj_guid: lotGuid,
        name: SOURCE_SPLIT_SLOT,
        slot_type: 4,
        string_val: sourceSplitGuid,
      },
    });

    if (allocShares > 0) {
      const carried = await computeCarriedBasis(sourceLotGuid, allocShares, tx, sourceSplitGuid);
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
  const firstLotGuid = await createDestLot(
    firstAlloc.sourceLotGuid, split.transaction?.post_date, firstAlloc.shares, firstAlloc.sourceSplitGuid,
  );
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
    const lotGuid = await createDestLot(
      alloc.sourceLotGuid, split.transaction?.post_date, alloc.shares, alloc.sourceSplitGuid,
    );
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

  // Every destination lot now exists and names its outflow, so apportion each
  // source lot's basis over its whole outflow set at once — the one place the
  // conservation invariant is enforced.
  await reconcileCarriedBasisForSourceLots(allocations.map(a => a.sourceLotGuid), tx);

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
 * Commissions: the classified trade fees of the lot's own trades
 * (@/lib/trade-fees, the same allocator both money reports call) are netted
 * into the booked figure, so the Income:Capital Gains entry equals what the
 * Investment Lots report and Form 8949 report for the same sale. NOTE the
 * bookkeeping consequence: the adjusting split now carries the NET gain, so a
 * fully-sold lot's investment account retains a residual value equal to the
 * capitalized fee, mirroring the commission that is still sitting in its
 * expense account. That is the deliberate trade: the gains ACCOUNT agrees
 * with the tax forms, which is the figure users reconcile against, and the
 * tax aggregation already withholds those same expense splits from its
 * deduction sums (capitalizedFeeSplitGuids) so the dollar is counted once.
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

  // ── Brokerage commissions ────────────────────────────────────────────────
  // A commission is booked as a separate EXPENSE split of the trade, so the
  // lot's own splits cannot see it and the gain derived from them alone is
  // GROSS. Both money reports net it (IRS Pub. 550: a buy-side commission is
  // capitalized into basis, a sell-side one reduces the amount realized), so
  // booking the gross figure here made the ledger disagree with both of them
  // about the same sale. Recovered through the SAME allocator they call.
  const tradeFees = await allocateLotTradeFees(lot.splits, tx);
  const feeOf = (split: { guid: string }) => tradeFees.get(split.guid) ?? 0;

  // ── Calculate gain/loss ──────────────────────────────────────────────────
  // Native GnuCash sign convention: a buy split has POSITIVE value (debit)
  // and a sell split NEGATIVE value (credit), so the lot's splits sum to
  // basis - proceeds and gain = -(sum). That legacy form only holds when every
  // consumed share was SOLD and no basis was carried in from a transfer;
  // otherwise realize the sold shares' pro-rata share of the total basis
  // (buy cost + carried_basis). Either way a fee moves the value toward the
  // positive, so it shrinks the gain by its own amount — the identical rule
  // computeRealizedGain (@/lib/lots) and lotToRealizedSales
  // (@/lib/reports/capital-gains) apply.
  const carriedBasis = await readCarriedBasis(lotGuid, tx);
  const soldShares = sellSplits.reduce(
    (sum, s) => sum + Math.abs(toDecimalNumber(s.quantity_num, s.quantity_denom)), 0,
  );
  // GROSS proceeds answer "is this a disposal at all?" (the zero-proceeds
  // guard below); the fee-netted figure is what the gain is computed from. A
  // fee must never be what makes a real sale look like a $0 non-event — that
  // would silently delete a worthless-security write-off's deduction — nor
  // what promotes a $0 transfer into a reportable sale. Same split of duties
  // as lotToRealizedSales.
  const grossSaleProceeds = -sellSplits.reduce(
    (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom), 0,
  );
  const saleProceeds = grossSaleProceeds - sellSplits.reduce(
    (sum, s) => sum + feeOf(s), 0,
  );

  let gainLoss: number;
  if (transferOutSplits.length === 0 && Math.abs(carriedBasis) < 0.005) {
    gainLoss = -lot.splits.reduce(
      (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom),
      0,
    ) - lot.splits.reduce((sum, s) => sum + feeOf(s), 0);
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
        : Math.abs(toDecimalNumber(s.value_num, s.value_denom)))
        + feeOf(s),
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
  if (soldShares > qtyEps && Math.abs(grossSaleProceeds) < 0.005) {
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
  // Every upward walk below stops here. A realized gain must be posted inside
  // the lot's OWN book; see isBookBoundary.
  const bookRoots = await loadBookRootGuids(tx);

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
    // Walk up the investment account's ancestors, to the BOOK BOUNDARY and no
    // further, and use the first account whose commodity is a currency.
    //
    // No level cap. Correcting an earlier comment here, which claimed an
    // overrun "fails loudly": it does not, and it never did. Overrunning the
    // old 20-level cap left currencyGuid null and fell through to the
    // most-common-currency fallback below, which SILENTLY denominates the
    // generated gains transaction in whichever currency happens to appear on
    // the most accounts book-wide — EUR for a USD trade in a mostly-EUR book.
    // That is a wrong number written into the ledger with no error, which is
    // why the cap had to go. `seenAncestors` is the termination condition, so
    // a corrupt parent cycle closes instead of spinning.
    const seenAncestors = new Set<string>();
    let ancestorGuid = lot.account.parent_guid;
    while (ancestorGuid && !currencyGuid && !seenAncestors.has(ancestorGuid)) {
      seenAncestors.add(ancestorGuid);
      const ancestor = accountsByGuid.get(ancestorGuid);
      if (!ancestor) break;
      const commodity = await getCommodity(ancestor.commodity_guid);
      if (ancestor.commodity_guid && commodity?.namespace === 'CURRENCY') {
        currencyGuid = ancestor.commodity_guid;
        currencyFraction = commodity.fraction || 100;
      }
      // The boundary account's own commodity counts (checked above); anything
      // above it belongs to another book and must not denominate this one.
      if (isBookBoundary(ancestor, bookRoots)) break;
      ancestorGuid = ancestor.parent_guid;
    }

    if (!currencyGuid) {
      // Last resort, and a SILENT one: the most-common CURRENCY commodity
      // across accounts (deterministic: account count desc, then guid). It is
      // reachable only when neither the transaction nor any ancestor up to the
      // book root names a currency, which a sound book cannot produce — a
      // GnuCash root account always carries one.
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
  // Walk up from the lot's account to the BOOK BOUNDARY — the root of the book
  // this lot actually lives in, and the only book its gain may be posted into.
  //
  // No hop cap: a cap silently disowned a deeply filed security account from
  // its own book, and the old fallback then answered with whichever book came
  // FIRST out of the table. Correcting the earlier comment here, that fallback
  // never failed loudly either; it quietly adopted a stranger's root, and with
  // more than one book on the connection it was a coin flip. Book A's realized
  // gain then landed in BOOK B's capital-gains account.
  //
  // Termination is the `seen` set — a corrupt parent cycle closes instead of
  // looping — and the boundary check keeps a corrupt root pointer from
  // climbing on into the next book.
  let rootGuid: string | null = null;
  {
    const seen = new Set<string>();
    let cursor = accountsByGuid.get(lot.account.guid) ?? null;
    while (cursor && !seen.has(cursor.guid)) {
      seen.add(cursor.guid);
      if (isBookBoundary(cursor, bookRoots)) {
        rootGuid = cursor.guid;
        break;
      }
      cursor = accountsByGuid.get(cursor.parent_guid!) ?? null;
    }
  }
  if (!rootGuid) {
    // The chain cycles, or dangles on a missing account: this lot's book is
    // genuinely unknown. Refuse LOUDLY. Guessing (the old behaviour: take the
    // first book's root) posts a realized gain into a book chosen at random,
    // which is silently wrong money in someone else's ledger — strictly worse
    // than a scrub that stops and says so.
    throw new Error(
      `Cannot determine book root for gains transaction: the parent chain above account `
      + `${lot.account.guid} does not reach a book root (broken or cyclic parent_guid).`,
    );
  }

  // Build a fullname (root excluded, ":"-joined) plus the root it belongs to.
  //
  // No hop cap, for the same reason buildFeeAccountPaths has none: the walk
  // climbs, so a cap drops the TOP of the fullname — and the top is what the
  // matching below reads. A truncated fullname loses the book root (so the
  // account is filtered out of its own book and a DUPLICATE gains account is
  // created beside it) and loses the "Tax-Deferred" ancestor (so a sheltered
  // sale can be booked to the taxable gains account). It stops at the BOOK
  // BOUNDARY, so the `root` it reports is the account's real owning book and
  // the caller's `c.root !== rootGuid` filter is a true book test rather than
  // a wherever-the-chain-ended test. Termination is the `seen` set, so a
  // corrupt parent cycle closes rather than looping (reporting root null,
  // which the filter then rejects).
  const fullnameOf = (guid: string): { fullname: string; root: string | null } => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = accountsByGuid.get(guid) ?? null;
    let root: string | null = null;
    while (cur && !seen.has(cur.guid)) {
      seen.add(cur.guid);
      if (isBookBoundary(cur, bookRoots)) {
        root = cur.guid;
        break;
      }
      parts.unshift(cur.name);
      cur = accountsByGuid.get(cur.parent_guid!) ?? null;
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
    gainsAccountGuid = await findOrCreateAccount(gainsAccountPath, rootGuid, currencyGuid, tx);
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
