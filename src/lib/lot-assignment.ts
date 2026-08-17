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
import { computeRealizedGain } from './lots';
import { isOwnAccountCommodityTransfer } from './account-transfer';
import {
  PARENT_SPLIT_SLOT,
  AVG_COST_BASIS_SLOT,
  AVG_COST_BASIS_RUN_SLOT,
  AVG_BASIS_REMAINING_SLOT,
  AVG_BASIS_REMAINING_RUN_SLOT,
  AVG_BASIS_REMAINING_PREV_SLOT,
  AVG_BASIS_REMAINING_PREV_RUN_SLOT,
  AVG_SPLIT_SLOT_NAMES,
  AVG_LOT_SLOT_NAMES,
  splitSellAcrossLots,
  splitTransferAcrossSourceLots,
  generateCapitalGains,
  valueZeroValueTrade,
  assignAdjustmentToLots,
  qtyEpsilonForScu,
  computeCarriedBasis,
  readCarriedBasis,
  writeAvgCostBasis,
  writeAvgBasisRemaining,
  readAvgBasisWrites,
  writeAvgBasisWrites,
  decodeAvgBasisHistory,
  type OpenLot,
  type PrismaTx,
} from './lot-scrub';
import { allocateTradeFees, NO_TRADE_FEES, type TradeFeeBySplit } from './trade-fees';
import type { Prisma } from '@prisma/client';
import {
  assertSplitsNotProtected,
  lockTransactionsForUpdate,
  PROTECTED_RECONCILE_STATES,
} from './services/reconciled-split.service';

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

/** Lot-assignment methods this engine implements end to end. */
export type LotAssignmentMethod = 'fifo' | 'lifo' | 'average';

/**
 * Order open lots for consumption by one sale. `openLots` holds only lots
 * that exist AT the sale date (the caller replays events chronologically), so
 * LIFO here is true LIFO: the newest lot existing at the sell date, never a
 * buy dated after the sell. Ordering uses each lot's openDate, which for
 * transferred lots is the CARRIED acquisition date, not the transfer date.
 * The returned array holds the SAME lot objects (mutation flows through).
 *
 * AVERAGE cost orders lots exactly like FIFO. That is not a shortcut: under
 * the average-basis method the basis of the shares sold is the pool average
 * (see the replay below), while WHICH shares are treated as sold — and
 * therefore the short-vs-long-term split — is still oldest-first, per
 * Treas. Reg. §1.1012-1(e)(7)(ii). Lot order here decides holding period, not
 * basis.
 */
export function orderLotsForConsumption(
  openLots: OpenLot[],
  strategy: LotAssignmentMethod,
): OpenLot[] {
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

/**
 * Delete every average-cost artefact this engine wrote for an account,
 * WHICHEVER run wrote it.
 *
 * This is the ELECTION-WIDE sweep, and account scope is the correct scope for
 * it. Its two callers are the two places where no average-cost number may
 * survive under any owner:
 *
 *  - a FIFO/LIFO re-scrub of the account (the election is no longer in force,
 *    so a slot left by ANY earlier average run would keep Form 8949 reporting
 *    a pooled basis on a FIFO return);
 *  - clearLotAssignments, which destroys the account's whole lot structure.
 *
 * Reverting ONE run is a different question with a different answer — see
 * clearAverageCostArtifactsForRun. Under an average re-scrub nothing is
 * cleared at all: earlier runs' slots price their own disposals and seed the
 * pool for lots this run does not re-touch.
 */
async function clearAverageCostArtifacts(accountGuid: string, tx: PrismaTx): Promise<void> {
  const accountSplitGuids = (await tx.splits.findMany({
    where: { account_guid: accountGuid },
    select: { guid: true },
  })).map(s => s.guid);
  if (accountSplitGuids.length > 0) {
    await tx.slots.deleteMany({
      where: { obj_guid: { in: accountSplitGuids }, name: { in: [...AVG_SPLIT_SLOT_NAMES] } },
    });
  }
  const accountLotGuids = (await tx.lots.findMany({
    where: { account_guid: accountGuid },
    select: { guid: true },
  })).map(l => l.guid);
  if (accountLotGuids.length > 0) {
    await tx.slots.deleteMany({
      where: { obj_guid: { in: accountLotGuids }, name: { in: [...AVG_LOT_SLOT_NAMES] } },
    });
  }
}

/** The average-cost slots one scrub run owns, located by their run companions. */
interface RunAverageArtifacts {
  /** Disposal splits whose `avg_cost_basis` this run wrote. */
  splitGuids: string[];
  /** Lots whose LIVE `avg_cost_basis_remaining` this run wrote. */
  lotGuids: string[];
  /** Lots whose write history holds a value THIS run wrote and a later run displaced. */
  stashLotGuids: string[];
}

const hasRunAverageArtifacts = (a: RunAverageArtifacts): boolean =>
  a.splitGuids.length > 0 || a.lotGuids.length > 0 || a.stashLotGuids.length > 0;

/**
 * Locate every average-cost slot stamped with this run id.
 *
 * Keyed on the run companion slots, never on the account: an account
 * accumulates slots from every run that ever scrubbed it, and deleting by
 * account is precisely the bug this provenance exists to close.
 */
async function findAverageCostArtifactsForRun(
  runId: string,
  tx: PrismaTx,
): Promise<RunAverageArtifacts> {
  const ownedBy = async (name: string): Promise<string[]> => {
    // `?? []` for the reason the rest of this engine carries it: mocked Prisma
    // clients in tests return undefined for queries they do not stub.
    const rows = (await tx.slots.findMany({
      where: { name, string_val: runId },
      select: { obj_guid: true },
    })) ?? [];
    return [...new Set(rows.map(r => r.obj_guid))];
  };
  // A displaced write's owner travels INSIDE the history row, so this one
  // cannot be an equality match on string_val: the history rows are read and
  // decoded, then filtered by owner. (Legacy single stashes, whose owner still
  // lives in its own companion row, are unioned in.)
  const historyOwnedByRun = async (): Promise<string[]> => {
    const rows = (await tx.slots.findMany({
      where: { name: AVG_BASIS_REMAINING_PREV_SLOT },
      select: { obj_guid: true, string_val: true },
    })) ?? [];
    const out = new Set(await ownedBy(AVG_BASIS_REMAINING_PREV_RUN_SLOT));
    for (const row of rows) {
      if (decodeAvgBasisHistory(row.string_val ?? null, null).some(e => e.run === runId)) {
        out.add(row.obj_guid);
      }
    }
    return [...out];
  };

  return {
    splitGuids: await ownedBy(AVG_COST_BASIS_RUN_SLOT),
    lotGuids: await ownedBy(AVG_BASIS_REMAINING_RUN_SLOT),
    stashLotGuids: await historyOwnedByRun(),
  };
}

/**
 * Undo ONLY this run's average-cost slots, leaving every other run's standing.
 *
 * Two moves:
 *
 *  1. Disposal slots this run wrote are deleted. Another run's disposal slot
 *     is never touched, so reverting a later run cannot rewrite the basis on a
 *     sale an earlier run already priced and the user already filed.
 *  2. On every lot this run wrote to — whether its value is still live or a
 *     later run has displaced it — the lot's write history is rebuilt WITHOUT
 *     this run's entries, and whatever is left on top becomes the live value.
 *
 * Move 2 is one operation rather than "delete mine, restore the one below"
 * because the history is a stack of writes, not a single displaced value:
 *
 *  - removing an entry from the middle leaves the runs above and below it
 *    intact, so reverts in any order compose (revert C then B walks back down
 *    to A's number; revert B then C skips B entirely and lands on A's);
 *  - the run being reverted is identified by ownership, not position, so its
 *    number can never be resurrected by a later revert — it is gone from the
 *    stack the moment it is reverted;
 *  - depth is whatever the book has. Nothing is overwritten, so nothing is
 *    lost, however many runs re-price the same lot.
 *
 * Without the restore below the lot would fall back to its per-lot buy cost
 * while an earlier run's disposal slot still says part of that cost was spent
 * — double-counted basis, understating every later gain.
 *
 * Only slot rows are deleted. No split, lot, or transaction is removed on this
 * path, which is what makes it safe to point at the user's own sell split.
 */
async function clearAverageCostArtifactsForRun(
  runId: string,
  artifacts: RunAverageArtifacts,
  tx: PrismaTx,
): Promise<void> {
  if (artifacts.splitGuids.length > 0) {
    await tx.slots.deleteMany({
      where: { obj_guid: { in: artifacts.splitGuids }, name: { in: [...AVG_SPLIT_SLOT_NAMES] } },
    });
  }

  const touchedLotGuids = [...new Set([...artifacts.lotGuids, ...artifacts.stashLotGuids])];
  if (touchedLotGuids.length === 0) return;

  // A lot the revert has already deleted (this run created it) gets its slots
  // dropped, never a restored value re-attached to a dead guid.
  const survivingLots = new Set(
    ((await tx.lots.findMany({
      where: { guid: { in: touchedLotGuids } },
      select: { guid: true },
    })) ?? []).map(l => l.guid),
  );

  for (const lotGuid of touchedLotGuids) {
    const stack = survivingLots.has(lotGuid)
      ? (await readAvgBasisWrites(lotGuid, tx)).filter(entry => entry.run !== runId)
      : [];
    await writeAvgBasisWrites(lotGuid, stack, tx);
  }
}

/**
 * Remaining cost basis of an open lot that existed BEFORE this run, used to
 * seed the average-cost pool.
 *
 * Prefers the lot's own `avg_cost_basis_remaining` slot (written by a previous
 * average-cost run — that IS the pooled basis of the shares it still holds).
 * Otherwise falls back to the same fee-inclusive pro-rata rule
 * `computeCarriedBasis` applies to a transfer: (buy cost + carried basis) per
 * bought share × shares still held. That fallback is the honest reading of a
 * lot the average method has never seen.
 */
async function openingBasisForExistingLot(
  lotGuid: string,
  shares: number,
  tx: PrismaTx,
): Promise<number> {
  const slot = await tx.slots.findFirst({
    where: { obj_guid: lotGuid, name: AVG_BASIS_REMAINING_SLOT },
    select: { string_val: true },
  });
  const parsed = slot?.string_val ? parseFloat(slot.string_val) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return (await computeCarriedBasis(lotGuid, shares, tx)) ?? 0;
}

async function assignWithStrategy(
  accountGuid: string,
  tx: PrismaTx,
  strategy: LotAssignmentMethod
): Promise<AutoAssignResult> {
  const runId = generateGuid();
  const warnings: string[] = [];
  const isAverage = strategy === 'average';

  // Fetch account commodity for transfer detection + commodity-aware epsilon
  const account = await tx.accounts.findUnique({
    where: { guid: accountGuid },
    select: { commodity_guid: true, commodity_scu: true },
  });
  if (!account) {
    throw new Error(`Account not found: ${accountGuid}`);
  }
  const qtyEps = qtyEpsilonForScu(account.commodity_scu);

  // Drop average-cost metadata before anything reads it when the run is NOT
  // an average-cost run. Placed ahead of the empty-splits early return so a
  // re-scrub of a fully-assigned account still switches methods cleanly.
  if (!isAverage) {
    await clearAverageCostArtifacts(accountGuid, tx);
  }

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

  // ── Average-cost pool ───────────────────────────────────────────────────
  //
  // JURISDICTIONAL SCOPE (assumed, not derived from the book):
  //  * The pool is ONE GnuCash account's holding of one commodity. That
  //    matches the US per-account rule for the average-basis method
  //    (Treas. Reg. §1.1012-1(e)(7)); it is NOT the all-holdings pooling some
  //    jurisdictions require (e.g. UK s.104 pools, Canadian ACB), which would
  //    have to span accounts. Shares moved between the user's own accounts
  //    carry their pooled basis across via `carried_basis`, so a book-wide
  //    pool and this per-account pool agree except when the same commodity is
  //    held in two accounts at once.
  //  * The engine does NOT police ELIGIBILITY. US average basis is confined to
  //    regulated-investment-company shares and certain DRIP stock
  //    (Treas. Reg. §1.1012-1(e)(1)); GnuCash records nothing that would let us
  //    tell an eligible fund from an ordinary equity, so the user's election is
  //    honoured for whatever account they choose it on. Choosing average cost
  //    for shares that are not eligible for it is the user's call.
  //  * Basis is FEE-INCLUSIVE: a buy-side commission is capitalized into the
  //    pool when the shares enter it (IRS Pub. 550), so it is averaged across
  //    the pool rather than tied to the lot that incurred it — which is what
  //    pooling means. Consumers read the pooled number and must not re-add
  //    buy-side fees; sell-side fees still reduce proceeds downstream.
  //
  // The pool is replayed event by event alongside the lots below, so every
  // sale is priced at the average AS OF ITS OWN DATE — the same requirement
  // that makes LIFO consume only lots existing at the sell date. Using the
  // final pool would back-date later purchases into earlier sales.
  let poolShares = 0;
  let poolBasis = 0;
  /** Fresh split values, read AFTER any zero-value trade revaluation above. */
  const valueBySplit = new Map<string, number>();
  let tradeFees: TradeFeeBySplit = NO_TRADE_FEES;

  if (isAverage) {
    const eventTxGuids = [...new Set(events.map(e => e.split.tx_guid))];
    const feeRows = eventTxGuids.length > 0
      ? await tx.splits.findMany({
          where: { tx_guid: { in: eventTxGuids } },
          include: {
            account: { select: { name: true, account_type: true } },
            transaction: { select: { post_date: true, description: true } },
          },
        })
      : [];
    for (const row of feeRows) {
      valueBySplit.set(row.guid, toDecimalNumber(row.value_num, row.value_denom));
    }
    // Same allocator the Form 8949 path and computeCarriedBasis use, so a
    // commission is charged identically wherever it is read.
    tradeFees = allocateTradeFees(feeRows.map(s => ({
      guid: s.guid,
      txGuid: s.tx_guid,
      accountGuid: s.account_guid,
      accountType: s.account?.account_type ?? '',
      accountPath: s.account?.name ?? '',
      value: toDecimalNumber(s.value_num, s.value_denom),
      quantity: toDecimalNumber(s.quantity_num, s.quantity_denom),
      txDescription: s.transaction?.description ?? undefined,
      txDate: s.transaction?.post_date?.toISOString(),
    }))).fees;

    for (const lot of openLots) {
      poolShares += lot.shares;
      poolBasis += await openingBasisForExistingLot(lot.guid, lot.shares, tx);
    }
  }

  /** Pooled basis per share right now; 0 once the pool is empty. */
  const averagePerShare = () => (poolShares > qtyEps ? poolBasis / poolShares : 0);

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
            select: {
              quantity_num: true, quantity_denom: true,
              value_num: true, value_denom: true,
            },
          });
          const shares = lotSplits.reduce(
            (sum, ls) => sum + toDecimalNumber(ls.quantity_num, ls.quantity_denom), 0,
          );
          const acqDate = await readLotAcquisitionDate(lotGuid, tx);
          openLots.push({ guid: lotGuid, shares, openDate: acqDate ?? s.post_date });
          if (isAverage) {
            // Transferred shares join the pool at the basis that TRAVELLED
            // with them, never at $0 and never at the transfer's recorded
            // value (ASI-1-002 / ADV-H4). Only a transfer the linker could not
            // trace back to a source lot falls back to the recorded value.
            const carried = await readCarriedBasis(lotGuid, tx);
            const recorded = lotSplits.reduce(
              (sum, ls) => sum + Math.abs(toDecimalNumber(ls.value_num, ls.value_denom)), 0,
            );
            poolShares += shares;
            poolBasis += Math.abs(carried) > 0.005 ? carried : recorded;
          }
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
        if (isAverage) {
          // Read the value from the post-revaluation snapshot: a zero-value
          // commodity-for-commodity trade was priced above, and the split row
          // captured before that pass still shows $0.
          const value = valueBySplit.get(s.guid)
            ?? toDecimalNumber(s.value_num, s.value_denom);
          poolShares += qty;
          poolBasis += Math.abs(value) + (tradeFees.get(s.guid) ?? 0);
        }
        break;
      }
      case 'adjustment': {
        const result = await assignAdjustmentToLots(s.guid, openLots, runId, tx, qtyEps);
        splitsCreated += result.subSplitsCreated.length;
        adjustmentCount++;
        if (result.warning) warnings.push(result.warning);
        if (isAverage && result.lotsUsed.length > 0) {
          // A stock split re-denominates the same investment: share count
          // moves, pooled basis does not — so the average per share falls (or
          // rises on a reverse split) by exactly the split ratio.
          poolShares += toDecimalNumber(s.quantity_num, s.quantity_denom);
        }
        break;
      }
      case 'sell': {
        // Price the disposal BEFORE it consumes the pool.
        const avgPerShare = averagePerShare();
        const searchOrder = orderLotsForConsumption(openLots, strategy);
        const result = await splitSellAcrossLots(s.guid, searchOrder, runId, tx, qtyEps);
        splitsCreated += result.subSplitsCreated.length;
        sellCount++;
        if (result.warning) {
          warnings.push(result.warning);
        }
        if (isAverage) {
          // Record each consuming row's pooled basis. Transfer-OUT splits are
          // classified as sells here too and get the slot as well: their basis
          // is what travels to the destination account (computeCarriedBasis
          // reads exactly this slot), while generateCapitalGains still books
          // no gain for a transfer-closed lot.
          let consumed = 0;
          for (const allocation of result.allocations) {
            await writeAvgCostBasis(allocation.splitGuid, avgPerShare * allocation.shares, runId, tx);
            consumed += allocation.shares;
          }
          poolShares -= consumed;
          poolBasis -= avgPerShare * consumed;
          if (poolShares <= qtyEps) {
            // Pool emptied: drop the sub-epsilon share and basis residue so a
            // later buy starts from its own cost instead of inheriting drift.
            poolShares = 0;
            poolBasis = 0;
          }
        }
        break;
      }
    }
  }

  // Generate capital gains for lots that are now closed (shares ~= 0)
  let gainsTransactions = 0;
  let totalRealizedGain = 0;

  // Final pooled basis per share, fixed once every event has been replayed.
  const finalAveragePerShare = averagePerShare();

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
    } else if (isAverage) {
      // Still-open lot: under pooling its remaining shares are worth the pool
      // average, NOT what this particular lot happened to pay. Recording it
      // keeps totalCost / unrealizedGain in @/lib/lots consistent with the
      // realized figures instead of silently reverting to per-lot cost.
      await writeAvgBasisRemaining(lot.guid, finalAveragePerShare * lot.shares, runId, tx);
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
 *
 * The callers now take that same lock up front (see lockAccountTransactions),
 * so re-taking it here is a no-op on rows this transaction already holds. It
 * is kept so the function stays correct if ever called on its own.
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

/**
 * Lock every transaction holding a split in this account, in canonical guid
 * order. Lot operations rewrite the account's splits wholesale, and the
 * reconciled-split policy below is only race-free while these rows are held:
 * the book advisory lock serializes lot runs against each other, not against
 * the reconcile routes, which take exactly this transaction-row lock.
 */
async function lockAccountTransactions(
  tx: PrismaTx,
  accountGuid: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT guid FROM transactions
    WHERE guid IN (SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ${accountGuid})
    ORDER BY guid
    FOR UPDATE
  `;
}

/**
 * Reconciled/frozen policy for the lot engine's REVERT paths
 * (clearLotAssignments, revertScrubRun).
 *
 * A revert does three different things, and only two of them can break the
 * book's agreement with a bank statement:
 *
 *  1. **Deleting a wholly generated transaction** (a realized-gain posting
 *     from generateCapitalGains). Nothing restores that amount — the account
 *     simply loses a posting. Those splits are created 'n', but they appear
 *     in the ledger and a user can reconcile them afterwards, so the check is
 *     live, not dead code. → GUARDED.
 *
 *  2. **Restoring a split the run rewrote IN PLACE with no sub-split rows to
 *     delete alongside it.** That is the valueZeroValueTrade shape: the run
 *     rewrote both trade legs from 0 to ±FMV and tagged both, so the "restore"
 *     puts a real FMV back to zero on each leg with no compensating row. The
 *     transaction stays balanced — which is exactly why a balance check misses
 *     it — but EACH ACCOUNT's reconciled balance moves. → GUARDED.
 *
 *  3. **Deleting the run's sub-split rows while restoring their parent in the
 *     same transaction.** This is the exact inverse of splitSellAcrossLots:
 *     the sub-splits inherit the parent's reconcile metadata and sum back to
 *     the restored original, so the account's reconciled total is identical
 *     before and after. → EXEMPT.
 *
 * ## Telling (2) apart from (3) — PER SPLIT, not per transaction
 *
 * Compensation is a relationship between one restored parent and the specific
 * rows carved out of IT. Two weaker tests both fail:
 *
 *   - co-tagging with the same runId: valueZeroValueTrade tags both of its
 *     legs, so each leg has a tagged sibling and reads as compensated;
 *   - "this transaction contains some deleted sub-split": one runId covers
 *     every event in an account, so a single parent transaction can hold BOTH
 *     a partitioned sale and an in-place zero-value-trade rewrite. The sale's
 *     deleted sub-split would then exempt the trade legs, and they would be
 *     restored from ±FMV back to zero while reconciled.
 *
 * So compensation is established per restored split, via provenance recorded
 * at creation time: every generated sub-split carries a PARENT_SPLIT_SLOT
 * naming the split it was carved out of. A restore is compensated only when a
 * row being DELETED by this revert names THAT split as its parent.
 *
 *   partition (3): parent restored in place + sub-split ROWS deleted whose
 *                  PARENT_SPLIT_SLOT points back at that parent.
 *   in-place  (2): the rewritten legs are each restored from their own
 *                  original_* slots and nothing names them as a parent, so
 *                  nothing compensates them — regardless of what else the run
 *                  did in the same transaction.
 *
 * This is fail-closed by construction: missing or corrupt provenance (which
 * includes every sub-split written before this marker existed) yields no
 * matching parent reference, so the restore is treated as uncompensated and
 * blocked rather than guessed at.
 *
 * The deliberate decision is (3): a generated row that merely INHERITED 'y'
 * or 'f' from the split it was carved out of is not an independent statement
 * agreement, and deleting it is only half of an atomic, net-zero repartition.
 * Guarding it would make lot revert impossible on any reconciled investment
 * account while protecting nothing — the same reasoning that makes the
 * forward scrub (splitSellAcrossLots) exempt.
 */
async function assertRevertPreservesReconciled(
  tx: PrismaTx,
  operation: string,
  input: {
    /** Transactions being deleted whole (generated gains transactions). */
    deletedTxGuids: string[];
    /** Splits being restored in place from their original_* slots. */
    restoredSplitGuids: string[];
    /** Every split this run tagged, used to detect the compensated case. */
    taggedSplitGuids: string[];
  },
): Promise<void> {
  const { deletedTxGuids, restoredSplitGuids, taggedSplitGuids } = input;
  if (deletedTxGuids.length === 0 && restoredSplitGuids.length === 0) return;

  const or: Prisma.splitsWhereInput[] = [];
  if (deletedTxGuids.length > 0) or.push({ tx_guid: { in: deletedTxGuids } });
  if (restoredSplitGuids.length > 0) or.push({ guid: { in: restoredSplitGuids } });

  const protectedRows = await tx.splits.findMany({
    where: {
      OR: or,
      reconcile_state: { in: [...PROTECTED_RECONCILE_STATES] },
    },
    select: {
      guid: true,
      tx_guid: true,
      account_guid: true,
      reconcile_state: true,
      account: { select: { name: true } },
    },
  });
  if (protectedRows.length === 0) return;

  // Which tagged splits does this revert DELETE? A tagged split that is
  // itself being restored compensates nothing (it is a parent, not a piece of
  // one), and one vanishing with a wholly-generated transaction belongs to
  // case (1), not to any partition.
  const restoredSet = new Set(restoredSplitGuids);
  const deletedTxSet = new Set(deletedTxGuids);
  const deletedSubSplitGuids: string[] = [];
  if (taggedSplitGuids.length > 0) {
    const tagged = await tx.splits.findMany({
      where: { guid: { in: taggedSplitGuids } },
      select: { guid: true, tx_guid: true },
    });
    for (const s of tagged) {
      if (restoredSet.has(s.guid)) continue;
      if (deletedTxSet.has(s.tx_guid)) continue;
      deletedSubSplitGuids.push(s.guid);
    }
  }

  // Resolve those deletions to the SPECIFIC parent each was carved out of.
  // Being in the same transaction is not enough — see the note above.
  const compensatedParents = new Set<string>();
  if (deletedSubSplitGuids.length > 0) {
    const provenance = await tx.slots.findMany({
      where: { obj_guid: { in: deletedSubSplitGuids }, name: PARENT_SPLIT_SLOT },
      select: { string_val: true },
    });
    for (const p of provenance) {
      if (p.string_val) compensatedParents.add(p.string_val);
    }
  }

  const offending = protectedRows.filter(row => {
    // (1) vanishing with a wholly-generated transaction — nothing restores it.
    if (deletedTxSet.has(row.tx_guid)) return true;
    // Not restored and not in a deleted transaction: untouched by this revert.
    if (!restoredSet.has(row.guid)) return false;
    // (3) exempt only when a row being deleted names THIS split as its parent;
    // (2) guarded otherwise — including a zero-value-trade leg sitting in the
    // same transaction as an unrelated partitioned sale, and any sub-split
    // predating the provenance marker (fail closed).
    return !compensatedParents.has(row.guid);
  });

  assertSplitsNotProtected(operation, offending);
}

const LOT_ASSIGNMENT_METHODS: readonly LotAssignmentMethod[] = ['fifo', 'lifo', 'average'];

export async function autoAssignLots(
  accountGuid: string,
  method: LotAssignmentMethod,
  bookGuid?: string
): Promise<AutoAssignResult> {
  return prisma.$transaction(async (tx) => {
    await guardBookLock(tx, bookGuid, 'lot auto-assign');

    // Canonical parent lock BEFORE the assign pass, not at the token bump
    // below. Two things went wrong when it was taken late:
    //
    //  1. Correctness. assign* reaches splitSellAcrossLots, which rewrites the
    //     original split's amount and creates sub-splits that INHERIT its
    //     reconcile state. A concurrent reconcile could lock the parent and
    //     commit 'y' after the unlocked read but before the write, so the
    //     sub-splits inherited a stale 'n' while a now-reconciled split's
    //     amount changed underneath it.
    //  2. Deadlock. Auto-assign wrote splits first and only took the parent
    //     lock at bumpAccountTransactionTokens; a reconcile takes the parent
    //     lock first and then writes its split. Opposite orders — an ABBA
    //     deadlock. Locking here restores the canonical parents-then-splits
    //     order the rest of the codebase uses.
    //
    // The book advisory lock above does NOT cover this: it serializes lot
    // operations against each other, not against the reconcile routes.
    await lockAccountTransactions(tx, accountGuid);

    if (!LOT_ASSIGNMENT_METHODS.includes(method)) {
      throw new Error(`Unknown assignment method: ${method}`);
    }
    const result = await assignWithStrategy(accountGuid, tx, method);
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

    // Canonical parent lock before anything is read: everything this function
    // rewrites or deletes hangs off a transaction holding a split in this
    // account, and the reconciled policy below must not be raced.
    await lockAccountTransactions(tx, accountGuid);

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

    // Identify the wholly-generated (gains) transactions up front, so the
    // reconciled policy can run BEFORE the first write below rather than
    // after half the restores have landed.
    const taggedSplitsInAccount = await tx.splits.findMany({
      where: { guid: { in: taggedSplitGuids } },
      select: { tx_guid: true, guid: true },
    });
    const candidateTxGuids = [...new Set(taggedSplitsInAccount.map(s => s.tx_guid))];
    const generatedTxGuids: string[] = [];
    for (const txGuid of candidateTxGuids) {
      const txSplitGuids = (await tx.splits.findMany({
        where: { tx_guid: txGuid },
        select: { guid: true },
      })).map(s => s.guid);
      const taggedCount = await tx.slots.count({
        where: { obj_guid: { in: txSplitGuids }, name: 'gnucash_web_generated' },
      });
      if (taggedCount === txSplitGuids.length) generatedTxGuids.push(txGuid);
    }

    // Reconciled/frozen policy — see assertRevertPreservesReconciled.
    await assertRevertPreservesReconciled(tx, 'clear the lot assignments on this account', {
      deletedTxGuids: generatedTxGuids,
      restoredSplitGuids: originalQtySlots.map(s => s.obj_guid),
      taggedSplitGuids,
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

    // Delete the wholly-generated (gains) transactions identified above.
    for (const txGuid of generatedTxGuids) {
      const txSplitGuids = (await tx.splits.findMany({
        where: { tx_guid: txGuid },
        select: { guid: true },
      })).map(s => s.guid);

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

    // Average-cost metadata is never carried by the `gnucash_web_generated`
    // marker (that marker means "delete this row", and these slots sit on the
    // user's own sell splits), so the tagged sweep above cannot reach it.
    // Clearing an account destroys its whole lot structure, so EVERY run's
    // slots go, not just one run's — leaving any behind would keep
    // generateCapitalGains, the lot summaries and Form 8949 pricing disposals
    // at a pooled basis for an account that no longer has lots.
    await clearAverageCostArtifacts(accountGuid, tx);

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
          name: { in: ['title', 'source_lot_guid', 'acquisition_date', 'carried_basis', ...AVG_LOT_SLOT_NAMES, 'gnucash_web_generated'] },
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

    // Average-cost slots are found by their OWN run companions, not by the
    // generated-entity marker — a one-lot sale is assigned straight to the
    // user's split, so an average run can write slots without tagging a single
    // entity. Enumerated BEFORE the early return below: exiting on
    // `taggedGuids.length === 0` used to leave such a run's pooled basis live
    // for computeCarriedBasis and Form 8949 to read, while the caller was told
    // the run had been reverted.
    const avgArtifacts = await findAverageCostArtifactsForRun(runId, tx);
    if (taggedGuids.length === 0 && !hasRunAverageArtifacts(avgArtifacts)) {
      return { reverted: 0 };
    }

    // ── Enumerate everything the run touched BEFORE deleting anything ──
    //
    // These reads run before the parent lock below. That is safe for the
    // reconciled guard specifically because the only column it depends on
    // here is tx_guid, which a split never changes — so the lock set derived
    // from it cannot go stale, and every reconcile_state read happens after
    // the lock. account_guid is NOT immutable (a bulk split move rewrites
    // it); the values read here feed only the book-scope pre-check and the
    // token bump, never the reconciled-split decision.
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
      select: { guid: true, account_guid: true, tx_guid: true },
    });
    const taggedLots = await tx.lots.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true, account_guid: true },
    });

    // Owners of this run's average-cost slots. These rows are NOT tagged, so
    // they are enumerated separately — and they are the user's own splits and
    // pre-existing lots, which means they carry accounts the tagged sweep may
    // not mention at all. Both the book-scope check and the token bump below
    // need them.
    const avgSplitOwners = avgArtifacts.splitGuids.length > 0
      ? ((await tx.splits.findMany({
          where: { guid: { in: avgArtifacts.splitGuids } },
          select: { guid: true, account_guid: true, tx_guid: true, lot_guid: true },
        })) ?? [])
      : [];
    const avgLotOwnerGuids = [...new Set([...avgArtifacts.lotGuids, ...avgArtifacts.stashLotGuids])];
    const avgLotOwners = avgLotOwnerGuids.length > 0
      ? ((await tx.lots.findMany({
          where: { guid: { in: avgLotOwnerGuids } },
          select: { guid: true, account_guid: true },
        })) ?? [])
      : [];

    // Book-scope check: run IDs are returned in API responses, so an editor
    // of one book must not be able to destroy another book's scrub run by
    // replaying a runId. Abort before any deletion when the run touches
    // accounts outside the caller's book.
    if (options.allowedAccountGuids) {
      const allowed = new Set(options.allowedAccountGuids);
      const affectedAccounts = new Set<string>();
      for (const s of txSplits) affectedAccounts.add(s.account_guid);
      for (const s of taggedSplits) affectedAccounts.add(s.account_guid);
      for (const s of avgSplitOwners) affectedAccounts.add(s.account_guid);
      for (const l of [...taggedLots, ...avgLotOwners]) {
        if (l.account_guid) affectedAccounts.add(l.account_guid);
      }
      for (const accountGuid of affectedAccounts) {
        if (!allowed.has(accountGuid)) {
          throw new ScrubRunNotInBookError(runId);
        }
      }
    }

    // Canonical parent lock over every transaction this revert touches —
    // the generated ones being deleted plus the parents of the splits being
    // restored or removed — taken BEFORE the reconcile-state read below and
    // before the first write. Ordered by guid inside the helper.
    await lockTransactionsForUpdate(
      [...txGuids, ...taggedSplits.map(s => s.tx_guid), ...avgSplitOwners.map(s => s.tx_guid)],
      tx,
    );

    // The splits this run modified IN PLACE carry original_* slots; they are
    // restored rather than deleted. Enumerated here (before any write) both
    // for the policy check and for the restore loop further down.
    const originalQtySlots = await tx.slots.findMany({
      where: { name: 'original_quantity_num', obj_guid: { in: taggedGuids } },
      select: { obj_guid: true, string_val: true },
    });

    // Reconciled/frozen policy — see assertRevertPreservesReconciled.
    await assertRevertPreservesReconciled(tx, 'revert this lot scrub run', {
      deletedTxGuids: txGuids,
      restoredSplitGuids: originalQtySlots.map(s => s.obj_guid),
      taggedSplitGuids: taggedSplits.map(s => s.guid),
    });

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
    // (originalQtySlots was read above, before the policy check.)
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

    // Undo THIS RUN's average-cost slots. Scoped by run, never by account:
    // an investment account accumulates slots from every run that ever
    // scrubbed it, so the account-wide sweep used here before deleted the
    // basis an EARLIER run had recorded on an already-filed sale — a
    // reversible action on one run rewriting another run's tax number, with
    // no error and nothing visible in the UI.
    await clearAverageCostArtifactsForRun(runId, avgArtifacts, tx);

    // ── Detach the disposals this run priced ────────────────────────────────
    //
    // A sale that fits inside ONE lot is assigned straight to the user's own
    // split, with no generated sub-split to tag, so nothing above reaches it:
    // the revert dropped its `avg_cost_basis` and left it attached, and the
    // still-closed lot went on reporting the sale at the lot's own buy cost
    // instead of the pooled basis the user had already seen — a bigger gain on
    // a Form 8949 line, produced by an operation that reported success.
    //
    // `avgArtifacts.splitGuids` names exactly the splits this run priced, so
    // undoing the assignment needs no marker on a user row: only `lot_guid` is
    // cleared, exactly as the modified-original restore above does it. Nothing
    // is tagged `gnucash_web_generated` and no user row is deleted — the two
    // things this design must never do. Splits the sweep already deleted are
    // simply absent, so the update passes over them.
    if (avgArtifacts.splitGuids.length > 0) {
      await tx.splits.updateMany({
        where: { guid: { in: avgArtifacts.splitGuids }, lot_guid: { not: null } },
        data: { lot_guid: null },
      });
    }

    // A lot those disposals had emptied is holding its shares again. Left
    // flagged closed it would be skipped by the next scrub's open-lot query,
    // hiding real shares from the pool that re-prices them.
    const detachedLotGuids = [...new Set(
      avgSplitOwners.map(s => s.lot_guid).filter((g): g is string => g !== null && g !== undefined),
    )];
    if (detachedLotGuids.length > 0) {
      const stillClosed = (await tx.lots.findMany({
        where: { guid: { in: detachedLotGuids }, is_closed: 1 },
        select: { guid: true },
      })) ?? [];
      for (const lot of stillClosed) {
        const remaining = (await tx.splits.findMany({
          where: { lot_guid: lot.guid },
          select: { quantity_num: true, quantity_denom: true },
        })) ?? [];
        const shares = remaining.reduce(
          (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom), 0,
        );
        if (Math.abs(shares) > 1e-9) {
          await tx.lots.update({ where: { guid: lot.guid }, data: { is_closed: 0 } });
        }
      }
    }

    // Bump the concurrency token on every account the revert rewrote
    // (restored sell splits, detached lots, dropped average-cost slots) so
    // stale editors 409 instead of silently re-applying pre-revert state.
    const revertedAccounts = new Set<string>();
    for (const s of [...taggedSplits, ...avgSplitOwners]) revertedAccounts.add(s.account_guid);
    for (const l of [...taggedLots, ...avgLotOwners]) {
      if (l.account_guid) revertedAccounts.add(l.account_guid);
    }
    for (const accountGuid of Array.from(revertedAccounts).sort()) {
      await bumpAccountTransactionTokens(tx, accountGuid);
    }

    // Count entities this revert actually undid. Averaged books reach here
    // with untagged owners (the user's own one-lot sale, a pre-existing lot
    // re-priced by the pool), so they are unioned in rather than added —
    // a generated sub-split that also carried a basis slot is one entity.
    const revertedGuids = new Set<string>([
      ...taggedGuids,
      ...avgArtifacts.splitGuids,
      ...avgArtifacts.lotGuids,
      ...avgArtifacts.stashLotGuids,
    ]);

    return { reverted: revertedGuids.size };
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
  method: LotAssignmentMethod,
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
  method: LotAssignmentMethod,
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

    // Identify sells and buys. Transfer-ins are excluded from BOTH the
    // replacement-share candidates and the loss heuristic: moving shares
    // between one's own accounts is not an acquisition under §1091.
    const buys = allSplits.filter(s =>
      toDecimalNumber(s.quantity_num, s.quantity_denom) > 0 &&
      !isOwnAccountCommodityTransfer(s, commodityGuid, 'in')
    );

    // A transfer-out can share a lot with actual sales. Excluding its split
    // from only the final allocation is insufficient: its $0 proceeds would
    // still make the lot-level calculation fabricate a loss. Keep the same
    // transfer identification used by the scrubber and omit those splits from
    // both the calculation and the wash-sale candidate set.
    const transferOutSplitGuids = new Set(allSplits
      .filter(s =>
        isOwnAccountCommodityTransfer(s, commodityGuid, 'out')
      )
      .map(s => s.guid));

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
    const carriedBasisSlots = lotGuids.length > 0
      ? await prisma.slots.findMany({
          where: { obj_guid: { in: lotGuids }, name: 'carried_basis' },
          select: { obj_guid: true, string_val: true },
        })
      : [];
    const carriedBasisByLot = new Map(carriedBasisSlots.map(slot => {
      const parsed = slot.string_val ? Number.parseFloat(slot.string_val) : NaN;
      return [slot.obj_guid, Number.isFinite(parsed) ? parsed : 0] as const;
    }));
    // Average-cost basis per disposal split, so a book scrubbed under that
    // election measures its wash-sale LOSSES against the pooled basis too —
    // FIFO basis here would disallow the wrong amount, or miss the loss.
    const avgCostBasisBySplit = allSplits.length > 0
      ? new Map((await prisma.slots.findMany({
          where: { obj_guid: { in: allSplits.map(s => s.guid) }, name: AVG_COST_BASIS_SLOT },
          select: { obj_guid: true, string_val: true },
        })).flatMap(slot => {
          const parsed = slot.string_val ? Number.parseFloat(slot.string_val) : NaN;
          return Number.isFinite(parsed) ? [[slot.obj_guid, parsed] as const] : [];
        }))
      : new Map<string, number>();
    // Only newly scrubbed transfer lots have carried basis. Legacy lots retain
    // their recorded value until a re-scrub supplies its replacement basis.
    const transferInSplitGuids = new Set(allSplits
      .filter(s => Boolean(s.lot_guid) && (carriedBasisByLot.get(s.lot_guid!) ?? 0) > 0)
      .filter(s => isOwnAccountCommodityTransfer(s, commodityGuid, 'in'))
      .map(s => s.guid));

    for (const s of allSplits) {
      const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
      if (qty >= 0) continue; // Not a sell
      if (transferOutSplitGuids.has(s.guid)) continue;

      const val = toDecimalNumber(s.value_num, s.value_denom);

      // If sell is assigned to a lot, check lot-level realized gain.
      // Native GnuCash signs: trading splits sum to basis - proceeds, so
      // gain = -(sum). Zero-quantity gains offset splits are excluded.
      if (s.lot_guid) {
        const lot = lotMap.get(s.lot_guid);
        if (lot) {
          const lotSplits = lot.splits
            .filter(ls => !transferOutSplitGuids.has(ls.guid))
            .map(ls => {
              const avgCostBasis = avgCostBasisBySplit.get(ls.guid);
              return {
                guid: ls.guid,
                shares: toDecimalNumber(ls.quantity_num, ls.quantity_denom),
                value: toDecimalNumber(ls.value_num, ls.value_denom),
                ...(avgCostBasis !== undefined ? { avgCostBasis } : {}),
              };
            });
          const totalQty = lotSplits.reduce(
            (sum, ls) => sum + ls.shares, 0
          );
          const isClosed = Math.abs(totalQty) < 0.0001;
          const realizedGain = computeRealizedGain(
            lotSplits,
            isClosed,
            carriedBasisByLot.get(lot.guid) ?? 0,
            transferInSplitGuids,
          );
          const totalSoldShares = lotSplits
            .filter(ls => ls.shares < -0.0001)
            .reduce((sum, ls) => sum + Math.abs(ls.shares), 0);
          // Attribute a multi-sale lot's total realized loss pro rata to this
          // sell instead of repeating the whole loss for every sell split.
          if (realizedGain < 0 && totalSoldShares > 0) {
            const thisSellShares = Math.abs(qty);
            sells.push({
              ...s,
              realizedLoss: realizedGain * Math.min(1, thisSellShares / totalSoldShares),
            });
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

    // Replacement shares can disallow only one sale. Track the unconsumed
    // quantity on every buy so a small DRIP cannot wash multiple full sales.
    const remainingReplacementShares = new Map(
      buys.map(buy => [
        buy.guid,
        Math.max(0, toDecimalNumber(buy.quantity_num, buy.quantity_denom)),
      ]),
    );

    // Check each loss-sell for wash sale: any buy of same commodity within 30 days
    for (const sell of sells) {
      const sellDate = sell.transaction?.post_date;
      if (!sellDate) continue;
      const sellDayMs = utcDayMs(sellDate);
      const soldShares = Math.abs(toDecimalNumber(sell.quantity_num, sell.quantity_denom));
      let unmatchedSoldShares = soldShares;

      for (const buy of buys) {
        if (unmatchedSoldShares <= 0.0001) break;
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
          const availableReplacementShares = remainingReplacementShares.get(buy.guid) ?? 0;
          const replacementShares = Math.min(availableReplacementShares, unmatchedSoldShares);
          if (replacementShares <= 0.0001) continue;
          const disallowedRatio = soldShares > 0
            ? replacementShares / soldShares
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
            replacementShares,
            daysApart,
          });
          remainingReplacementShares.set(buy.guid, availableReplacementShares - replacementShares);
          unmatchedSoldShares -= replacementShares;
        }
      }
    }
  }

  return washSales;
}
