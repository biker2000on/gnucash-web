/**
 * One-time setup: create the "Lotus Bud Acupuncture" LLC book and wire it to
 * the Crawford household book.
 *
 * - Creates the book from the single-member-LLC account template
 * - Entity profile: llc_single, owner Cara Crawford (100%), NC
 * - Grants admin on the new book to every existing user
 * - Links it to the household book at 100% ownership (cross-book 1040)
 * - Creates Income:Business Draws:Lotus Bud Acupuncture in the household
 *   book and maps it 'exclude' (draws aren't taxable — the profit is)
 *
 * Run: npx tsx scripts/create-lotus-bud-book.ts <household_book_guid>
 * DATABASE_URL selects the target database. Idempotent-ish: aborts if a
 * book with this name already exists.
 */

import prisma from '../src/lib/prisma';
import { createDefaultBook } from '../src/lib/default-book';
import { saveEntityProfile } from '../src/lib/services/entity.service';
import { grantRole } from '../src/lib/services/permission.service';
import { findOrCreateAccount } from '../src/lib/gnucash';

const BOOK_NAME = 'Lotus Bud Acupuncture';
const DRAW_ACCOUNT_PATH = 'Income:Business Draws:Lotus Bud Acupuncture';

async function main() {
  const householdGuid = process.argv[2];
  if (!householdGuid || householdGuid.length !== 32) {
    throw new Error('Usage: npx tsx scripts/create-lotus-bud-book.ts <household_book_guid>');
  }

  const household = await prisma.books.findUnique({
    where: { guid: householdGuid },
    select: { guid: true, name: true, root_account_guid: true },
  });
  if (!household) throw new Error(`Household book not found: ${householdGuid}`);

  const existing = await prisma.books.findFirst({ where: { name: BOOK_NAME } });
  if (existing) throw new Error(`Book "${BOOK_NAME}" already exists (${existing.guid}) — aborting.`);

  console.log(`Creating "${BOOK_NAME}" (llc_single) ...`);
  const bookGuid = await createDefaultBook(
    BOOK_NAME,
    "Cara's acupuncture practice (single-member LLC)",
    'llc_single',
    'USD'
  );
  console.log(`  book guid: ${bookGuid}`);

  await saveEntityProfile(bookGuid, {
    entityType: 'llc_single',
    entityName: BOOK_NAME,
    taxState: 'NC',
    members: [
      { role: 'owner', name: 'Cara Crawford', ownershipPercent: 100, sortOrder: 0 },
    ],
  });
  console.log('  entity profile saved (llc_single, owner Cara Crawford 100%, NC)');

  const users = await prisma.gnucash_web_users.findMany({ select: { id: true, username: true } });
  for (const user of users) {
    await grantRole(user.id, bookGuid, 'admin', user.id);
    console.log(`  granted admin to ${user.username}`);
  }

  await prisma.gnucash_web_book_links.upsert({
    where: {
      business_book_guid_household_book_guid: {
        business_book_guid: bookGuid,
        household_book_guid: householdGuid,
      },
    },
    create: {
      business_book_guid: bookGuid,
      household_book_guid: householdGuid,
      ownership_percent: 100,
    },
    update: { ownership_percent: 100, updated_at: new Date() },
  });
  console.log(`  linked to household book "${household.name}" at 100%`);

  const usd = await prisma.commodities.findFirst({
    where: { namespace: 'CURRENCY', mnemonic: 'USD' },
    select: { guid: true },
  });
  if (!usd) throw new Error('USD commodity not found in target database');

  const drawAccountGuid = await findOrCreateAccount(
    DRAW_ACCOUNT_PATH,
    household.root_account_guid,
    usd.guid
  );
  await prisma.gnucash_web_tax_mappings.upsert({
    where: { account_guid: drawAccountGuid },
    create: { account_guid: drawAccountGuid, tax_category: 'exclude' },
    update: { tax_category: 'exclude', updated_at: new Date() },
  });
  console.log(`  created ${DRAW_ACCOUNT_PATH} (${drawAccountGuid}) in "${household.name}", mapped 'exclude'`);

  console.log('Done.');
}

main()
  .catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
