/**
 * Default Book Creation
 *
 * Creates a new book seeded with the account hierarchy recommended for the
 * chosen entity type (household, sole proprietorship, LLC, corporation, or
 * nonprofit). Templates live in src/lib/book-templates.ts.
 */

import prisma from './prisma';
import { generateGuid } from './gnucash';
import { getCurrencyName } from './currencies';
import { getEntityAccountTemplate, type TemplateAccountDef } from './book-templates';
import type { EntityType } from '@/lib/services/entity.service';

export async function createDefaultBook(
  bookName: string = 'My Finances',
  bookDescription?: string,
  entityType: EntityType = 'household',
  currency: string = 'USD'
): Promise<string> {
  const mnemonic = currency.toUpperCase();

  // Ensure the currency commodity exists
  let currencyCommodity = await prisma.commodities.findFirst({
    where: { namespace: 'CURRENCY', mnemonic },
  });

  if (!currencyCommodity) {
    currencyCommodity = await prisma.commodities.create({
      data: {
        guid: generateGuid(),
        namespace: 'CURRENCY',
        mnemonic,
        fullname: getCurrencyName(mnemonic),
        cusip: '',
        fraction: 100,
        quote_flag: 1,
        quote_source: 'currency',
        quote_tz: '',
      },
    });
  }

  const commodityScu = Number(currencyCommodity.fraction) || 100;
  const hierarchy = getEntityAccountTemplate(entityType);

  const bookGuid = generateGuid();
  const rootGuid = generateGuid();
  const templateRootGuid = generateGuid();

  await prisma.$transaction(async (tx) => {
    // Create root account
    await tx.accounts.create({
      data: {
        guid: rootGuid,
        name: bookName,
        account_type: 'ROOT',
        commodity_guid: currencyCommodity!.guid,
        commodity_scu: commodityScu,
        non_std_scu: 0,
        parent_guid: null,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
      },
    });

    // Create template root
    await tx.accounts.create({
      data: {
        guid: templateRootGuid,
        name: 'Template Root',
        account_type: 'ROOT',
        commodity_guid: currencyCommodity!.guid,
        commodity_scu: commodityScu,
        non_std_scu: 0,
        parent_guid: null,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
      },
    });

    // Create book
    await tx.books.create({
      data: {
        guid: bookGuid,
        root_account_guid: rootGuid,
        root_template_guid: templateRootGuid,
        name: bookName,
        description: bookDescription || null,
      },
    });

    // Recursively create accounts
    async function createAccounts(
      defs: TemplateAccountDef[],
      parentGuid: string
    ) {
      for (const def of defs) {
        const accountGuid = generateGuid();
        await tx.accounts.create({
          data: {
            guid: accountGuid,
            name: def.name,
            account_type: def.type,
            commodity_guid: currencyCommodity!.guid,
            commodity_scu: commodityScu,
            non_std_scu: 0,
            parent_guid: parentGuid,
            code: '',
            description: '',
            hidden: 0,
            placeholder: def.children && def.children.length > 0 ? 1 : 0,
          },
        });

        if (def.children) {
          await createAccounts(def.children, accountGuid);
        }
      }
    }

    await createAccounts(hierarchy, rootGuid);
  });

  return bookGuid;
}
