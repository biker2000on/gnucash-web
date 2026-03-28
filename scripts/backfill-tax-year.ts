/**
 * Backfill tax-year overrides for historical contribution transactions.
 *
 * Scans transaction descriptions for year indicators and sets tax_year
 * overrides in gnucash_web_contribution_tax_year for matches.
 *
 * Usage:
 *   npx tsx scripts/backfill-tax-year.ts --dry-run    # Preview changes
 *   npx tsx scripts/backfill-tax-year.ts              # Apply changes
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Patterns that indicate a tax year in description
const TAX_YEAR_PATTERNS = [
  /\b(20\d{2})\s+(?:Roth|Traditional|IRA|HSA|HRA|FSA|401k|403b|457)/i,
  /(?:Contribution|Deposit|Payment)\s+(?:for|to)\s+(20\d{2})/i,
  /\bTY\s*(20\d{2})\b/i,
  /\bTax\s+Year\s+(20\d{2})\b/i,
  /\b(20\d{2})\s+(?:Contribution|Deposit)\b/i,
];

// False positive patterns (dates, reference numbers)
const FALSE_POSITIVE_PATTERNS = [
  /\b20\d{2}-\d{2}-\d{2}\b/g,
  /\b20\d{2}\/\d{2}\/\d{2}\b/g,
  /\b#\d+\b/g,
];

function extractTaxYear(description: string, postDate: Date): number | null {
  // Remove false positives first
  let cleaned = description;
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    cleaned = cleaned.replace(fp, '');
  }

  for (const pattern of TAX_YEAR_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      const year = parseInt(match[1]);
      const postYear = postDate.getFullYear();
      // Sanity: tax year should be postYear or postYear-1
      if (year === postYear || year === postYear - 1) {
        return year;
      }
    }
  }

  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Backfill tax-year overrides ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('---');

  // Get all retirement account GUIDs
  const retirementPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: { is_retirement: true },
    select: { account_guid: true },
  });

  if (retirementPrefs.length === 0) {
    console.log('No retirement accounts flagged. Flag accounts first, then re-run.');
    return;
  }

  const retirementGuids = retirementPrefs.map(p => p.account_guid);
  console.log(`Found ${retirementGuids.length} retirement accounts`);

  // Get all child accounts too (BFS hierarchy walk)
  const allAccounts = await prisma.accounts.findMany({
    select: { guid: true, parent_guid: true },
  });
  const childrenOf = new Map<string, string[]>();
  for (const acct of allAccounts) {
    if (acct.parent_guid) {
      const children = childrenOf.get(acct.parent_guid) ?? [];
      children.push(acct.guid);
      childrenOf.set(acct.parent_guid, children);
    }
  }

  const allRetirementGuids = new Set(retirementGuids);
  const queue = [...retirementGuids];
  while (queue.length > 0) {
    const guid = queue.pop()!;
    for (const child of childrenOf.get(guid) ?? []) {
      if (!allRetirementGuids.has(child)) {
        allRetirementGuids.add(child);
        queue.push(child);
      }
    }
  }

  console.log(`Including children: ${allRetirementGuids.size} total accounts`);

  // Get all splits with transaction descriptions
  const splits = await prisma.splits.findMany({
    where: {
      account_guid: { in: [...allRetirementGuids] },
    },
    select: {
      guid: true,
      account_guid: true,
      transaction: {
        select: {
          description: true,
          post_date: true,
        },
      },
    },
  });

  console.log(`Scanning ${splits.length} splits...`);

  // Check existing overrides
  const existingOverrides = await prisma.gnucash_web_contribution_tax_year.findMany({
    select: { split_guid: true },
  });
  const existingSet = new Set(existingOverrides.map(o => o.split_guid));

  let found = 0;
  let skipped = 0;

  for (const split of splits) {
    if (!split.transaction || !split.transaction.description || !split.transaction.post_date) continue;

    const taxYear = extractTaxYear(
      split.transaction.description,
      split.transaction.post_date,
    );

    if (taxYear === null) continue;

    const postYear = split.transaction.post_date.getFullYear();
    if (taxYear === postYear) continue; // No override needed

    found++;

    if (existingSet.has(split.guid)) {
      skipped++;
      continue;
    }

    console.log(`  ${split.transaction.post_date.toISOString().split('T')[0]} | "${split.transaction.description}" → tax year ${taxYear} (post year ${postYear})`);

    if (!dryRun) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_contribution_tax_year (split_guid, tax_year)
        VALUES (${split.guid}, ${taxYear})
        ON CONFLICT (split_guid) DO NOTHING
      `;
    }
  }

  console.log('---');
  console.log(`Found: ${found} splits with tax year != calendar year`);
  console.log(`Skipped: ${skipped} (already have overrides)`);
  console.log(`${dryRun ? 'Would create' : 'Created'}: ${found - skipped} overrides`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
