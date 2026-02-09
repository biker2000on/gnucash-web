/**
 * GnuCash XML Importer
 *
 * Imports parsed GnuCash XML data into PostgreSQL via Prisma.
 * Handles commodity lookup/creation, topological account ordering,
 * and fraction string parsing for BigInt fields.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import type { GnuCashXmlData, ImportSummary } from './types';

/**
 * Parse a GnuCash fraction string like "1234/100" into BigInt numerator and denominator.
 */
function parseFraction(fractionStr: string): { num: bigint; denom: bigint } {
  const parts = fractionStr.split('/');
  if (parts.length === 2) {
    return {
      num: BigInt(parts[0].trim()),
      denom: BigInt(parts[1].trim()),
    };
  }
  // If no slash, treat as whole number with denom 1
  return {
    num: BigInt(parts[0].trim() || '0'),
    denom: 1n,
  };
}

/**
 * Parse a GnuCash date string into a JavaScript Date.
 * GnuCash dates look like: "2024-01-15 10:30:00 +0000"
 */
function parseGnuCashDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  // Try direct ISO parse first
  const trimmed = dateStr.trim();
  // Replace space between date and time with 'T' for ISO format
  const isoLike = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2');
  const date = new Date(isoLike);
  if (!isNaN(date.getTime())) return date;
  // Fallback: try as-is
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) return fallback;
  return null;
}

/**
 * Topologically sort accounts so parents come before children.
 */
function topologicalSortAccounts(
  accounts: GnuCashXmlData['accounts']
): GnuCashXmlData['accounts'] {
  const sorted: GnuCashXmlData['accounts'] = [];
  const visited = new Set<string>();
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  function visit(id: string) {
    if (visited.has(id)) return;
    const account = accountById.get(id);
    if (!account) return;

    // Visit parent first
    if (account.parentId && accountById.has(account.parentId)) {
      visit(account.parentId);
    }

    visited.add(id);
    sorted.push(account);
  }

  for (const account of accounts) {
    visit(account.id);
  }

  return sorted;
}

/**
 * Import parsed GnuCash XML data into the database.
 */
export async function importGnuCashData(data: GnuCashXmlData): Promise<ImportSummary> {
  const summary: ImportSummary = {
    commodities: 0,
    accounts: 0,
    transactions: 0,
    splits: 0,
    prices: 0,
    budgets: 0,
    budgetAmounts: 0,
    skipped: [],
    warnings: [],
  };

  await prisma.$transaction(async (tx) => {
    // 1. Create/find commodities
    // Build a map of (space:id) -> database GUID
    const commodityMap = new Map<string, string>();

    // First, load all existing commodities
    const existingCommodities = await tx.commodities.findMany();
    for (const c of existingCommodities) {
      commodityMap.set(`${c.namespace}:${c.mnemonic}`, c.guid);
    }

    // Create missing commodities
    for (const commodity of data.commodities) {
      const key = `${commodity.space}:${commodity.id}`;
      if (commodityMap.has(key)) {
        summary.skipped.push(`Commodity ${key} already exists`);
        continue;
      }

      const guid = generateGuid();
      await tx.commodities.create({
        data: {
          guid,
          namespace: commodity.space,
          mnemonic: commodity.id,
          fullname: commodity.name || null,
          cusip: commodity.xcode || null,
          fraction: commodity.fraction || 100,
          quote_flag: commodity.quoteFlag || 0,
          quote_source: commodity.quoteSource || null,
          quote_tz: commodity.quoteTz || null,
        },
      });
      commodityMap.set(key, guid);
      summary.commodities++;
    }

    // 2. Create a new book with root account
    // Find USD commodity for root account (fallback to first CURRENCY commodity)
    let rootCommodityGuid = commodityMap.get('CURRENCY:USD');
    if (!rootCommodityGuid) {
      // Try to find any currency commodity
      for (const [key, guid] of commodityMap) {
        if (key.startsWith('CURRENCY:')) {
          rootCommodityGuid = guid;
          break;
        }
      }
    }
    if (!rootCommodityGuid) {
      // Create a USD commodity as fallback
      rootCommodityGuid = generateGuid();
      await tx.commodities.create({
        data: {
          guid: rootCommodityGuid,
          namespace: 'CURRENCY',
          mnemonic: 'USD',
          fullname: 'US Dollar',
          cusip: null,
          fraction: 100,
          quote_flag: 1,
          quote_source: 'currency',
          quote_tz: null,
        },
      });
      commodityMap.set('CURRENCY:USD', rootCommodityGuid);
    }

    const bookGuid = data.book?.id || generateGuid();
    const rootAccountGuid = generateGuid();

    // Create the root account
    await tx.accounts.create({
      data: {
        guid: rootAccountGuid,
        name: 'Root Account',
        account_type: 'ROOT',
        commodity_guid: rootCommodityGuid,
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: null,
        hidden: 0,
        placeholder: 0,
      },
    });

    // Create the book record
    await tx.books.create({
      data: {
        guid: bookGuid,
        root_account_guid: rootAccountGuid,
        root_template_guid: rootAccountGuid,
      },
    });

    // 3. Create accounts in topological order (parents before children)
    const sortedAccounts = topologicalSortAccounts(data.accounts);
    const accountGuidMap = new Map<string, string>(); // old GUID -> new GUID (preserve originals)

    // Find the XML root account (the one with no parent or type ROOT)
    const xmlRootAccounts = data.accounts.filter(
      (a) => a.type === 'ROOT' || !a.parentId
    );
    const xmlRootIds = new Set(xmlRootAccounts.map((a) => a.id));

    for (const account of sortedAccounts) {
      // Skip ROOT accounts from the XML - we've already created our own
      if (account.type === 'ROOT') {
        accountGuidMap.set(account.id, rootAccountGuid);
        summary.skipped.push(`Root account "${account.name}" mapped to new root`);
        continue;
      }

      // Determine parent GUID
      let parentGuid: string | null = null;
      if (account.parentId) {
        if (xmlRootIds.has(account.parentId)) {
          // Parent is the XML root, map to our root
          parentGuid = rootAccountGuid;
        } else {
          parentGuid = accountGuidMap.get(account.parentId) || null;
        }
      } else {
        // No parent -> child of root
        parentGuid = rootAccountGuid;
      }

      // Resolve commodity GUID
      let commodityGuid: string | null = null;
      if (account.commodity) {
        const key = `${account.commodity.space}:${account.commodity.id}`;
        commodityGuid = commodityMap.get(key) || null;
        if (!commodityGuid) {
          summary.warnings.push(`Commodity ${key} not found for account "${account.name}"`);
          commodityGuid = rootCommodityGuid; // fallback to root commodity
        }
      } else {
        commodityGuid = rootCommodityGuid;
      }

      // Preserve original GUID from XML
      const accountGuid = account.id;
      accountGuidMap.set(account.id, accountGuid);

      await tx.accounts.create({
        data: {
          guid: accountGuid,
          name: account.name,
          account_type: account.type,
          commodity_guid: commodityGuid,
          commodity_scu: account.commodityScu || 100,
          non_std_scu: 0,
          parent_guid: parentGuid,
          description: account.description || null,
          hidden: 0,
          placeholder: 0,
        },
      });
      summary.accounts++;
    }

    // 4. Create transactions and splits
    for (const transaction of data.transactions) {
      // Resolve currency GUID
      const currencyKey = `${transaction.currency.space}:${transaction.currency.id}`;
      let currencyGuid = commodityMap.get(currencyKey);
      if (!currencyGuid) {
        summary.warnings.push(`Currency ${currencyKey} not found for transaction "${transaction.description}"`);
        currencyGuid = rootCommodityGuid;
      }

      const postDate = parseGnuCashDate(transaction.datePosted);
      const enterDate = parseGnuCashDate(transaction.dateEntered);

      await tx.transactions.create({
        data: {
          guid: transaction.id,
          currency_guid: currencyGuid,
          num: transaction.num || '',
          post_date: postDate,
          enter_date: enterDate,
          description: transaction.description,
        },
      });
      summary.transactions++;

      // Create splits for this transaction
      for (const split of transaction.splits) {
        const accountGuid = accountGuidMap.get(split.accountId);
        if (!accountGuid) {
          summary.warnings.push(
            `Account ${split.accountId} not found for split in transaction "${transaction.description}"`
          );
          continue;
        }

        const value = parseFraction(split.value);
        const quantity = parseFraction(split.quantity);
        const reconcileDate = split.reconcileDate
          ? parseGnuCashDate(split.reconcileDate)
          : null;

        await tx.splits.create({
          data: {
            guid: split.id,
            tx_guid: transaction.id,
            account_guid: accountGuid,
            memo: split.memo || '',
            action: split.action || '',
            reconcile_state: split.reconciledState || 'n',
            reconcile_date: reconcileDate,
            value_num: value.num,
            value_denom: value.denom,
            quantity_num: quantity.num,
            quantity_denom: quantity.denom,
            lot_guid: split.lotId || null,
          },
        });
        summary.splits++;
      }
    }

    // 5. Create prices
    for (const price of data.pricedb) {
      const commodityKey = `${price.commodity.space}:${price.commodity.id}`;
      const currencyKey = `${price.currency.space}:${price.currency.id}`;
      const commodityGuid = commodityMap.get(commodityKey);
      const currencyGuid = commodityMap.get(currencyKey);

      if (!commodityGuid || !currencyGuid) {
        summary.warnings.push(
          `Price skipped: commodity ${commodityKey} or currency ${currencyKey} not found`
        );
        continue;
      }

      const value = parseFraction(price.value);
      const priceDate = parseGnuCashDate(price.date);

      if (!priceDate) {
        summary.warnings.push(`Price skipped: invalid date "${price.date}"`);
        continue;
      }

      await tx.prices.create({
        data: {
          guid: price.id || generateGuid(),
          commodity_guid: commodityGuid,
          currency_guid: currencyGuid,
          date: priceDate,
          source: price.source || null,
          type: price.type || null,
          value_num: value.num,
          value_denom: value.denom,
        },
      });
      summary.prices++;
    }

    // 6. Create budgets and budget amounts
    for (const budget of data.budgets) {
      await tx.budgets.create({
        data: {
          guid: budget.id,
          name: budget.name,
          description: budget.description || null,
          num_periods: budget.numPeriods,
        },
      });
      summary.budgets++;

      for (const amount of budget.amounts) {
        const accountGuid = accountGuidMap.get(amount.accountId);
        if (!accountGuid) {
          summary.warnings.push(
            `Budget amount skipped: account ${amount.accountId} not found for budget "${budget.name}"`
          );
          continue;
        }

        const amountFraction = parseFraction(amount.amount);

        await tx.budget_amounts.create({
          data: {
            budget_guid: budget.id,
            account_guid: accountGuid,
            period_num: amount.periodNum,
            amount_num: amountFraction.num,
            amount_denom: amountFraction.denom,
          },
        });
        summary.budgetAmounts++;
      }
    }
  });

  return summary;
}
