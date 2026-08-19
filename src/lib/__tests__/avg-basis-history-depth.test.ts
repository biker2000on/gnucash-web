/**
 * DEPTH PROOF for the average-cost write history.
 *
 * The run-provenance work fixed the shallow case: run A prices a sale at the
 * pooled basis, run B later re-prices the open lot, reverting B restores A's
 * number instead of dropping it. That test lives in
 * lot-assignment-average-cost.test.ts.
 *
 * This file drives the SAME shape at depth, which is where the fix used to
 * stop working. While the history was a JSON array in `slots.string_val` - a
 * VARCHAR(4096) - it held only some 48-80 writes per lot, and the code stayed
 * inside the column by DROPPING the oldest entries with a `console.warn`.
 * Unwinding a book past that point therefore walked off the end of its own
 * history and fell back to the lot's own purchase cost, which is a different
 * number on Form 8949 - reached by an operation that reported success at every
 * step, with nothing but a server-log warning to show for it.
 *
 * Every figure below is hand-computed in the comments, and the two candidate
 * numbers (pooled and per-lot) are both written out, so the assertion is the
 * DIFFERENCE between them rather than an artifact of the harness.
 *
 * The file deliberately uses only the engine's public surface -
 * autoAssignLots, revertScrubRun, writeAvgBasisRemaining, getAccountLots,
 * lotToRealizedSales - so it can be run unchanged against the pre-fix tree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../prisma', async () => ({
  default: (await import('./helpers/avg-cost-book')).fakePrisma,
}));
vi.mock('../db', () => ({ tryWithDatabaseAdvisoryLock: vi.fn() }));
vi.mock('../book-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../book-lock')>()),
  bookLockKey: vi.fn(() => 'lock'),
  tryAcquireBookLock: vi.fn(async () => true),
  accountNameLockKey: vi.fn((parent: string, name: string) => `${parent}:${name}`),
  acquireNamedXactLock: vi.fn(async () => false),
}));
vi.mock('../commodities', () => ({ getLatestPrice: vi.fn(async () => null) }));

import { autoAssignLots, revertScrubRun } from '../lot-assignment';
import {
  AvgBasisHistoryRepairRequiredError,
  readAvgBasisWrites,
  writeAvgBasisRemaining,
  writeAvgBasisWrites,
  type PrismaTx,
} from '../lot-scrub';
import { generateGuid } from '../gnucash';
import { getAccountLots } from '../lots';
import { lotToRealizedSales } from '../reports/capital-gains';
import {
  STOCK_ACCT,
  addTrade,
  fakePrisma,
  avgBasisHistory,
  lotOfSplit,
  remainingOf,
  resetDb,
  resetGuidSeq,
  seedBaseAccounts,
} from './helpers/avg-cost-book';

beforeEach(() => {
  resetDb();
  resetGuidSeq();
  seedBaseAccounts();
});

/**
 * How many later runs re-price the open lot before the unwind. The JSON stash
 * fitted roughly 66 entries of the shape `{"run":"<32 hex>","value":"1234"}`
 * into its 4000-character budget, so 120 pushes the oldest writes - run A's
 * among them - off the bottom.
 */
const LATER_RUNS = 120;

describe('average-cost write history at depth', () => {
  it('unwinds 120 runs back to the original pooled basis, not the per-lot cost', async () => {
    /* ── Run A ──────────────────────────────────────────────────────────
     *   buy  2024-01-01  10 sh for $1,000   ($100/sh)   -> lot 1
     *   buy  2024-02-01  10 sh for $3,000   ($300/sh)   -> lot 2
     *   pool 20 sh / $4,000                             -> $200/sh
     *   sell 2024-03-01  15 sh for $6,000
     *        pooled basis 15 x $200 = $3,000, gain $3,000
     *        consumed oldest-first: all 10 of lot 1, 5 of lot 2
     *        lot 2 keeps 5 sh, pooled remaining 5 x $200 = $1,000
     *
     * Lot 2's OWN cost for those 5 shares is 5/10 x $3,000 = $1,500. That is
     * the wrong number this test is about: it is what every fallback path
     * produces once the pooled value is lost.
     */
    addTrade('2024-01-01', 10, 1000);
    const buy2 = addTrade('2024-02-01', 10, 3000);
    const sellGuid = addTrade('2024-03-01', -15, 6000);
    const runA = await autoAssignLots(STOCK_ACCT, 'average');

    const lot2 = lotOfSplit(buy2)!;
    const POOLED_REMAINING = 1000;
    const PER_LOT_REMAINING = 1500;
    expect(remainingOf(lot2)).toBeCloseTo(POOLED_REMAINING, 6);

    const filedSale = (await getAccountLots(STOCK_ACCT))
      .flatMap(l => lotToRealizedSales(l, 'AAPL'))
      .reduce((sum, s) => sum + s.costBasis, 0);
    expect(filedSale).toBeCloseTo(3000, 6);
    expect(sellGuid).toBeTruthy();

    /* ── 120 later average runs ─────────────────────────────────────────
     * Each one re-prices the still-open lot 2, exactly as a scrub does, and
     * pushes the value it displaces onto the lot's write history.
     */
    const tx = fakePrisma as unknown as PrismaTx;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const laterRuns: string[] = [];
    for (let k = 0; k < LATER_RUNS; k++) {
      const runId = generateGuid();
      laterRuns.push(runId);
      await writeAvgBasisRemaining(lot2, 2000 + k, runId, tx);
    }
    expect(remainingOf(lot2)).toBeCloseTo(2000 + LATER_RUNS - 1, 6);

    const droppedWrites = warn.mock.calls.length;
    warn.mockRestore();

    /* ── Unwind, newest first ───────────────────────────────────────────*/
    for (let k = LATER_RUNS - 1; k >= 0; k--) {
      await revertScrubRun(laterRuns[k]);
    }

    const afterUnwind = remainingOf(lot2);

    /* ── The number that lands on a return ──────────────────────────────
     *   sell 2025-06-01  the last 5 sh for $3,500
     *
     * pooled  : basis $1,000 -> gain $2,500
     * per-lot : basis $1,500 -> gain $2,000
     */
    const finalSell = addTrade('2025-06-01', -5, 3500);
    await autoAssignLots(STOCK_ACCT, 'average');
    const finalLot = lotOfSplit(finalSell) ?? lot2;
    const finalSale = (await getAccountLots(STOCK_ACCT))
      .filter(l => l.guid === finalLot)
      .flatMap(l => lotToRealizedSales(l, 'AAPL'))
      .find(s => Math.abs(s.proceeds - 3500) < 0.01);

    console.log('\n===== AVERAGE-COST HISTORY DEPTH PROOF =====');
    console.log(`run A: ${runA.runId}`);
    console.log(`later runs re-pricing the open lot          : ${LATER_RUNS}`);
    console.log(`console.warn "dropped oldest write" events  : ${droppedWrites}`);
    console.log(`lot 2 pooled remaining, run A               : ${POOLED_REMAINING}`);
    console.log(`lot 2 pooled remaining, after full unwind   : ${afterUnwind}`);
    console.log(`lot 2 per-lot (WRONG) cost for 5 shares     : ${PER_LOT_REMAINING}`);
    console.log(`final sale 5 sh @ $3,500 -> reported basis  : ${finalSale?.costBasis}`);
    console.log(`final sale 5 sh @ $3,500 -> reported gain   : ${
      finalSale ? finalSale.proceeds - finalSale.costBasis : undefined
    }`);
    console.log(`   correct (pooled)  basis $1000 / gain $2500`);
    console.log(`   wrong   (per-lot) basis $1500 / gain $2000`);
    console.log('============================================\n');

    // No write was ever given up to a column width.
    expect(droppedWrites).toBe(0);
    // The unwind walked all the way back to run A's number.
    expect(afterUnwind).toBeCloseTo(POOLED_REMAINING, 6);
    expect(afterUnwind).not.toBeCloseTo(PER_LOT_REMAINING, 6);
    // And the sale that number prices reports the pooled basis, not per-lot.
    expect(finalSale?.costBasis).toBeCloseTo(1000, 6);
    expect(finalSale!.proceeds - finalSale!.costBasis).toBeCloseTo(2500, 6);
  });

  /**
   * The second silent degradation: the stack was ONE JSON document, so any
   * structural damage - a lost brace, a truncated write - made `JSON.parse`
   * throw and the decoder return NOTHING. Measured on the pre-fix tree, a
   * 40-entry document lost all 40 to a single bad byte.
   *
   * One row per write cannot do that. What it CAN still hit is a damaged entry
   * that would have to become the live value, and that raises rather than
   * substituting a number nobody can check.
   */
  it('survives a damaged entry, and refuses to publish an unreadable one', async () => {
    const tx = fakePrisma as unknown as PrismaTx;
    const lot = 'lot-corruption-proof';
    const stack = Array.from({ length: 40 }, (_, i) => ({
      run: `run-${String(i).padStart(28, '0')}`,
      value: String(1000 + i),
    }));
    await writeAvgBasisWrites(lot, stack, tx);

    // One row damaged, deep in the stack.
    avgBasisHistory.rows.find(r => r.lot_guid === lot && r.seq_no === 7)!.basis_val = '10{7';
    const afterDamage = await readAvgBasisWrites(lot, tx);
    const readable = afterDamage.filter(e => !e.corrupt);

    // The damaged entry is the one that would become live.
    let repairError: unknown = null;
    try {
      await writeAvgBasisWrites(lot, afterDamage.slice(0, 8), tx);
    } catch (error) {
      repairError = error;
    }

    console.log('\n===== CORRUPTION PROOF =====');
    console.log(`entries written                             : ${stack.length}`);
    console.log(`entries still readable after ONE bad byte   : ${readable.length}`);
    console.log(`entries flagged corrupt                     : ${afterDamage.length - readable.length}`);
    console.log(`live value still published                  : ${remainingOf(lot)}`);
    console.log(`publishing the damaged entry raises         : ${
      repairError instanceof Error ? repairError.name : String(repairError)
    }`);
    console.log(`   pre-fix, one bad byte left 0 of 40 entries readable`);
    console.log('============================\n');

    expect(afterDamage).toHaveLength(40);
    expect(readable).toHaveLength(39);
    expect(remainingOf(lot)).toBeCloseTo(1039, 6);
    expect(repairError).toBeInstanceOf(AvgBasisHistoryRepairRequiredError);
  });
});
