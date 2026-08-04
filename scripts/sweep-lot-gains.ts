/**
 * Sweep: book missing capital-gains offsets on legacy closed lots.
 *
 * The 2026-08-04 audit found 106 closed lots with a nonzero value sum and NO
 * gains offset split — closed by earlier scrub runs or desktop GnuCash before
 * gains generation existed. This driver finds those lots and runs the REAL
 * engine (generateCapitalGains in src/lib/lot-scrub.ts) on each, so every
 * rule the engine enforces applies here too: pre-existing-gains skip,
 * transfer-close skip (basis carried), zero-proceeds refusal, break-even
 * skip, TAX_EXEMPT skip, holding-period classification, and gains-account
 * resolution. Nothing is reimplemented.
 *
 * DEFAULT IS DRY-RUN: each lot runs inside a transaction that is rolled
 * back, so the printed results (including gains-account creation) are exactly
 * what --apply would do. Pass --apply to commit. Connection from DATABASE_URL.
 *
 * All booked transactions are tagged gnucash_web_generated with this run's
 * runId (printed at start), so the existing revert path can undo the sweep.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/sweep-lot-gains.ts           # dry-run
 *   DATABASE_URL=postgresql://... npx tsx scripts/sweep-lot-gains.ts --apply   # write
 */

import prisma from '../src/lib/prisma';
import { generateCapitalGains } from '../src/lib/lot-scrub';
import { generateGuid, toDecimalNumber } from '../src/lib/gnucash';

const APPLY = process.argv.includes('--apply');
const ROLLBACK = Symbol('dry-run rollback');
const VAL_EPS = 0.005;

async function main() {
  const runId = generateGuid();
  console.log(
    `sweep-lot-gains ${APPLY ? '*** APPLY MODE ***' : '(dry-run — pass --apply to write)'} runId=${runId}`,
  );

  // Candidates: lots whose splits sum to ~zero shares but a nonzero value,
  // with no zero-quantity nonzero-value (gains offset) split. The engine
  // re-validates every one of these conditions per lot with commodity-aware
  // epsilons; this query only narrows the working set.
  const lots = await prisma.lots.findMany({
    select: {
      guid: true,
      account_guid: true,
      splits: {
        select: {
          quantity_num: true,
          quantity_denom: true,
          value_num: true,
          value_denom: true,
        },
      },
    },
  });

  const candidates: Array<{ guid: string; valueSum: number }> = [];
  for (const lot of lots) {
    if (lot.splits.length === 0) continue;
    let shares = 0;
    let valueSum = 0;
    let hasGainsSplit = false;
    for (const s of lot.splits) {
      const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
      const val = toDecimalNumber(s.value_num, s.value_denom);
      shares += qty;
      valueSum += val;
      if (Math.abs(qty) < 1e-9 && Math.abs(val) > VAL_EPS) hasGainsSplit = true;
    }
    if (Math.abs(shares) > 1e-6) continue; // not closed (engine re-checks per-commodity)
    if (hasGainsSplit) continue;
    if (Math.abs(valueSum) <= VAL_EPS) continue;
    candidates.push({ guid: lot.guid, valueSum });
  }

  console.log(`candidate lots: ${candidates.length}\n`);

  let booked = 0;
  let bookedTotal = 0;
  const skips = new Map<string, number>();

  for (const cand of candidates) {
    let result: Awaited<ReturnType<typeof generateCapitalGains>> | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        result = await generateCapitalGains(cand.guid, runId, tx);
        if (!APPLY) throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    if (!result) continue;
    const r = result as Awaited<ReturnType<typeof generateCapitalGains>>;
    if (r.gainsTransactionGuid || (!APPLY && !r.skippedReason)) {
      booked++;
      bookedTotal += r.gainLoss;
      console.log(
        `  lot ${cand.guid.slice(0, 8)}: book ${r.gainLoss >= 0 ? 'gain' : 'loss'} ${r.gainLoss.toFixed(2)} (${r.holdingPeriod ?? 'n/a'}, ${r.taxClassification})`,
      );
    } else {
      const reason = r.skippedReason ?? 'unknown';
      skips.set(reason, (skips.get(reason) ?? 0) + 1);
      console.log(`  lot ${cand.guid.slice(0, 8)}: SKIP — ${reason}`);
    }
  }

  console.log(`\n${APPLY ? 'BOOKED' : 'would book'}: ${booked} lots, net gain/loss ${bookedTotal.toFixed(2)}`);
  for (const [reason, n] of skips) console.log(`skipped (${n}): ${reason}`);
  if (!APPLY) console.log('\nDRY-RUN complete — every transaction was rolled back.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
