/**
 * Default Book Creation
 *
 * Creates a default book with a standard GnuCash account hierarchy.
 */

import prisma from './prisma';
import { generateGuid } from './gnucash';

interface DefaultAccountDef {
  name: string;
  type: string;
  children?: DefaultAccountDef[];
}

const DEFAULT_HIERARCHY: DefaultAccountDef[] = [
  {
    name: 'Assets',
    type: 'ASSET',
    children: [
      {
        name: 'Current Assets',
        type: 'ASSET',
        children: [
          { name: 'Checking Account', type: 'BANK' },
          { name: 'Savings Account', type: 'BANK' },
          { name: 'Cash in Wallet', type: 'CASH' },
        ],
      },
      {
        name: 'Investments',
        type: 'ASSET',
        children: [
          { name: 'Brokerage Account', type: 'ASSET' },
        ],
      },
    ],
  },
  {
    name: 'Liabilities',
    type: 'LIABILITY',
    children: [
      { name: 'Credit Card', type: 'CREDIT' },
      { name: 'Mortgage', type: 'LIABILITY' },
    ],
  },
  {
    name: 'Income',
    type: 'INCOME',
    children: [
      { name: 'Salary', type: 'INCOME' },
      { name: 'Interest Income', type: 'INCOME' },
      { name: 'Other Income', type: 'INCOME' },
    ],
  },
  {
    name: 'Expenses',
    type: 'EXPENSE',
    children: [
      { name: 'Groceries', type: 'EXPENSE' },
      { name: 'Utilities', type: 'EXPENSE' },
      { name: 'Rent/Mortgage', type: 'EXPENSE' },
      { name: 'Transportation', type: 'EXPENSE' },
      { name: 'Entertainment', type: 'EXPENSE' },
      { name: 'Healthcare', type: 'EXPENSE' },
      { name: 'Insurance', type: 'EXPENSE' },
      { name: 'Dining Out', type: 'EXPENSE' },
      { name: 'Clothing', type: 'EXPENSE' },
      { name: 'Taxes', type: 'EXPENSE', children: [
        { name: 'Federal Tax', type: 'EXPENSE' },
        { name: 'State Tax', type: 'EXPENSE' },
        { name: 'Social Security', type: 'EXPENSE' },
        { name: 'Medicare', type: 'EXPENSE' },
      ]},
      { name: 'Miscellaneous', type: 'EXPENSE' },
    ],
  },
  {
    name: 'Equity',
    type: 'EQUITY',
    children: [
      { name: 'Opening Balances', type: 'EQUITY' },
    ],
  },
];

export async function createDefaultBook(bookName: string = 'My Finances'): Promise<string> {
  // Ensure USD commodity exists
  let usdCommodity = await prisma.commodities.findFirst({
    where: { namespace: 'CURRENCY', mnemonic: 'USD' },
  });

  if (!usdCommodity) {
    usdCommodity = await prisma.commodities.create({
      data: {
        guid: generateGuid(),
        namespace: 'CURRENCY',
        mnemonic: 'USD',
        fullname: 'US Dollar',
        cusip: '',
        fraction: 100,
        quote_flag: 1,
        quote_source: 'currency',
        quote_tz: '',
      },
    });
  }

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
        commodity_guid: usdCommodity!.guid,
        commodity_scu: 100,
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
        commodity_guid: usdCommodity!.guid,
        commodity_scu: 100,
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
      },
    });

    // Recursively create accounts
    async function createAccounts(
      defs: DefaultAccountDef[],
      parentGuid: string
    ) {
      for (const def of defs) {
        const accountGuid = generateGuid();
        await tx.accounts.create({
          data: {
            guid: accountGuid,
            name: def.name,
            account_type: def.type,
            commodity_guid: usdCommodity!.guid,
            commodity_scu: 100,
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

    await createAccounts(DEFAULT_HIERARCHY, rootGuid);
  });

  return bookGuid;
}
