import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { getTemplate, flattenTemplate } from '@/lib/account-templates';

/**
 * POST /api/books/from-template
 * Create a new book, optionally populated with accounts from a template.
 *
 * Body: { name: string, description?: string, currency: string, locale?: string, templateId?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, currency, locale, templateId } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'Book name is required' },
        { status: 400 }
      );
    }

    if (!currency || typeof currency !== 'string') {
      return NextResponse.json(
        { error: 'Currency is required' },
        { status: 400 }
      );
    }

    // Find the currency commodity
    const currencyCommodity = await prisma.commodities.findFirst({
      where: { namespace: 'CURRENCY', mnemonic: currency.toUpperCase() },
      select: { guid: true, fraction: true },
    });

    if (!currencyCommodity) {
      return NextResponse.json(
        { error: `Currency "${currency}" not found. Please ensure it exists in your commodities.` },
        { status: 400 }
      );
    }

    const currencyGuid = currencyCommodity.guid;
    const commodityScu = Number(currencyCommodity.fraction) || 100;

    // Load template if specified
    let templateAccounts: ReturnType<typeof flattenTemplate> = [];
    if (locale && templateId) {
      const template = getTemplate(locale, templateId);
      if (!template) {
        return NextResponse.json(
          { error: `Template "${templateId}" not found for locale "${locale}"` },
          { status: 400 }
        );
      }
      templateAccounts = flattenTemplate(template.accounts);
    }

    const bookGuid = generateGuid();
    const rootAccountGuid = generateGuid();
    const templateRootGuid = generateGuid();

    await prisma.$transaction(async (tx) => {
      // Create root account
      await tx.accounts.create({
        data: {
          guid: rootAccountGuid,
          name: name.trim(),
          account_type: 'ROOT',
          commodity_guid: currencyGuid,
          commodity_scu: commodityScu,
          non_std_scu: 0,
          parent_guid: null,
          code: '',
          description: '',
          hidden: 0,
          placeholder: 0,
        },
      });

      // Create template root account (required by GnuCash schema)
      await tx.accounts.create({
        data: {
          guid: templateRootGuid,
          name: 'Template Root',
          account_type: 'ROOT',
          commodity_guid: currencyGuid,
          commodity_scu: commodityScu,
          non_std_scu: 0,
          parent_guid: null,
          code: '',
          description: '',
          hidden: 0,
          placeholder: 0,
        },
      });

      // Create book record
      await tx.books.create({
        data: {
          guid: bookGuid,
          root_account_guid: rootAccountGuid,
          root_template_guid: templateRootGuid,
          name: name.trim(),
          description: description?.trim() || null,
        },
      });

      if (templateAccounts.length > 0) {
        // Map from path to guid for parent lookups
        const pathToGuid: Record<string, string> = {};

        for (const account of templateAccounts) {
          const accountGuid = generateGuid();
          pathToGuid[account.path] = accountGuid;

          // Determine parent guid: top-level accounts use rootAccountGuid
          const parentGuid = account.parentPath
            ? pathToGuid[account.parentPath]
            : rootAccountGuid;

          await tx.accounts.create({
            data: {
              guid: accountGuid,
              name: account.name,
              account_type: account.type,
              commodity_guid: currencyGuid,
              commodity_scu: commodityScu,
              non_std_scu: 0,
              parent_guid: parentGuid || rootAccountGuid,
              code: '',
              description: account.description,
              hidden: 0,
              placeholder: account.placeholder ? 1 : 0,
            },
          });
        }
      } else {
        // No template: create standard top-level placeholder accounts
        const standardAccounts = [
          { name: 'Assets', type: 'ASSET' },
          { name: 'Liabilities', type: 'LIABILITY' },
          { name: 'Income', type: 'INCOME' },
          { name: 'Expenses', type: 'EXPENSE' },
          { name: 'Equity', type: 'EQUITY' },
        ];

        for (const acc of standardAccounts) {
          await tx.accounts.create({
            data: {
              guid: generateGuid(),
              name: acc.name,
              account_type: acc.type,
              commodity_guid: currencyGuid,
              commodity_scu: commodityScu,
              non_std_scu: 0,
              parent_guid: rootAccountGuid,
              code: '',
              description: '',
              hidden: 0,
              placeholder: 1,
            },
          });
        }
      }
    });

    const accountCount = templateAccounts.length > 0
      ? templateAccounts.length
      : 5;

    return NextResponse.json(
      {
        guid: bookGuid,
        name: name.trim(),
        description: description?.trim() || null,
        accountCount,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating book from template:', error);
    return NextResponse.json(
      { error: 'Failed to create book' },
      { status: 500 }
    );
  }
}
