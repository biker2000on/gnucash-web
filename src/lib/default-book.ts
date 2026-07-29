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
import type { BusinessActivity, EntityType } from '@/lib/services/entity.service';

export async function createDefaultBook(
  bookName: string = 'My Finances',
  bookDescription?: string,
  entityType: EntityType = 'household',
  currency: string = 'USD',
  businessActivity: BusinessActivity = 'general'
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
  const hierarchy = getEntityAccountTemplate(entityType, businessActivity);

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

export interface AddTemplateAccountsResult {
  created: number;
  existing: number;
}

/**
 * Idempotently graft a typed template beneath an existing book account.
 * Existing siblings are matched by exact name and must have the requested
 * account type; newly created descendants inherit the book currency.
 */
export async function addTemplateAccounts(
  bookGuid: string,
  defs: TemplateAccountDef[],
  parentName?: string,
): Promise<AddTemplateAccountsResult> {
  const book = await prisma.books.findUnique({
    where: { guid: bookGuid },
    select: { root_account_guid: true },
  });
  if (!book) throw new Error('Book not found');

  const root = await prisma.accounts.findUnique({
    where: { guid: book.root_account_guid },
    select: { guid: true, commodity_guid: true, commodity_scu: true },
  });
  if (!root?.commodity_guid) throw new Error('Book root has no commodity');

  let parentGuid = root.guid;
  if (parentName) {
    const parent = await prisma.accounts.findFirst({
      where: { parent_guid: root.guid, name: parentName },
      select: { guid: true },
    });
    if (!parent) throw new Error(`Parent account not found: ${parentName}`);
    parentGuid = parent.guid;
  }

  return prisma.$transaction(async (tx) => {
    let created = 0;
    let existing = 0;

    const add = async (accounts: TemplateAccountDef[], parent: string) => {
      for (const def of accounts) {
        const current = await tx.accounts.findFirst({
          where: { parent_guid: parent, name: def.name },
          select: { guid: true, account_type: true, placeholder: true },
        });
        let guid: string;
        if (current) {
          if (current.account_type !== def.type) {
            throw new Error(
              `Cannot add ${def.name}: existing account is ${current.account_type}, template requires ${def.type}.`,
            );
          }
          guid = current.guid;
          existing++;
          if (def.children?.length && current.placeholder === 0) {
            await tx.accounts.update({
              where: { guid },
              data: { placeholder: 1 },
            });
          }
        } else {
          guid = generateGuid();
          await tx.accounts.create({
            data: {
              guid,
              name: def.name,
              account_type: def.type,
              commodity_guid: root.commodity_guid,
              commodity_scu: root.commodity_scu,
              non_std_scu: 0,
              parent_guid: parent,
              code: '',
              description: '',
              hidden: 0,
              placeholder: def.children?.length ? 1 : 0,
            },
          });
          created++;
        }
        if (def.children?.length) await add(def.children, guid);
      }
    };

    await add(defs, parentGuid);
    return { created, existing };
  });
}
