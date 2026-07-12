/**
 * Repair legacy lot-scrub sign corruption (2026-07-12).
 *
 * An earlier version of splitSellAcrossLots created sell sub-splits with
 * POSITIVE values (sign dropped), letting the remainder sub-split absorb a
 * wildly wrong negative value to keep the transaction balanced. Capital-gains
 * transactions generated from those corrupted lots are wrong too (e.g. a
 * +$139.49 gain recorded as a -$1,639.49 income debit labeled "Gain").
 *
 * The engine has since been fixed (valueSign in splitSellAcrossLots), and the
 * scrub run saved every original split's quantity/value in slots — so the fix
 * is: revert all lot assignments (restores original splits, deletes generated
 * sub-splits and gains transactions) and re-scrub with the fixed engine.
 *
 * Usage:
 *   npx tsx scripts/fix-lot-scrub-sign-corruption.ts            # dry-run report
 *   npx tsx scripts/fix-lot-scrub-sign-corruption.ts --execute  # revert + re-scrub
 *   npx tsx scripts/fix-lot-scrub-sign-corruption.ts --execute --method=average
 *
 * A table-level backup should exist before running with --execute
 * (schema backup_20260712 was created for the first run).
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as { loadEnvConfig: (dir: string) => void };
loadEnvConfig(process.cwd());

const EXECUTE = process.argv.includes('--execute');
const methodArg = process.argv.find(a => a.startsWith('--method='))?.split('=')[1] ?? 'fifo';

async function main() {
  const { default: prisma } = await import('@/lib/prisma');
  const { scrubAllAccounts } = await import('@/lib/lot-assignment');

  if (!['fifo', 'lifo', 'average'].includes(methodArg)) {
    throw new Error(`Invalid --method=${methodArg}; must be fifo|lifo|average`);
  }
  const method = methodArg as 'fifo' | 'lifo' | 'average';

  // --- 1. Find corrupted sell sub-splits: lot-linked stock/mutual splits
  //        whose value sign contradicts their quantity sign. -----------------
  const badSplits: Array<{
    account_guid: string;
    account: string;
    tx_guid: string;
  }> = await prisma.$queryRaw`
    SELECT s.account_guid, a.name AS account, s.tx_guid
    FROM splits s
    JOIN accounts a ON a.guid = s.account_guid
    WHERE s.lot_guid IS NOT NULL
      AND a.account_type IN ('STOCK','MUTUAL')
      AND ((s.quantity_num < 0 AND s.value_num > 0) OR (s.quantity_num > 0 AND s.value_num < 0))
  `;

  if (badSplits.length === 0) {
    console.log('No sign-corrupted lot splits found. Nothing to do.');
    return;
  }

  const affectedAccounts = new Set(badSplits.map(s => s.account_guid));
  const affectedTxns = new Set(badSplits.map(s => s.tx_guid));
  console.log(`Corrupted sub-splits: ${badSplits.length}`);
  console.log(`Affected sell transactions: ${affectedTxns.size}`);
  console.log(`Affected accounts: ${affectedAccounts.size}`);

  // --- 2. Resolve which books contain affected accounts. -------------------
  const books: Array<{ guid: string; root_account_guid: string }> =
    await prisma.$queryRaw`SELECT guid, root_account_guid FROM books`;

  const bookPlans: Array<{ bookGuid: string; accountGuids: string[]; affected: number }> = [];
  for (const book of books) {
    const rows: Array<{ guid: string }> = await prisma.$queryRaw`
      WITH RECURSIVE tree AS (
        SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
        UNION ALL
        SELECT a.guid FROM accounts a JOIN tree t ON a.parent_guid = t.guid
      )
      SELECT guid FROM tree
    `;
    const guids = rows.map(r => r.guid);
    const affected = guids.filter(g => affectedAccounts.has(g)).length;
    if (affected > 0) bookPlans.push({ bookGuid: book.guid, accountGuids: guids, affected });
  }

  for (const plan of bookPlans) {
    console.log(`Book ${plan.bookGuid}: ${plan.affected} affected accounts (of ${plan.accountGuids.length} total)`);
  }

  // --- 3. Pre-repair metric: realized gain totals per gains income account. -
  const gainsBefore: Array<{ account: string; total: number }> = await prisma.$queryRaw`
    SELECT a.name AS account, ROUND(SUM(-s.value_num::numeric / s.value_denom), 2)::float AS total
    FROM splits s
    JOIN accounts a ON a.guid = s.account_guid
    WHERE a.account_type = 'INCOME' AND lower(
      (SELECT string_agg(p.name, ':') FROM accounts p WHERE p.guid = a.parent_guid)
    ) LIKE '%capital gain%' OR (a.account_type = 'INCOME' AND lower(a.name) IN ('short term','long term'))
    GROUP BY a.name
  `;
  console.log('Capital-gains income totals BEFORE:', JSON.stringify(gainsBefore));

  if (!EXECUTE) {
    console.log('\nDRY RUN — pass --execute to revert and re-scrub the affected books.');
    return;
  }

  // --- 4. Revert + re-scrub each affected book with the fixed engine. ------
  for (const plan of bookPlans) {
    console.log(`\nScrubbing book ${plan.bookGuid} (clearFirst=true, method=${method})...`);
    const result = await scrubAllAccounts(method, plan.accountGuids, true);
    const totals = result.results.reduce(
      (acc, r) => ({
        lots: acc.lots + r.lotsCreated,
        assigned: acc.assigned + r.splitsAssigned,
        created: acc.created + r.splitsCreated,
        gains: acc.gains + r.gainsTransactions,
        realized: acc.realized + r.totalRealizedGain,
      }),
      { lots: 0, assigned: 0, created: 0, gains: 0, realized: 0 },
    );
    console.log(`  cleared lots: ${result.cleared}`);
    console.log(`  lots created: ${totals.lots}, splits assigned: ${totals.assigned}, sub-splits created: ${totals.created}`);
    console.log(`  gains transactions: ${totals.gains}, total realized gain: ${totals.realized.toFixed(2)}`);
    const warnings = result.results.flatMap(r => r.warnings);
    if (warnings.length > 0) {
      console.log(`  warnings (${warnings.length}):`);
      for (const w of warnings.slice(0, 20)) console.log(`   - ${w}`);
      if (warnings.length > 20) console.log(`   ... and ${warnings.length - 20} more`);
    }
  }

  // --- 5. Verify: no sign-mismatched lot splits remain. ---------------------
  const remaining: Array<{ n: bigint }> = await prisma.$queryRaw`
    SELECT count(*) AS n
    FROM splits s
    JOIN accounts a ON a.guid = s.account_guid
    WHERE s.lot_guid IS NOT NULL
      AND a.account_type IN ('STOCK','MUTUAL')
      AND ((s.quantity_num < 0 AND s.value_num > 0) OR (s.quantity_num > 0 AND s.value_num < 0))
  `;
  console.log(`\nRemaining sign-mismatched lot splits: ${remaining[0].n}`);

  // Verify all transactions still balance.
  const unbalanced: Array<{ tx_guid: string; imbalance: number }> = await prisma.$queryRaw`
    SELECT s.tx_guid, ROUND(SUM(s.value_num::numeric / s.value_denom), 4)::float AS imbalance
    FROM splits s
    GROUP BY s.tx_guid
    HAVING ABS(SUM(s.value_num::numeric / s.value_denom)) > 0.01
  `;
  console.log(`Unbalanced transactions after repair: ${unbalanced.length}`);
  for (const u of unbalanced.slice(0, 10)) console.log(`  ${u.tx_guid}: ${u.imbalance}`);

  console.log('\nDone.');
}

main()
  .catch((error) => {
    console.error('Repair failed:', error);
    process.exit(1);
  })
  .then(() => process.exit(0));
