/**
 * Cleanup: orphaned app-written slots.
 *
 * The slots table has no FK on obj_guid, so any path that deleted a split,
 * transaction, or lot without also deleting its slots leaves orphans behind
 * (897 orphaned gnucash_web_generated rows were found in prod on 2026-08-04,
 * left by older scrub-revert / delete paths that have since been fixed).
 *
 * This script removes ONLY slots the app itself writes — the allowlist below
 * is the complete inventory of names created by gnucash-web code, each with
 * the object type(s) its obj_guid attaches to. A row is an orphan only when
 * NONE of its possible referents still exists. GnuCash desktop's own slot
 * names (date-posted, notes, title, trans-*, counters, ...) are NEVER
 * touched, even when orphaned.
 *
 * Name inventory (writer → attach type):
 *   gnucash_web_generated      lot-scrub/lot-assignment  → split, transaction, lot
 *   original_quantity_num      lot-scrub (sell split)    → split
 *   original_quantity_denom    lot-scrub (sell split)    → split
 *   original_value_num         lot-scrub (sell split)    → split
 *   original_value_denom       lot-scrub (sell split)    → split
 *   source_lot_guid            lot-scrub (transfer link) → lot
 *   carried_basis              lot-scrub (transfer close)→ lot
 *   acquisition_date           lot-scrub (carried date)  → lot
 *   gnucash_web_equity_comp    equity-comp               → transaction
 *   gnucash-web/payment-event  stripe-webhook            → transaction
 *   gnucash-web/invoice-guid   stripe-webhook            → transaction
 *   gnucash-web/closed-through close-book                → book
 *
 * DEFAULT IS DRY-RUN: prints per-name orphan counts and a sample, deletes
 * nothing. Pass --apply to delete all orphans in ONE transaction.
 * Connection from DATABASE_URL.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/cleanup-orphaned-slots.ts           # dry-run
 *   DATABASE_URL=postgresql://... npx tsx scripts/cleanup-orphaned-slots.ts --apply   # delete
 */

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

type AttachType = 'split' | 'transaction' | 'lot' | 'book';

interface AppSlotName {
  name: string;
  /** Object type(s) this slot name attaches to — the orphan check must match. */
  attachesTo: AttachType[];
}

/**
 * Complete allowlist of slot names written by gnucash-web. Anything not in
 * this list (GnuCash desktop's own slots included) is never examined.
 */
const APP_SLOT_NAMES: AppSlotName[] = [
  // Lot scrub engine markers — runId tag on generated splits/transactions and
  // on lots created by auto-assignment.
  { name: 'gnucash_web_generated', attachesTo: ['split', 'transaction', 'lot'] },
  // Pre-scrub sell-split originals (restored on revert) — attach to splits.
  { name: 'original_quantity_num', attachesTo: ['split'] },
  { name: 'original_quantity_denom', attachesTo: ['split'] },
  { name: 'original_value_num', attachesTo: ['split'] },
  { name: 'original_value_denom', attachesTo: ['split'] },
  // Transfer-lot linkage and carried basis/date — attach to LOT guids.
  { name: 'source_lot_guid', attachesTo: ['lot'] },
  { name: 'carried_basis', attachesTo: ['lot'] },
  { name: 'acquisition_date', attachesTo: ['lot'] },
  // Equity-comp history tag — attaches to the vest/exercise transaction.
  { name: 'gnucash_web_equity_comp', attachesTo: ['transaction'] },
  // Stripe payment idempotency/link tags — attach to the payment transaction.
  { name: 'gnucash-web/payment-event', attachesTo: ['transaction'] },
  { name: 'gnucash-web/invoice-guid', attachesTo: ['transaction'] },
  // Close-book high-water mark — attaches to the book row itself.
  { name: 'gnucash-web/closed-through', attachesTo: ['book'] },
];

const REFERENT_TABLE: Record<AttachType, string> = {
  split: 'splits',
  transaction: 'transactions',
  lot: 'lots',
  book: 'books',
};

/**
 * WHERE fragment matching orphans of one slot name: the name matches ($1)
 * and NONE of the object types this name can attach to still contains
 * obj_guid. A slot whose referent exists under ANY allowed type is kept.
 */
function orphanCondition(entry: AppSlotName): string {
  const notExists = entry.attachesTo
    .map((t) => `NOT EXISTS (SELECT 1 FROM ${REFERENT_TABLE[t]} r WHERE r.guid = s.obj_guid)`)
    .join('\n      AND ');
  return `s.name = $1\n      AND ${notExists}`;
}

interface SampleRow {
  id: number;
  obj_guid: string;
  string_val: string | null;
}

async function main() {
  console.log(
    `cleanup-orphaned-slots ${APPLY ? '*** APPLY MODE ***' : '(dry-run — pass --apply to delete)'}\n`,
  );

  // ── Survey: per-name orphan counts + samples (read-only) ──
  const orphanCounts = new Map<string, number>();
  let total = 0;

  for (const entry of APP_SLOT_NAMES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM slots s WHERE ${orphanCondition(entry)}`,
      entry.name,
    );
    const count = Number(rows[0]?.n ?? 0n);
    orphanCounts.set(entry.name, count);
    total += count;

    const attach = entry.attachesTo.join('|');
    console.log(`${entry.name.padEnd(28)} [${attach.padEnd(21)}] orphans: ${count}`);
    if (count > 0) {
      const sample = await prisma.$queryRawUnsafe<SampleRow[]>(
        `SELECT s.id, s.obj_guid, s.string_val FROM slots s WHERE ${orphanCondition(entry)} ORDER BY s.id LIMIT 5`,
        entry.name,
      );
      for (const row of sample) {
        console.log(
          `    id=${row.id} obj_guid=${row.obj_guid} string_val=${row.string_val ?? '<null>'}`,
        );
      }
      if (count > sample.length) console.log(`    ... and ${count - sample.length} more`);
    }
  }

  console.log(`\ntotal orphaned app slots: ${total}`);

  if (!APPLY) {
    console.log('\nDRY-RUN complete — nothing was deleted. Pass --apply to delete.');
    return;
  }

  if (total === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  // ── Apply: delete everything in ONE transaction. The DELETE re-evaluates
  // the same orphan condition, so rows whose referent appeared between the
  // survey and the delete are left alone. ──
  const deletedByName = await prisma.$transaction(
    async (tx) => {
      const results: Array<{ name: string; deleted: number }> = [];
      for (const entry of APP_SLOT_NAMES) {
        if ((orphanCounts.get(entry.name) ?? 0) === 0) continue;
        const deleted = await tx.$executeRawUnsafe(
          `DELETE FROM slots s WHERE ${orphanCondition(entry)}`,
          entry.name,
        );
        results.push({ name: entry.name, deleted });
      }
      return results;
    },
    { timeout: 300_000, maxWait: 15_000 },
  );

  let deletedTotal = 0;
  console.log('');
  for (const { name, deleted } of deletedByName) {
    deletedTotal += deleted;
    console.log(`DELETED ${deleted} × ${name}`);
  }
  console.log(`\nDELETED total: ${deletedTotal} orphaned app slots.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
