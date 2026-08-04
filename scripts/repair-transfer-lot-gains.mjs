// Repair phantom realized gains on transfer-closed lots (2026-08-04 audit).
//
// A lot whose shares were consumed entirely by a TRANSFER-OUT to another
// account is not a taxable event, but the old scrub engine booked
// proceeds - basis against the (usually $0) transfer value, creating phantom
// losses equal to the full basis on the source lot and zero-basis destination
// lots. This script:
//
//  (a) finds lots closed purely by transfer that carry gnucash_web_generated
//      gains splits, DELETES those generated gains transactions (the same
//      shape revertScrubRun removes: every split of the transaction tagged
//      gnucash_web_generated), and re-links carried basis onto the
//      destination lots via the carried_basis slot the fixed engine
//      (src/lib/lot-scrub.ts computeCarriedBasis) now consumes:
//        basisPerShare = (buyCost + sourceCarriedBasis) / boughtShares
//        carried       = basisPerShare * destTransferredShares
//      resolved recursively across transfer chains;
//
//  (b) REPORTS (never modifies) closed lots with a nonzero value sum and no
//      gains offset split — likely closed before gains generation existed —
//      so a supervised pass can sweep them separately.
//
// DEFAULT IS DRY-RUN: prints everything it would do. Pass --apply to write.
// Connection comes from the DATABASE_URL environment variable.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/repair-transfer-lot-gains.mjs           # dry-run
//   DATABASE_URL=postgresql://... node scripts/repair-transfer-lot-gains.mjs --apply   # write

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const QTY_EPS = 1e-9;
const VAL_EPS = 0.005;

const dec = (num, denom) => Number(num) / Number(denom);

const c = new pg.Client({ connectionString: cs });
await c.connect();

console.log(`repair-transfer-lot-gains ${APPLY ? '*** APPLY MODE ***' : '(dry-run — pass --apply to write)'}`);

// ── Load the working set ────────────────────────────────────────────────────
const lots = (await c.query(`
  SELECT l.guid, l.account_guid, l.is_closed, a.commodity_guid
  FROM lots l JOIN accounts a ON a.guid = l.account_guid
`)).rows;
const lotByGuid = new Map(lots.map(l => [l.guid, l]));

const lotSplits = (await c.query(`
  SELECT s.guid, s.lot_guid, s.tx_guid, s.account_guid,
         s.quantity_num, s.quantity_denom, s.value_num, s.value_denom
  FROM splits s WHERE s.lot_guid IS NOT NULL
`)).rows;
const splitsByLot = new Map();
for (const s of lotSplits) {
  if (!splitsByLot.has(s.lot_guid)) splitsByLot.set(s.lot_guid, []);
  splitsByLot.get(s.lot_guid).push(s);
}

const slotRows = (await c.query(`
  SELECT obj_guid, name, string_val FROM slots
  WHERE name IN ('gnucash_web_generated', 'source_lot_guid', 'carried_basis')
`)).rows;
const generatedGuids = new Set();
const sourceLotOf = new Map();   // destLotGuid -> sourceLotGuid
const carriedBasisOf = new Map(); // lotGuid -> number (existing slot)
for (const r of slotRows) {
  if (r.name === 'gnucash_web_generated') generatedGuids.add(r.obj_guid);
  if (r.name === 'source_lot_guid' && r.string_val) sourceLotOf.set(r.obj_guid, r.string_val);
  if (r.name === 'carried_basis' && r.string_val) {
    const v = parseFloat(r.string_val);
    if (Number.isFinite(v)) carriedBasisOf.set(r.obj_guid, v);
  }
}

// Sibling splits (with account commodity/type) for every transaction that has
// a negative lot split — needed for the transfer-out predicate.
const negTxGuids = [...new Set(
  lotSplits.filter(s => dec(s.quantity_num, s.quantity_denom) < -QTY_EPS).map(s => s.tx_guid),
)];
const siblingRows = negTxGuids.length > 0
  ? (await c.query(`
      SELECT s.guid, s.tx_guid, s.account_guid, s.quantity_num, s.quantity_denom,
             a.commodity_guid, a.account_type
      FROM splits s JOIN accounts a ON a.guid = s.account_guid
      WHERE s.tx_guid = ANY($1)
    `, [negTxGuids])).rows
  : [];
const siblingsByTx = new Map();
for (const s of siblingRows) {
  if (!siblingsByTx.has(s.tx_guid)) siblingsByTx.set(s.tx_guid, []);
  siblingsByTx.get(s.tx_guid).push(s);
}

// ── Classify lots ───────────────────────────────────────────────────────────
// Same predicate the engine uses: a negative split is a transfer-out when its
// transaction has a positive same-commodity counter-split in another
// non-TRADING account.
function isTransferOut(split, lot) {
  const sibs = siblingsByTx.get(split.tx_guid) ?? [];
  return sibs.some(o =>
    o.account_guid !== lot.account_guid &&
    o.commodity_guid === lot.commodity_guid &&
    o.account_type !== 'TRADING' &&
    dec(o.quantity_num, o.quantity_denom) > QTY_EPS,
  );
}

// A zero-value negative split whose same-commodity positive counter sits in
// the SAME account or a TRADING account is an internal share adjustment (lot
// reshuffle, split-style correction, or trading-account write-off), not a
// sale — no proceeds, no taxable event. The fixed engine refuses to book
// gains from zero-proceeds disposals; the repair mirrors that rule.
// (A different-commodity counter — a crypto-to-crypto trade — is NOT an
// adjustment: that is a real taxable event that the engine now values from
// the price DB, so those lots are left alone here.)
function isAdjustmentPair(split, lot) {
  if (Math.abs(dec(split.value_num, split.value_denom)) > VAL_EPS) return false;
  const sibs = siblingsByTx.get(split.tx_guid) ?? [];
  return sibs.some(o =>
    o.guid !== split.guid &&
    o.commodity_guid === lot.commodity_guid &&
    (o.account_guid === lot.account_guid || o.account_type === 'TRADING') &&
    dec(o.quantity_num, o.quantity_denom) > QTY_EPS,
  );
}

function analyzeLot(lot) {
  const splits = splitsByLot.get(lot.guid) ?? [];
  let shares = 0;
  let boughtShares = 0;
  let buyCost = 0;
  let valueSum = 0;
  const gainsSplits = [];   // zero-qty, nonzero-value
  const negSplits = [];
  for (const s of splits) {
    const qty = dec(s.quantity_num, s.quantity_denom);
    const val = dec(s.value_num, s.value_denom);
    shares += qty;
    valueSum += val;
    if (Math.abs(qty) < QTY_EPS && Math.abs(val) > VAL_EPS) gainsSplits.push(s);
    else if (qty > QTY_EPS) { boughtShares += qty; buyCost += Math.abs(val); }
    else if (qty < -QTY_EPS) negSplits.push(s);
  }
  const transferOuts = negSplits.filter(s => isTransferOut(s, lot));
  const adjustments = negSplits.filter(s => !transferOuts.includes(s) && isAdjustmentPair(s, lot));
  const sales = negSplits.filter(s => !transferOuts.includes(s) && !adjustments.includes(s));
  return { splits, shares, boughtShares, buyCost, valueSum, gainsSplits, negSplits, transferOuts, adjustments, sales };
}

// ── (a) Transfer-closed lots carrying generated gains splits ────────────────
const toRevert = []; // { lot, gainsSplit, gainsTxGuid, gainValue }
const mixedSaleLots = []; // transfer+real-sale lots with generated gains — manual review
for (const lot of lots) {
  const a = analyzeLot(lot);
  if (
    a.sales.length > 0 && a.transferOuts.length > 0 &&
    Math.abs(a.shares) < QTY_EPS &&
    a.gainsSplits.some(gs => generatedGuids.has(gs.guid))
  ) {
    const gain = a.gainsSplits.filter(gs => generatedGuids.has(gs.guid))
      .reduce((sum, gs) => sum + dec(gs.value_num, gs.value_denom), 0);
    mixedSaleLots.push({ lot, gain, sales: a.sales.length, transfers: a.transferOuts.length });
  }
  // Revertable: closed entirely by non-taxable events — at least one
  // transfer-out, remaining negatives (if any) are zero-value adjustment
  // pairs, and NO real sale. A real sale means the generated gain is partly
  // legitimate; those lots are skipped for manual review.
  if (a.negSplits.length === 0 || a.transferOuts.length === 0 || a.sales.length > 0) continue;
  if (Math.abs(a.shares) > QTY_EPS) continue; // not closed
  for (const gs of a.gainsSplits) {
    if (!generatedGuids.has(gs.guid)) continue; // only our generated gains
    toRevert.push({ lot, gainsSplit: gs, gainsTxGuid: gs.tx_guid, gainValue: dec(gs.value_num, gs.value_denom) });
  }
}

console.log(`\n(a) transfer-closed lots with generated gains splits: ${toRevert.length}`);

// Verify each gains transaction is FULLY generated (every split tagged) —
// the same safety check clearLotAssignments applies before deleting.
const revertTxGuids = [...new Set(toRevert.map(r => r.gainsTxGuid))];
const fullyGenerated = new Set();
if (revertTxGuids.length > 0) {
  const txSplitRows = (await c.query(
    `SELECT guid, tx_guid FROM splits WHERE tx_guid = ANY($1)`, [revertTxGuids],
  )).rows;
  const byTx = new Map();
  for (const s of txSplitRows) {
    if (!byTx.has(s.tx_guid)) byTx.set(s.tx_guid, []);
    byTx.get(s.tx_guid).push(s.guid);
  }
  for (const [txGuid, guids] of byTx) {
    if (guids.every(g => generatedGuids.has(g))) fullyGenerated.add(txGuid);
  }
}

const revertable = toRevert.filter(r => fullyGenerated.has(r.gainsTxGuid));
const skipped = toRevert.filter(r => !fullyGenerated.has(r.gainsTxGuid));
let phantomTotal = 0;
for (const r of revertable) {
  // The invest-side offset split is valued +gain; its lot split value IS the booked gain.
  phantomTotal += r.gainValue;
  console.log(`  lot ${r.lot.guid.slice(0, 8)} account ${r.lot.account_guid.slice(0, 8)}: revert gains tx ${r.gainsTxGuid.slice(0, 8)} (booked ${r.gainValue.toFixed(2)})`);
}
for (const r of skipped) {
  console.log(`  SKIP lot ${r.lot.guid.slice(0, 8)}: gains tx ${r.gainsTxGuid.slice(0, 8)} has non-generated splits — manual review`);
}
console.log(`  total phantom gain/loss to revert: ${phantomTotal.toFixed(2)}`);
if (mixedSaleLots.length > 0) {
  console.log(`\n  MIXED sale+transfer lots with generated gains (NOT touched — the gain is partly legitimate; review manually):`);
  for (const m of mixedSaleLots) {
    console.log(`    lot ${m.lot.guid.slice(0, 8)} account ${m.lot.account_guid.slice(0, 8)}: ${m.sales} sale(s) + ${m.transfers} transfer(s), booked ${m.gain.toFixed(2)}`);
  }
}

// ── Carried-basis re-link ───────────────────────────────────────────────────
// Resolve basis recursively along transfer chains. basisPerShare of a lot =
// (buyCost + carriedBasis) / boughtShares, where carriedBasis for a
// destination lot is basisPerShare(source) * destShares. Mirrors
// computeCarriedBasis in src/lib/lot-scrub.ts.
const affectedSources = new Set(revertable.map(r => r.lot.guid));
const resolvedCarried = new Map(); // lotGuid -> carried basis value (final)
const visiting = new Set();

function resolveCarried(lotGuid) {
  if (resolvedCarried.has(lotGuid)) return resolvedCarried.get(lotGuid);
  if (visiting.has(lotGuid)) return 0; // cycle guard
  visiting.add(lotGuid);
  let carried = 0;
  const sourceGuid = sourceLotOf.get(lotGuid);
  const source = sourceGuid ? lotByGuid.get(sourceGuid) : null;
  if (source) {
    const sa = analyzeLot(source);
    if (sa.boughtShares > QTY_EPS) {
      const perShare = (sa.buyCost + resolveCarried(source.guid)) / sa.boughtShares;
      const destLot = lotByGuid.get(lotGuid);
      const da = destLot ? analyzeLot(destLot) : null;
      // Transferred shares = shares that entered the destination lot
      const destShares = da ? da.boughtShares : 0;
      carried = perShare * destShares;
    }
  } else if (carriedBasisOf.has(lotGuid)) {
    carried = carriedBasisOf.get(lotGuid);
  }
  visiting.delete(lotGuid);
  resolvedCarried.set(lotGuid, carried);
  return carried;
}

// Destination lots to re-link: any lot whose source_lot_guid points at an
// affected (reverted) source, plus any transfer-destination lot still missing
// a carried_basis slot entirely (zero-basis lots from the old engine).
const relinks = []; // { destLotGuid, carried, existing }
for (const [destGuid, sourceGuid] of sourceLotOf) {
  const dest = lotByGuid.get(destGuid);
  if (!dest || !lotByGuid.get(sourceGuid)) continue;
  const affected = affectedSources.has(sourceGuid);
  const missing = !carriedBasisOf.has(destGuid);
  if (!affected && !missing) continue;
  const carried = resolveCarried(destGuid);
  if (!(carried > VAL_EPS)) continue;
  const existing = carriedBasisOf.get(destGuid) ?? null;
  if (existing !== null && Math.abs(existing - carried) < VAL_EPS) continue;
  relinks.push({ destLotGuid: destGuid, carried, existing });
}

console.log(`\ncarried_basis slots to write: ${relinks.length}`);
for (const r of relinks) {
  console.log(`  lot ${r.destLotGuid.slice(0, 8)}: carried_basis ${r.existing === null ? '(new)' : `${r.existing} ->`} ${r.carried.toFixed(2)}`);
}

// ── Apply ───────────────────────────────────────────────────────────────────
if (APPLY && (revertable.length > 0 || relinks.length > 0)) {
  await c.query('BEGIN');
  try {
    for (const txGuid of new Set(revertable.map(r => r.gainsTxGuid))) {
      const splitGuids = (await c.query(
        `SELECT guid FROM splits WHERE tx_guid = $1`, [txGuid],
      )).rows.map(r => r.guid);
      if (splitGuids.length > 0) {
        await c.query(`DELETE FROM slots WHERE obj_guid = ANY($1)`, [splitGuids]);
        await c.query(`DELETE FROM splits WHERE tx_guid = $1`, [txGuid]);
      }
      await c.query(`DELETE FROM slots WHERE obj_guid = $1`, [txGuid]);
      await c.query(`DELETE FROM transactions WHERE guid = $1`, [txGuid]);
    }
    for (const r of relinks) {
      const val = String(Math.round(r.carried * 1e6) / 1e6);
      const updated = await c.query(
        `UPDATE slots SET string_val = $1 WHERE obj_guid = $2 AND name = 'carried_basis'`,
        [val, r.destLotGuid],
      );
      if (updated.rowCount === 0) {
        await c.query(
          `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, 'carried_basis', 4, $2)`,
          [r.destLotGuid, val],
        );
      }
    }
    await c.query('COMMIT');
    console.log(`\nAPPLIED: reverted ${new Set(revertable.map(r => r.gainsTxGuid)).size} gains transactions, wrote ${relinks.length} carried_basis slots`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLED BACK:', e);
    process.exitCode = 1;
  }
} else if (!APPLY) {
  console.log('\nDRY-RUN complete — nothing was modified. Re-run with --apply to write.');
}

// ── (b) Report-only: closed lots with nonzero value sum and no gains offset ─
console.log('\n(b) closed lots with nonzero value sum and NO gains offset split (report only):');
let reportCount = 0;
let reportTotal = 0;
for (const lot of lots) {
  const a = analyzeLot(lot);
  if (a.splits.length === 0) continue;
  const closed = lot.is_closed === 1 || Math.abs(a.shares) < QTY_EPS;
  if (!closed) continue;
  if (a.gainsSplits.length > 0) continue;
  if (Math.abs(a.valueSum) <= VAL_EPS) continue;
  // Lots closed purely by transfers/adjustments are EXPECTED to have a
  // nonzero value sum now (basis stays in the lot, gain travels via
  // carried_basis) — skip them.
  if (a.negSplits.length > 0 && a.sales.length === 0 && a.transferOuts.length > 0) continue;
  reportCount++;
  reportTotal += -a.valueSum; // gain = -(sum) per GnuCash sign convention
  console.log(`  lot ${lot.guid.slice(0, 8)} account ${lot.account_guid.slice(0, 8)}: value sum ${a.valueSum.toFixed(2)} (implied unbooked gain ${(-a.valueSum).toFixed(2)})`);
}
console.log(`  ${reportCount} lots, implied unbooked gain total ${reportTotal.toFixed(2)}`);

await c.end();
