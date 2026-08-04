/**
 * Lot Assignment Service
 *
 * Implements auto-assign algorithms (FIFO, LIFO, average) and
 * bulk operations (clear-assign, scrub-all, revert) for lot management.
 *
 * Uses the scrub engine from lot-scrub.ts for sell splitting,
 * transfer linking, and capital gains generation.
 */

import prisma from './prisma';
import { generateGuid, toDecimalNumber } from './gnucash';
import { BookBusyError, bookLockKey, tryAcquireBookLock } from './book-lock';
import { tryWithDatabaseAdvisoryLock } from './db';
import {
  splitSellAcrossLots,
  splitTransferAcrossSourceLots,
  generateCapitalGains,
  valueZeroValueTrade,
  assignAdjustmentToLots,
  qtyEpsilonForScu,
  type OpenLot,
  type PrismaTx,
} from './lot-scrub';

interface SplitForAssignment {
  guid: string;
  tx_guid: string;
  account_guid: string;
  quantity_num: bigint;
  quantity_denom: bigint;
  value_num: bigint;
  value_denom: bigint;
  post_date: Date | null;
  lot_guid: string | null;
}

export interface AutoAssignResult {
  lotsCreated: number;
  splitsAssigned: number;
  splitsCreated: number;
  gainsTransactions: number;
  totalRealizedGain: number;
  method: string;
  runId: string;
  warnings: string[];
}

async function getUnassignedSplits(
  accountGuid: string,
  tx: PrismaTx
): Promise<SplitForAssignment[]> {
  const splits = await tx.splits.findMany({
    where: {
      account_guid: accountGuid,
      lot_guid: null,
    },
    include: {
      transaction: {
        select: { post_date: true },
      },
    },
    orderBy: { transaction: { post_date: 'asc' } },
  });

  return splits.map(s => ({
    guid: s.guid,
    tx_guid: s.tx_guid,
    account_guid: s.account_guid,
    quantity_num: s.quantity_num,
    quantity_denom: s.quantity_denom,
    value_num: s.value_num,
    value_denom: s.value_denom,
    post_date: s.transaction?.post_date ?? null,
    lot_guid: s.lot_guid,
  }));
}

async function createLot(
  accountGuid: string,
  title: string,
  runId: string,
  tx: PrismaTx
): Promise<string> {
  const guid = generateGuid();
  await tx.lots.create({
    data: {
      guid,
      account_guid: accountGuid,
      is_closed: 0,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: guid,
      name: 'title',
      slot_type: 4,
      string_val: title,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: guid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });
  return guid;
}

/** Read a lot's acquisition_date slot (carried through transfers), if any. */
async function readLotAcquisitionDate(lotGuid: string, tx: PrismaTx): Promise<Date | null> {
  const slot = await tx.slots.findFirst({
    where: { obj_guid: lotGuid, name: 'acquisition_date' },
    select: { string_val: true },
  });
  if (!slot?.string_val) return null;
  const d = new Date(slot.string_val);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Order open lots for consumption by one sale. `openLots` holds only lots
 * that exist AT the sale date (the caller replays events chronologically), so
 * LIFO here is true LIFO: the newest lot existing at the sell date, never a
 * buy dated after the sell. Ordering uses each lot's openDate, which for
 * transferred lots is the CARRIED acquisition date, not the transfer date.
 * The returned array holds the SAME lot objects (mutation flows through).
 */
export function orderLotsForConsumption(openLots: OpenLot[], strategy: 'fifo' | 'lifo'): OpenLot[] {
  const ordered = [...openLots].sort(
    (a, b) => (a.openDate?.getTime() || 0) - (b.openDate?.getTime() || 0),
  );
  return strategy === 'lifo' ? ordered.reverse() : ordered;
}

type ScrubEventKind = 'transfer_in' | 'buy' | 'sell' | 'adjustment';

interface ScrubEvent {
  kind: ScrubEventKind;
  split: SplitForAssignment;
  /** Stable tiebreak for same-date events: original fetch order. */
  seq: number;
}

/**
 * Chronological event order: post_date ascending, original order as tiebreak.
 * A sale replayed at its own date can only consume lots that existed then —
 * this ordering (not a lots-first pass) is what makes LIFO time-correct.
 */
export function sortScrubEvents(events: ScrubEvent[]): ScrubEvent[] {
  return [...events].sort((a, b) => {
    const da = a.split.post_date?.getTime() || 0;
    const db = b.split.post_date?.getTime() || 0;
    if (da !== db) return da - db;
    return a.seq - b.seq;
  });
}

async function assignWithStrategy(
  accountGuid: string,
  tx: PrismaTx,
  strategy: 'fifo' | 'lifo'
): Promise<AutoAssignResult> {
  const runId = generateGuid();
  const warnings: string[] = [];

  // Fetch account commodity for transfer detection + commodity-aware epsilon
  const account = await tx.accounts.findUnique({
    where: { guid: accountGuid },
    select: { commodity_guid: true, commodity_scu: true },
  });
  if (!account) {
    throw new Error(`Account not found: ${accountGuid}`);
  }
  const qtyEps = qtyEpsilonForScu(account.commodity_scu);

  const splits = await getUnassignedSplits(accountGuid, tx);
  if (splits.length === 0) {
    return {
      lotsCreated: 0, splitsAssigned: 0, splitsCreated: 0,
      gainsTransactions: 0, totalRealizedGain: 0,
      method: strategy, runId, warnings,
    };
  }

  // ── Classify splits: transfer-in, buy, sell, or stock-split adjustment ──
  // Zero-value legs get special treatment BEFORE classification:
  //  - opposite-commodity counter with quantity (crypto-for-crypto trade):
  //    value both legs from the price DB (valueZeroValueTrade);
  //  - no counter quantity anywhere (true stock split / reverse split):
  //    scale existing lots instead of buying at $0 / selling for $0.
  const events: ScrubEvent[] = [];
  let seq = 0;
  let splitsCreated = 0;

  for (const s of splits) {
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    if (Math.abs(qty) <= qtyEps) continue;

    const txSplits = (await tx.splits.findMany({
      where: { tx_guid: s.tx_guid },
      include: {
        account: { select: { guid: true, commodity_guid: true, account_type: true } },
      },
    })) ?? [];

    const matchingSend = qty > 0
      ? txSplits.find(
          ts =>
            ts.account_guid !== accountGuid &&
            ts.account?.commodity_guid === account.commodity_guid &&
            ts.account?.account_type !== 'TRADING' &&
            toDecimalNumber(ts.quantity_num, ts.quantity_denom) < 0
        )
      : undefined;
    if (matchingSend) {
      events.push({ kind: 'transfer_in', split: s, seq: seq++ });
      continue;
    }

    const value = toDecimalNumber(s.value_num, s.value_denom);
    if (Math.abs(value) < 0.005) {
      const hasSameCommodityCounter = txSplits.some(
        ts =>
          ts.account_guid !== accountGuid &&
          ts.account?.commodity_guid === account.commodity_guid &&
          ts.account?.account_type !== 'TRADING' &&
          Math.abs(toDecimalNumber(ts.quantity_num, ts.quantity_denom)) > 0
      );
      const hasOtherCommodityCounter = txSplits.some(
        ts =>
          ts.account_guid !== s.account_guid &&
          ts.account?.commodity_guid &&
          ts.account.commodity_guid !== account.commodity_guid &&
          ts.account?.account_type !== 'TRADING' &&
          Math.abs(toDecimalNumber(ts.quantity_num, ts.quantity_denom)) > 0
      );

      if (!hasSameCommodityCounter && hasOtherCommodityCounter) {
        // Zero-value commodity-for-commodity trade — value it from the price DB.
        const traded = await valueZeroValueTrade(s.guid, runId, tx);
        if (traded.warning) warnings.push(traded.warning);
        events.push({ kind: qty > 0 ? 'buy' : 'sell', split: s, seq: seq++ });
        continue;
      }
      if (!hasSameCommodityCounter && !hasOtherCommodityCounter) {
        // Stock split / reverse split: single-account quantity change.
        events.push({ kind: 'adjustment', split: s, seq: seq++ });
        continue;
      }
      // Same-commodity counter (transfer-out) or unrecognized shape: fall
      // through to buy/sell handling below.
    }

    events.push({ kind: qty > 0 ? 'buy' : 'sell', split: s, seq: seq++ });
  }

  let lotsCreated = 0;

  // Load existing open lots
  const existingLots = await tx.lots.findMany({
    where: { account_guid: accountGuid, is_closed: 0 },
    include: {
      splits: {
        select: { quantity_num: true, quantity_denom: true },
      },
    },
  });

  // Build openLots array. openDate = carried acquisition date when present
  // (transferred lots must be consumed by their ORIGINAL purchase date, not
  // the transfer date), else the earliest split date.
  const openLots: OpenLot[] = [];

  for (const lot of existingLots) {
    const shares = lot.splits.reduce(
      (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom), 0
    );
    if (shares > qtyEps) {
      const acqDate = await readLotAcquisitionDate(lot.guid, tx);
      let openDate = acqDate;
      if (!openDate) {
        const lotSplits = await tx.splits.findMany({
          where: { lot_guid: lot.guid },
          include: { transaction: { select: { post_date: true } } },
          orderBy: { transaction: { post_date: 'asc' } },
          take: 1,
        });
        openDate = lotSplits[0]?.transaction?.post_date ?? null;
      }
      openLots.push({ guid: lot.guid, shares, openDate });
    }
  }

  // ── Chronological per-event replay ──────────────────────────────────────
  // Events are processed in post-date order so every sale sees exactly the
  // lots that existed at its date. This is what makes LIFO consume "the
  // newest lot existing AT the sell date" instead of buys made afterwards.
  let sellCount = 0;
  let buyCount = 0;
  let transferCount = 0;
  let adjustmentCount = 0;

  for (const event of sortScrubEvents(events)) {
    const s = event.split;
    switch (event.kind) {
      case 'transfer_in': {
        const result = await splitTransferAcrossSourceLots(s.guid, runId, tx);
        lotsCreated += result.lotsCreated;
        splitsCreated += result.subSplitsCreated;
        transferCount++;
        // Add each created lot to openLots, ordered by CARRIED acquisition date
        for (const lotGuid of result.lotGuids) {
          const lotSplits = await tx.splits.findMany({
            where: { lot_guid: lotGuid },
            select: { quantity_num: true, quantity_denom: true },
          });
          const shares = lotSplits.reduce(
            (sum, ls) => sum + toDecimalNumber(ls.quantity_num, ls.quantity_denom), 0,
          );
          const acqDate = await readLotAcquisitionDate(lotGuid, tx);
          openLots.push({ guid: lotGuid, shares, openDate: acqDate ?? s.post_date });
        }
        break;
      }
      case 'buy': {
        const dateStr = s.post_date
          ? s.post_date.toISOString().split('T')[0]
          : 'Unknown';
        const lotGuid = await createLot(accountGuid, `Buy ${dateStr}`, runId, tx);
        lotsCreated++;
        buyCount++;

        await tx.splits.update({
          where: { guid: s.guid },
          data: { lot_guid: lotGuid },
        });

        const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
        openLots.push({ guid: lotGuid, shares: qty, openDate: s.post_date });
        break;
      }
      case 'adjustment': {
        const result = await assignAdjustmentToLots(s.guid, openLots, runId, tx, qtyEps);
        splitsCreated += result.subSplitsCreated.length;
        adjustmentCount++;
        if (result.warning) warnings.push(result.warning);
        break;
      }
      case 'sell': {
        const searchOrder = orderLotsForConsumption(openLots, strategy);
        const result = await splitSellAcrossLots(s.guid, searchOrder, runId, tx, qtyEps);
        splitsCreated += result.subSplitsCreated.length;
        sellCount++;
        if (result.warning) {
          warnings.push(result.warning);
        }
        break;
      }
    }
  }

  // Generate capital gains for lots that are now closed (shares ~= 0)
  let gainsTransactions = 0;
  let totalRealizedGain = 0;

  for (const lot of openLots) {
    if (Math.abs(lot.shares) < qtyEps) {
      const gainsResult = await generateCapitalGains(lot.guid, runId, tx);
      if (gainsResult.gainsTransactionGuid) {
        gainsTransactions++;
        splitsCreated += 2; // invest split + income split
      }
      totalRealizedGain += gainsResult.gainLoss;
      if (gainsResult.skippedReason) {
        warnings.push(`Lot ${lot.guid.substring(0, 8)}: ${gainsResult.skippedReason}`);
      }
    }
  }

  const splitsAssigned = transferCount + buyCount + sellCount + adjustmentCount;

  return {
    lotsCreated,
    splitsAssigned,
    splitsCreated,
    gainsTransactions,
    totalRealizedGain,
    method: strategy,
    runId,
    warnings,
  };
}

async function assignFIFO(
  accountGuid: string,
  tx: PrismaTx
): Promise<AutoAssignResult> {
  return assignWithStrategy(accountGuid, tx, 'fifo');
}

async function assignLIFO(
  accountGuid: string,
  tx: PrismaTx
): Promise<AutoAssignResult> {
  return assignWithStrategy(accountGuid, tx, 'lifo');
}

async function assignAverage(
  accountGuid: string,
  tx: PrismaTx
): Promise<AutoAssignResult> {
  // Average method: each buy gets its own lot (same as FIFO for lot creation).
  // Sells go to the earliest lot (same allocation as FIFO).
  // The difference is in *display*: the UI shows averaged cost per share.
  return assignFIFO(accountGuid, tx);
}

/** Thrown when a scrub-run revert targets accounts outside the active book. */
export class ScrubRunNotInBookError extends Error {
  readonly code = 'SCRUB_RUN_NOT_IN_BOOK';
  constructor(public readonly runId: string) {
    super(`Scrub run ${runId} affects accounts outside the active book`);
    this.name = 'ScrubRunNotInBookError';
  }
}

/**
 * Serialization guard shared by the single-shot lot operations: when the
 * caller supplies the book guid, take the per-book advisory lock
 * non-blockingly and fail fast with BookBusyError (mapped to HTTP 409 by the
 * routes) if another book-level operation is in flight.
 */
async function guardBookLock(
  tx: PrismaTx,
  bookGuid: string | undefined,
  operation: string,
): Promise<void> {
  if (!bookGuid) return;
  const locked = await tryAcquireBookLock(tx, bookGuid);
  if (!locked) {
    throw new BookBusyError(bookGuid, operation);
  }
}

/**
 * Bump the optimistic-concurrency token (enter_date) on every transaction
 * holding a split in this account. Lot operations rewrite the account's lot
 * state wholesale — sub-splitting sells, re-linking lot_guids — invisibly to
 * the token, so a user who loaded a transaction before the scrub would
 * otherwise silently revert those changes on save. Rows are locked in
 * canonical sorted order first, matching every other transaction-write path.
 */
async function bumpAccountTransactionTokens(
  tx: PrismaTx,
  accountGuid: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT guid FROM transactions
    WHERE guid IN (SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ${accountGuid})
    ORDER BY guid
    FOR UPDATE
  `;
  await tx.$executeRaw`
    UPDATE transactions SET enter_date = NOW()
    WHERE guid IN (SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ${accountGuid})
  `;
}

export async function autoAssignLots(
  accountGuid: string,
  method: 'fifo' | 'lifo' | 'average',
  bookGuid?: string
): Promise<AutoAssignResult> {
  return prisma.$transaction(async (tx) => {
    await guardBookLock(tx, bookGuid, 'lot auto-assign');
    let result: AutoAssignResult;
    switch (method) {
      case 'fifo':
        result = await assignFIFO(accountGuid, tx);
        break;
      case 'lifo':
        result = await assignLIFO(accountGuid, tx);
        break;
      case 'average':
        result = await assignAverage(accountGuid, tx);
        break;
      default:
        throw new Error(`Unknown assignment method: ${method}`);
    }
    await bumpAccountTransactionTokens(tx, accountGuid);
    return result;
  }, { timeout: 120_000, maxWait: 15_000 });
}

export async function clearLotAssignments(
  accountGuid: string,
  bookGuid?: string
): Promise<{ splitsUnassigned: number; lotsDeleted: number }> {
  return prisma.$transaction(async (tx) => {
    await guardBookLock(tx, bookGuid, 'clear lot assignments');
    // 1. Find and delete auto-generated sub-splits and gains transactions

    // Find splits in this account tagged with gnucash_web_generated
    const taggedSplitSlots = await tx.slots.findMany({
      where: {
        name: 'gnucash_web_generated',
        obj_guid: {
          in: (await tx.splits.findMany({
            where: { account_guid: accountGuid },
            select: { guid: true },
          })).map(s => s.guid),
        },
      },
      select: { obj_guid: true, string_val: true },
    });
    const taggedSplitGuids = taggedSplitSlots.map(s => s.obj_guid);

    // Find splits that have original_quantity_num slot (were modified by sell splitting)
    const originalQtySlots = await tx.slots.findMany({
      where: {
        name: 'original_quantity_num',
        obj_guid: {
          in: (await tx.splits.findMany({
            where: { account_guid: accountGuid },
            select: { guid: true },
          })).map(s => s.guid),
        },
      },
      select: { obj_guid: true, string_val: true },
    });

    // Restore original sell splits
    for (const slot of originalQtySlots) {
      const denomSlot = await tx.slots.findFirst({
        where: { obj_guid: slot.obj_guid, name: 'original_quantity_denom' },
      });
      const valNumSlot = await tx.slots.findFirst({
        where: { obj_guid: slot.obj_guid, name: 'original_value_num' },
      });
      const valDenomSlot = await tx.slots.findFirst({
        where: { obj_guid: slot.obj_guid, name: 'original_value_denom' },
      });

      if (slot.string_val && denomSlot?.string_val && valNumSlot?.string_val && valDenomSlot?.string_val) {
        await tx.splits.update({
          where: { guid: slot.obj_guid },
          data: {
            quantity_num: BigInt(slot.string_val),
            quantity_denom: BigInt(denomSlot.string_val),
            value_num: BigInt(valNumSlot.string_val),
            value_denom: BigInt(valDenomSlot.string_val),
            lot_guid: null,
          },
        });
      }

      // Clean up original value slots
      await tx.slots.deleteMany({
        where: {
          obj_guid: slot.obj_guid,
          name: { in: ['original_quantity_num', 'original_quantity_denom', 'original_value_num', 'original_value_denom', 'gnucash_web_generated'] },
        },
      });
    }

    // Find gains transactions: transactions where ALL splits are tagged with gnucash_web_generated
    // First, get all transactions that have at least one tagged split in this account
    const taggedSplitsInAccount = await tx.splits.findMany({
      where: { guid: { in: taggedSplitGuids } },
      select: { tx_guid: true, guid: true },
    });
    const candidateTxGuids = [...new Set(taggedSplitsInAccount.map(s => s.tx_guid))];

    for (const txGuid of candidateTxGuids) {
      const txSplits = await tx.splits.findMany({
        where: { tx_guid: txGuid },
        select: { guid: true },
      });
      const txSplitGuids = txSplits.map(s => s.guid);

      // Check if ALL splits in this transaction are tagged
      const taggedCount = await tx.slots.count({
        where: {
          obj_guid: { in: txSplitGuids },
          name: 'gnucash_web_generated',
        },
      });

      if (taggedCount === txSplitGuids.length) {
        // All splits tagged — this is a generated gains transaction. Delete it.
        // Delete slots for splits
        await tx.slots.deleteMany({
          where: { obj_guid: { in: txSplitGuids } },
        });
        // Delete splits
        await tx.splits.deleteMany({
          where: { tx_guid: txGuid },
        });
        // Delete transaction slots
        await tx.slots.deleteMany({
          where: { obj_guid: txGuid },
        });
        // Delete transaction
        await tx.transactions.deleteMany({
          where: { guid: txGuid },
        });
      }
    }

    // Delete remaining tagged sub-splits (not part of fully-generated transactions)
    // Re-fetch since some may have been deleted above
    const remainingTaggedSlots = await tx.slots.findMany({
      where: {
        name: 'gnucash_web_generated',
        obj_guid: {
          in: (await tx.splits.findMany({
            where: { account_guid: accountGuid },
            select: { guid: true },
          })).map(s => s.guid),
        },
      },
      select: { obj_guid: true },
    });
    const remainingTaggedSplitGuids = remainingTaggedSlots.map(s => s.obj_guid);

    if (remainingTaggedSplitGuids.length > 0) {
      await tx.slots.deleteMany({
        where: { obj_guid: { in: remainingTaggedSplitGuids } },
      });
      await tx.splits.deleteMany({
        where: { guid: { in: remainingTaggedSplitGuids } },
      });
    }

    // 2. Unassign all remaining splits from lots
    const updateResult = await tx.splits.updateMany({
      where: { account_guid: accountGuid, lot_guid: { not: null } },
      data: { lot_guid: null },
    });

    // 3. Delete empty lots and their slots
    const emptyLots = await tx.lots.findMany({
      where: { account_guid: accountGuid },
      include: { _count: { select: { splits: true } } },
    });

    const lotsToDelete = emptyLots.filter(l => l._count.splits === 0);

    if (lotsToDelete.length > 0) {
      const deleteGuids = lotsToDelete.map(l => l.guid);
      await tx.slots.deleteMany({
        where: {
          obj_guid: { in: deleteGuids },
          name: { in: ['title', 'source_lot_guid', 'acquisition_date', 'carried_basis', 'gnucash_web_generated'] },
        },
      });
      await tx.lots.deleteMany({
        where: { guid: { in: deleteGuids } },
      });
    }

    await bumpAccountTransactionTokens(tx, accountGuid);

    return {
      splitsUnassigned: updateResult.count,
      lotsDeleted: lotsToDelete.length,
    };
  }, { timeout: 120_000, maxWait: 15_000 });
}

export interface RevertScrubRunOptions {
  /**
   * When set, the per-book advisory lock is try-acquired first;
   * a concurrent book operation raises BookBusyError (HTTP 409).
   */
  bookGuid?: string;
  /**
   * When set, every account touched by the scrub run must be in this list
   * (the active book's account tree) or the revert aborts with
   * ScrubRunNotInBookError BEFORE anything is deleted.
   */
  allowedAccountGuids?: string[];
}

export async function revertScrubRun(
  runId: string,
  options: RevertScrubRunOptions = {}
): Promise<{ reverted: number }> {
  return prisma.$transaction(async (tx) => {
    await guardBookLock(tx, options.bookGuid, 'revert scrub run');

    // Find all entities tagged with this runId
    const taggedSlots = await tx.slots.findMany({
      where: { name: 'gnucash_web_generated', string_val: runId },
      select: { obj_guid: true },
    });
    const taggedGuids = taggedSlots.map(s => s.obj_guid);
    if (taggedGuids.length === 0) return { reverted: 0 };

    // ── Enumerate everything the run touched BEFORE deleting anything ──
    const taggedTxs = await tx.transactions.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true },
    });
    const txGuids = taggedTxs.map(t => t.guid);
    const txSplits = txGuids.length > 0
      ? await tx.splits.findMany({
          where: { tx_guid: { in: txGuids } },
          select: { guid: true, account_guid: true },
        })
      : [];
    const taggedSplits = await tx.splits.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true, account_guid: true },
    });
    const taggedLots = await tx.lots.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true, account_guid: true },
    });

    // Book-scope check: run IDs are returned in API responses, so an editor
    // of one book must not be able to destroy another book's scrub run by
    // replaying a runId. Abort before any deletion when the run touches
    // accounts outside the caller's book.
    if (options.allowedAccountGuids) {
      const allowed = new Set(options.allowedAccountGuids);
      const affectedAccounts = new Set<string>();
      for (const s of txSplits) affectedAccounts.add(s.account_guid);
      for (const s of taggedSplits) affectedAccounts.add(s.account_guid);
      for (const l of taggedLots) {
        if (l.account_guid) affectedAccounts.add(l.account_guid);
      }
      for (const accountGuid of affectedAccounts) {
        if (!allowed.has(accountGuid)) {
          throw new ScrubRunNotInBookError(runId);
        }
      }
    }

    // Delete tagged transactions (and their splits)
    if (txGuids.length > 0) {
      // Also delete the slots attached to those transactions' splits
      // (the generated gains splits are tagged), not just the tx slots.
      if (txSplits.length > 0) {
        await tx.slots.deleteMany({ where: { obj_guid: { in: txSplits.map(s => s.guid) } } });
      }
      await tx.splits.deleteMany({ where: { tx_guid: { in: txGuids } } });
      await tx.slots.deleteMany({ where: { obj_guid: { in: txGuids } } });
      await tx.transactions.deleteMany({ where: { guid: { in: txGuids } } });
    }

    // Splits modified IN-PLACE by this run (sell/transfer splits that were
    // sub-split) are tagged with the runId AND carry original_* slots.
    // They are the user's original splits — they must be RESTORED, never deleted.
    // Scope to taggedGuids so other runs' modified splits are left alone.
    const originalQtySlots = await tx.slots.findMany({
      where: { name: 'original_quantity_num', obj_guid: { in: taggedGuids } },
      select: { obj_guid: true, string_val: true },
    });
    const modifiedOriginalGuids = new Set(originalQtySlots.map(s => s.obj_guid));

    // Delete tagged sub-splits (excluding the modified originals). Splits
    // belonging to the generated gains transactions were already removed
    // above; deleteMany on their guids is a harmless no-op.
    const subSplitGuids = taggedSplits
      .map(s => s.guid)
      .filter(g => !modifiedOriginalGuids.has(g));
    if (subSplitGuids.length > 0) {
      await tx.slots.deleteMany({ where: { obj_guid: { in: subSplitGuids } } });
      await tx.splits.deleteMany({ where: { guid: { in: subSplitGuids } } });
    }

    // Restore original sell/transfer splits from stored slots
    for (const slot of originalQtySlots) {
      const denomSlot = await tx.slots.findFirst({ where: { obj_guid: slot.obj_guid, name: 'original_quantity_denom' } });
      const valNumSlot = await tx.slots.findFirst({ where: { obj_guid: slot.obj_guid, name: 'original_value_num' } });
      const valDenomSlot = await tx.slots.findFirst({ where: { obj_guid: slot.obj_guid, name: 'original_value_denom' } });

      if (slot.string_val && denomSlot?.string_val && valNumSlot?.string_val && valDenomSlot?.string_val) {
        await tx.splits.update({
          where: { guid: slot.obj_guid },
          data: {
            quantity_num: BigInt(slot.string_val),
            quantity_denom: BigInt(denomSlot.string_val),
            value_num: BigInt(valNumSlot.string_val),
            value_denom: BigInt(valDenomSlot.string_val),
            lot_guid: null,
          },
        });
      }

      // Clean up the original slots
      await tx.slots.deleteMany({
        where: {
          obj_guid: slot.obj_guid,
          name: { in: ['original_quantity_num', 'original_quantity_denom', 'original_value_num', 'original_value_denom', 'gnucash_web_generated'] },
        },
      });
    }

    // Delete tagged lots (enumerated up front, before any deletion)
    if (taggedLots.length > 0) {
      const deleteLotGuids = taggedLots.map(l => l.guid);
      await tx.splits.updateMany({ where: { lot_guid: { in: deleteLotGuids } }, data: { lot_guid: null } });
      await tx.slots.deleteMany({ where: { obj_guid: { in: deleteLotGuids } } });
      await tx.lots.deleteMany({ where: { guid: { in: deleteLotGuids } } });
    }

    // Reopen lots that were closed by this run
    await tx.lots.updateMany({
      where: { guid: { in: taggedGuids }, is_closed: 1 },
      data: { is_closed: 0 },
    });

    // Bump the concurrency token on every account the revert rewrote
    // (restored sell splits, detached lots) so stale editors 409 instead of
    // silently re-applying pre-revert state.
    const revertedAccounts = new Set<string>();
    for (const s of taggedSplits) revertedAccounts.add(s.account_guid);
    for (const l of taggedLots) {
      if (l.account_guid) revertedAccounts.add(l.account_guid);
    }
    for (const accountGuid of Array.from(revertedAccounts).sort()) {
      await bumpAccountTransactionTokens(tx, accountGuid);
    }

    return { reverted: taggedGuids.length };
  }, { timeout: 120_000, maxWait: 15_000 });
}

export interface ScrubAccountFailure {
  accountGuid: string;
  accountName: string;
  phase: 'clear' | 'scrub';
  error: string;
}

export interface ScrubAllResult {
  results: AutoAssignResult[];
  order: string[];
  cleared: number;
  /** Per-account errors. Empty when every account scrubbed cleanly. */
  failures: ScrubAccountFailure[];
}

export async function scrubAllAccounts(
  method: 'fifo' | 'lifo' | 'average',
  bookAccountGuids: string[],
  clearFirst: boolean = false,
  onProgress?: (p: { message: string; current: number; total: number; percent: number }) => void,
  bookGuid?: string
): Promise<ScrubAllResult> {
  // Scrub-all is deliberately NOT one giant transaction: each account is
  // scrubbed in its own transaction so a long run makes durable per-account
  // progress. Cross-process serialization instead comes from a SESSION-level
  // advisory lock on the book key, held on a dedicated connection for the
  // whole run. It contends with the transaction-level book locks used by
  // import/delete/reparent/single-account lot ops (same hashtext key), and a
  // concurrent scrub-all gets an immediate BookBusyError (HTTP 409).
  if (bookGuid) {
    const attempt = await tryWithDatabaseAdvisoryLock(
      bookLockKey(bookGuid),
      () => runScrubAllAccounts(method, bookAccountGuids, clearFirst, onProgress),
    );
    if (!attempt.acquired) {
      throw new BookBusyError(bookGuid, 'scrub all lots');
    }
    return attempt.result;
  }
  return runScrubAllAccounts(method, bookAccountGuids, clearFirst, onProgress);
}

async function runScrubAllAccounts(
  method: 'fifo' | 'lifo' | 'average',
  bookAccountGuids: string[],
  clearFirst: boolean,
  onProgress?: (p: { message: string; current: number; total: number; percent: number }) => void
): Promise<ScrubAllResult> {
  // 1. Find all STOCK/MUTUAL accounts
  const investmentAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids }, account_type: { in: ['STOCK', 'MUTUAL'] } },
    select: { guid: true, name: true, commodity_guid: true },
  });

  // 2. Build transfer dependency graph
  const dependencies = new Map<string, Set<string>>();
  for (const acct of investmentAccounts) {
    dependencies.set(acct.guid, new Set());
  }

  for (const acct of investmentAccounts) {
    const transferIns = await prisma.splits.findMany({
      where: { account_guid: acct.guid, quantity_num: { gt: 0 } },
      include: {
        transaction: {
          include: {
            splits: {
              include: {
                account: { select: { guid: true, commodity_guid: true, account_type: true } },
              },
            },
          },
        },
      },
    });

    for (const split of transferIns) {
      const txSplits = split.transaction?.splits || [];
      const matchingSend = txSplits.find(s =>
        s.account_guid !== acct.guid &&
        s.account?.commodity_guid === acct.commodity_guid &&
        s.account?.account_type !== 'TRADING' &&
        s.quantity_num < 0n
      );
      if (matchingSend && dependencies.has(matchingSend.account_guid)) {
        dependencies.get(acct.guid)!.add(matchingSend.account_guid);
      }
    }
  }

  // 3. Topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  for (const [guid, deps] of dependencies) {
    inDegree.set(guid, deps.size);
  }
  const queue: string[] = [];
  for (const [guid, degree] of inDegree) {
    if (degree === 0) queue.push(guid);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const [guid, deps] of dependencies) {
      if (deps.has(current)) {
        deps.delete(current);
        inDegree.set(guid, (inDegree.get(guid) || 1) - 1);
        if (inDegree.get(guid) === 0) queue.push(guid);
      }
    }
  }
  // Add any accounts not in order (circular deps) at the end
  for (const acct of investmentAccounts) {
    if (!order.includes(acct.guid)) order.push(acct.guid);
  }

  const accountNames = new Map(investmentAccounts.map((a) => [a.guid, a.name]));
  const failures: ScrubAccountFailure[] = [];

  // 4. Clear existing assignments if requested. Per-account failures no
  // longer vanish into the log — they are collected and returned so the
  // caller can surface a half-cleared book instead of pretending success.
  let cleared = 0;
  if (clearFirst) {
    for (const accountGuid of order) {
      try {
        const clearResult = await clearLotAssignments(accountGuid);
        cleared += clearResult.lotsDeleted;
      } catch (error) {
        console.error(`Error clearing account ${accountGuid}:`, error);
        failures.push({
          accountGuid,
          accountName: accountNames.get(accountGuid) ?? accountGuid,
          phase: 'clear',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // 5. Scrub each account in order
  const results: AutoAssignResult[] = [];
  let scrubIndex = 0;
  for (const accountGuid of order) {
    scrubIndex++;
    try {
      onProgress?.({
        message: `Scrubbing ${accountNames.get(accountGuid) ?? accountGuid} (${scrubIndex}/${order.length})…`,
        current: scrubIndex,
        total: order.length,
        percent: Math.round((100 * (scrubIndex - 1)) / Math.max(1, order.length)),
      });
    } catch {
      // Progress reporting must never break the scrub.
    }
    try {
      const result = await autoAssignLots(accountGuid, method);
      results.push(result);
    } catch (error) {
      console.error(`Error scrubbing account ${accountGuid}:`, error);
      failures.push({
        accountGuid,
        accountName: accountNames.get(accountGuid) ?? accountGuid,
        phase: 'scrub',
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({
        lotsCreated: 0, splitsAssigned: 0, splitsCreated: 0,
        gainsTransactions: 0, totalRealizedGain: 0,
        method, runId: '', warnings: [`Error: ${error}`],
      });
    }
  }

  return { results, order, cleared, failures };
}

export interface WashSaleResult {
  splitGuid: string;
  sellDate: string;
  sellAccountGuid: string;
  sellAccountName: string;
  ticker: string;
  /** Shares sold at a loss (positive). */
  shares: number;
  /**
   * DISALLOWED loss, stored negative. Already pro-rated by IRC §1091(b): when
   * fewer replacement shares were acquired than were sold, only
   * replacementShares/soldShares of the realized loss is disallowed.
   */
  loss: number;
  washBuyDate: string;
  washBuyAccountGuid: string;
  washBuyAccountName: string;
  /** Replacement shares acquired by the matched buy (capped at `shares`). */
  replacementShares?: number;
  /** Calendar days between the sale day and the replacement-buy day. */
  daysApart: number;
}

/**
 * Detect wash sales across all STOCK/MUTUAL accounts in the book.
 *
 * IRS wash sale rule: A loss is disallowed if you buy substantially identical
 * securities within 30 days before or after the sale.
 *
 * This checks CROSS-ACCOUNT: if you sell AAPL at a loss in one account
 * and buy AAPL in another account within the window, it's a wash sale.
 */
export async function detectWashSales(
  bookAccountGuids: string[]
): Promise<WashSaleResult[]> {
  const investmentAccounts = await prisma.accounts.findMany({
    where: {
      guid: { in: bookAccountGuids },
      account_type: { in: ['STOCK', 'MUTUAL'] },
    },
    select: {
      guid: true,
      name: true,
      commodity_guid: true,
      commodity: { select: { mnemonic: true } },
    },
  });

  if (investmentAccounts.length === 0) return [];

  const accountsByCommodity = new Map<string, typeof investmentAccounts>();
  for (const acct of investmentAccounts) {
    if (!acct.commodity_guid) continue;
    const existing = accountsByCommodity.get(acct.commodity_guid) || [];
    existing.push(acct);
    accountsByCommodity.set(acct.commodity_guid, existing);
  }

  const washSales: WashSaleResult[] = [];
  // The 30-day window is a CALENDAR-DAY window. Comparing raw timestamps would
  // miss a genuine day-30 replacement whenever the buy's time of day falls
  // later than the sell's (post-date times of day vary across a real book).
  const WASH_WINDOW_DAYS = 30;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const utcDayMs = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  for (const [commodityGuid, accounts] of accountsByCommodity.entries()) {
    const accountGuids = accounts.map(a => a.guid);
    const ticker = accounts[0].commodity?.mnemonic || 'Unknown';

    const allSplits = await prisma.splits.findMany({
      where: { account_guid: { in: accountGuids } },
      include: {
        transaction: {
          select: {
            post_date: true,
            // Sibling splits let us tell a genuine purchase from a
            // transfer-in sub-split (same-commodity negative counter in
            // another non-TRADING account).
            splits: {
              select: {
                guid: true,
                account_guid: true,
                quantity_num: true,
                quantity_denom: true,
                account: { select: { commodity_guid: true, account_type: true } },
              },
            },
          },
        },
      },
      orderBy: { transaction: { post_date: 'asc' } },
    });

    type WashSplit = (typeof allSplits)[number];
    /** Transfer-in: shares arriving from the user's own other account — NOT replacement shares. */
    const isTransferInSplit = (s: WashSplit): boolean => {
      const siblings = s.transaction?.splits ?? [];
      return siblings.some(o =>
        o.account_guid !== s.account_guid &&
        o.account?.commodity_guid === commodityGuid &&
        o.account?.account_type !== 'TRADING' &&
        toDecimalNumber(o.quantity_num, o.quantity_denom) < 0,
      );
    };

    // Identify sells and buys. Transfer-ins are excluded from BOTH the
    // replacement-share candidates and the loss heuristic: moving shares
    // between one's own accounts is not an acquisition under §1091.
    const buys = allSplits.filter(s =>
      toDecimalNumber(s.quantity_num, s.quantity_denom) > 0 &&
      !isTransferInSplit(s)
    );

    // For sells, determine if they were at a loss using lot data or heuristic
    const sells: Array<typeof allSplits[0] & { realizedLoss: number }> = [];

    // Batch-fetch all lots referenced by splits to avoid N+1 queries
    const lotGuids = [...new Set(allSplits.filter(s => s.lot_guid).map(s => s.lot_guid!))];
    const lotsWithSplits = lotGuids.length > 0
      ? await prisma.lots.findMany({
          where: { guid: { in: lotGuids } },
          include: { splits: true },
        })
      : [];
    const lotMap = new Map(lotsWithSplits.map(l => [l.guid, l]));

    for (const s of allSplits) {
      const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
      if (qty >= 0) continue; // Not a sell

      const val = toDecimalNumber(s.value_num, s.value_denom);

      // If sell is assigned to a lot, check lot-level realized gain.
      // Native GnuCash signs: trading splits sum to basis - proceeds, so
      // gain = -(sum). Zero-quantity gains offset splits are excluded.
      if (s.lot_guid) {
        const lot = lotMap.get(s.lot_guid);
        if (lot) {
          const realizedGain = -lot.splits
            .filter(ls => Math.abs(toDecimalNumber(ls.quantity_num, ls.quantity_denom)) > 0.0001)
            .reduce((sum, ls) => sum + toDecimalNumber(ls.value_num, ls.value_denom), 0);
          const totalQty = lot.splits.reduce(
            (sum, ls) => sum + toDecimalNumber(ls.quantity_num, ls.quantity_denom), 0
          );
          // Closed lot with negative realized gain = realized loss
          if (Math.abs(totalQty) < 0.0001 && realizedGain < 0) {
            sells.push({ ...s, realizedLoss: realizedGain });
            continue;
          }
        }
      }

      // Fallback: compare sell proceeds per share against average buy cost per
      // share. Only buys ON OR BEFORE the sell date can have supplied the sold
      // shares — averaging in later purchases distorts the cost basis.
      const sellPostDate = s.transaction?.post_date ?? null;
      const accountBuys = buys.filter(b =>
        b.account_guid === s.account_guid &&
        (!sellPostDate || (b.transaction?.post_date && b.transaction.post_date <= sellPostDate)),
      );
      if (accountBuys.length > 0) {
        const totalBuyQty = accountBuys.reduce(
          (sum, b) => sum + toDecimalNumber(b.quantity_num, b.quantity_denom), 0
        );
        const totalBuyCost = accountBuys.reduce(
          (sum, b) => sum + Math.abs(toDecimalNumber(b.value_num, b.value_denom)), 0
        );
        const avgCostPerShare = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
        const sellProceedsPerShare = Math.abs(val / qty);
        if (sellProceedsPerShare < avgCostPerShare) {
          const loss = (sellProceedsPerShare - avgCostPerShare) * Math.abs(qty);
          sells.push({ ...s, realizedLoss: loss });
        }
      }
    }

    // Check each loss-sell for wash sale: any buy of same commodity within 30 days
    for (const sell of sells) {
      const sellDate = sell.transaction?.post_date;
      if (!sellDate) continue;
      const sellDayMs = utcDayMs(sellDate);
      const soldShares = Math.abs(toDecimalNumber(sell.quantity_num, sell.quantity_denom));

      for (const buy of buys) {
        const buyDate = buy.transaction?.post_date;
        if (!buyDate) continue;
        // The sold shares' OWN lot-opening buy is not replacement stock — a
        // sale must never flag against the very purchase it disposes of
        // (DRIP-heavy accounts would flag every sale otherwise).
        if (buy.lot_guid && sell.lot_guid && buy.lot_guid === sell.lot_guid) continue;
        const daysApart = Math.abs(utcDayMs(buyDate) - sellDayMs) / MS_PER_DAY;

        if (daysApart <= WASH_WINDOW_DAYS && buy.guid !== sell.guid) {
          const sellAccount = accounts.find(a => a.guid === sell.account_guid);
          const buyAccount = accounts.find(a => a.guid === buy.account_guid);

          // IRC §1091(b): when fewer replacement shares are acquired than were
          // sold, only the PROPORTIONATE part of the loss is disallowed. The
          // remainder stays deductible.
          const replacementShares = toDecimalNumber(buy.quantity_num, buy.quantity_denom);
          const disallowedRatio = soldShares > 0
            ? Math.min(Math.max(0, replacementShares), soldShares) / soldShares
            : 0;

          washSales.push({
            splitGuid: sell.guid,
            sellDate: sellDate.toISOString(),
            sellAccountGuid: sell.account_guid,
            sellAccountName: sellAccount?.name || '',
            ticker,
            shares: soldShares,
            loss: sell.realizedLoss * disallowedRatio,
            washBuyDate: buyDate.toISOString(),
            washBuyAccountGuid: buy.account_guid,
            washBuyAccountName: buyAccount?.name || '',
            replacementShares: Math.min(Math.max(0, replacementShares), soldShares),
            daysApart,
          });
          break; // One wash match per sell is enough
        }
      }
    }
  }

  return washSales;
}
