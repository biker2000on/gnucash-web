/**
 * Lot Scrub Engine
 *
 * Implements GnuCash-compatible scrub algorithms:
 * 1. splitSellAcrossLots — split a sell across multiple lots when it exceeds one lot's balance
 * 2. linkTransferToLot — create destination lots for share transfers with metadata linking
 * 3. generateCapitalGains — create double-balance gains transactions for closed lots
 *
 * Also provides helpers:
 * - classifyAccountTax — determine TAX_NORMAL / TAX_DEFERRED / TAX_EXEMPT
 * - classifyHoldingPeriod — short_term vs long_term (1-year threshold)
 */

import prisma from './prisma';
import { generateGuid, toDecimalNumber, fromDecimal, findOrCreateAccount } from './gnucash';

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
  openDate: Date | null;
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
 * Uses a 1-year (365-day) threshold.
 */
export function classifyHoldingPeriod(openDate: Date, closeDate: Date): HoldingPeriod {
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const held = closeDate.getTime() - openDate.getTime();
  return held > oneYearMs ? 'long_term' : 'short_term';
}

// ---------------------------------------------------------------------------
// classifyAccountTax
// ---------------------------------------------------------------------------

/**
 * Walk the account hierarchy upward to determine tax classification.
 * Checks account names for IRA/401k/Roth/HSA patterns.
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

  let currentGuid: string | null = accountGuid;
  // Walk up to 20 levels to avoid infinite loops
  for (let i = 0; i < 20 && currentGuid; i++) {
    const acct: { name: string; parent_guid: string | null } | null =
      await db.accounts.findUnique({
        where: { guid: currentGuid },
        select: { name: true, parent_guid: true },
      });
    if (!acct) break;
    names.push(acct.name.toLowerCase());
    currentGuid = acct.parent_guid;
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
 * **IMPORTANT**: Mutates `openLots[].shares` in-place to reflect consumption.
 *
 * @param sellSplitGuid - GUID of the original sell split
 * @param openLots - Open lots sorted in consumption order (FIFO/LIFO). `.shares` is mutated.
 * @param runId - Unique run identifier for tagging generated entities
 * @param tx - Prisma transaction client
 * @returns SplitSellResult with sub-splits created and lots used
 */
export async function splitSellAcrossLots(
  sellSplitGuid: string,
  openLots: OpenLot[],
  runId: string,
  tx: PrismaTx,
): Promise<SplitSellResult> {
  // Fetch the original sell split
  const sellSplit = await tx.splits.findUnique({
    where: { guid: sellSplitGuid },
  });
  if (!sellSplit) {
    throw new Error(`Sell split not found: ${sellSplitGuid}`);
  }

  const sellQty = toDecimalNumber(sellSplit.quantity_num, sellSplit.quantity_denom); // negative
  const sellVal = toDecimalNumber(sellSplit.value_num, sellSplit.value_denom);       // positive
  const remainingSell = Math.abs(sellQty);

  if (remainingSell < 0.0001) {
    return { subSplitsCreated: [], lotsUsed: [], warning: 'Sell quantity is zero' };
  }

  // Filter lots with shares > 0
  const availableLots = openLots.filter(l => l.shares > 0.0001);

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
    if (leftToSell < 0.0001) break;
    const take = Math.min(lot.shares, leftToSell);
    allocations.push({ lot, shares: take });
    leftToSell -= take;
  }

  const warning = leftToSell > 0.0001
    ? `Sell of ${remainingSell} shares exceeds available lot balance by ${leftToSell.toFixed(4)}`
    : undefined;

  // If sell fits in one lot, just assign the original split — no sub-splits needed
  if (allocations.length === 1 && leftToSell < 0.0001) {
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

  const totalAllocShares = allocations.reduce((s, a) => s + a.shares, 0);
  const pricePerShare = Math.abs(sellVal) / remainingSell;
  const subSplitsCreated: string[] = [];
  const lotsUsed: string[] = [];
  const qtyDenom = Number(sellSplit.quantity_denom);
  const valDenom = Number(sellSplit.value_denom);

  // Assign the first allocation to the original split, create sub-splits for the rest
  const firstAlloc = allocations[0];
  const firstQty = fromDecimal(-firstAlloc.shares, qtyDenom);
  const firstVal = fromDecimal(firstAlloc.shares * pricePerShare, valDenom);

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

  // Create sub-splits for remaining allocations
  for (let i = 1; i < allocations.length; i++) {
    const alloc = allocations[i];
    const isLast = i === allocations.length - 1;

    // For the last sub-split, ensure we account for rounding
    let subQty: { num: bigint; denom: bigint };
    let subVal: { num: bigint; denom: bigint };

    if (isLast) {
      // Last sub-split gets the remainder to maintain balance
      const usedQtyNum = allocations.slice(0, i).reduce((sum, a) => {
        const q = fromDecimal(-a.shares, qtyDenom);
        return sum + q.num;
      }, 0n);
      const usedValNum = allocations.slice(0, i).reduce((sum, a) => {
        const v = fromDecimal(a.shares * pricePerShare, valDenom);
        return sum + v.num;
      }, 0n);

      subQty = { num: sellSplit.quantity_num - usedQtyNum, denom: BigInt(qtyDenom) };
      subVal = { num: sellSplit.value_num - usedValNum, denom: BigInt(valDenom) };
    } else {
      subQty = fromDecimal(-alloc.shares, qtyDenom);
      subVal = fromDecimal(alloc.shares * pricePerShare, valDenom);
    }

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
        lot_guid: alloc.lot.guid,
      },
    });

    // Tag sub-split
    await tx.slots.create({
      data: {
        obj_guid: subGuid,
        name: 'gnucash_web_generated',
        slot_type: 4,
        string_val: runId,
      },
    });

    subSplitsCreated.push(subGuid);
    lotsUsed.push(alloc.lot.guid);
    alloc.lot.shares -= alloc.shares;
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
// linkTransferToLot
// ---------------------------------------------------------------------------

/**
 * For a transfer-in split (positive qty, same commodity sent from another account),
 * create a new lot in the destination account with metadata linking to the source lot.
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
// generateCapitalGains
// ---------------------------------------------------------------------------

/**
 * For a closed lot (shares sum to ~0), create a GnuCash double-balance gains transaction:
 * - Adjusting split in investment account (zero shares, -gainLoss value)
 * - Corresponding entry in Income:Capital Gains account (zero shares, +gainLoss value)
 *
 * Uses `commodity_scu` from parent account (not hardcoded 100).
 * Classifies ST/LT by holding period; handles TAX_EXEMPT (skip) and TAX_DEFERRED.
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

  // Check if lot is actually closed (shares ~0)
  const totalShares = lot.splits.reduce(
    (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom),
    0,
  );
  if (Math.abs(totalShares) > 0.0001) {
    return {
      gainsTransactionGuid: null,
      skippedReason: `Lot is not closed (remaining shares: ${totalShares.toFixed(4)})`,
      gainLoss: 0,
      holdingPeriod: null,
      taxClassification: 'TAX_NORMAL',
    };
  }

  // Check for pre-existing gains split (already has a zero-quantity split)
  const existingGainsSplit = lot.splits.find(s => {
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    const val = toDecimalNumber(s.value_num, s.value_denom);
    return Math.abs(qty) < 0.0001 && Math.abs(val) > 0.0001;
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

  // Calculate gain/loss: sum of all split values in lot
  // Positive = gain (buy was negative value, sell was positive value; net positive = gain)
  const gainLoss = lot.splits.reduce(
    (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom),
    0,
  );

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

  // Determine the gains account path
  const periodLabel = holdingPeriod === 'long_term' ? 'Long Term' : 'Short Term';
  let gainsAccountPath: string;
  if (taxClassification === 'TAX_DEFERRED') {
    gainsAccountPath = `Income:Capital Gains:Tax-Deferred:${periodLabel}`;
  } else {
    gainsAccountPath = `Income:Capital Gains:${periodLabel}`;
  }

  // Get book root and currency
  const book = await tx.books.findFirst({ select: { root_account_guid: true } });
  if (!book) {
    throw new Error('No book found');
  }

  // Use the transaction currency from the lot's splits
  const currencyGuid = lot.splits[0]?.transaction?.currency_guid;
  if (!currencyGuid) {
    throw new Error('Cannot determine currency for gains transaction');
  }

  const gainsAccountGuid = await findOrCreateAccount(
    gainsAccountPath,
    book.root_account_guid,
    currencyGuid,
    tx,
  );

  // Use commodity_scu from the investment account
  const scu = lot.account.commodity_scu || 100;
  const valFrac = fromDecimal(Math.abs(gainLoss), scu);

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

  // Investment account split: zero shares, -gainLoss value
  // (Offsets the lot's net value so the lot totals to zero after gains)
  const investSplitGuid = generateGuid();
  const investValNum = gainLoss >= 0 ? -valFrac.num : valFrac.num;
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

  // Income account split: zero shares, +gainLoss value (opposite of invest split)
  const gainsSplitGuid = generateGuid();
  const gainsValNum = gainLoss >= 0 ? valFrac.num : -valFrac.num;
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
