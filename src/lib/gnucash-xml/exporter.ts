/**
 * GnuCash XML Exporter
 *
 * Exports data from the PostgreSQL database into the GnuCashXmlData format
 * suitable for building into GnuCash XML files.
 */

import prisma from '@/lib/prisma';
import type {
  GnuCashXmlData,
  GnuCashCommodity,
  GnuCashPrice,
  GnuCashAccount,
  GnuCashTransaction,
  GnuCashBudget,
  GnuCashBudgetAmount,
} from './types';

/**
 * Format BigInt numerator and denominator as a fraction string "num/denom".
 */
function toFractionString(num: bigint, denom: bigint): string {
  return `${num}/${denom}`;
}

/**
 * Format a Date as a GnuCash timestamp string.
 */
function formatGnuCashDate(date: Date | null): string {
  if (!date) return '';
  return date.toISOString().replace('T', ' ').replace('Z', ' +0000');
}

/**
 * Export all data for a book (identified by root account GUID) into GnuCashXmlData.
 */
export async function exportBookData(rootAccountGuid: string): Promise<GnuCashXmlData> {
  // Get the book record
  const book = await prisma.books.findFirst({
    where: { root_account_guid: rootAccountGuid },
  });

  if (!book) {
    throw new Error('Book not found for the given root account');
  }

  // Get all account GUIDs recursively under the root
  const accountRows = await prisma.$queryRaw<{ guid: string }[]>`
    WITH RECURSIVE account_tree AS (
      SELECT guid FROM accounts WHERE parent_guid = ${rootAccountGuid}
      UNION ALL
      SELECT a.guid FROM accounts a
      JOIN account_tree t ON a.parent_guid = t.guid
    )
    SELECT guid FROM account_tree
  `;

  const guids = accountRows.map((a) => a.guid);

  // Include the root account itself
  guids.push(rootAccountGuid);

  // Fetch all accounts with their commodities
  const accounts = await prisma.accounts.findMany({
    where: { guid: { in: guids } },
    include: { commodity: true },
  });

  // Collect all commodity GUIDs used by accounts and transactions
  const commodityGuids = new Set<string>();
  for (const acc of accounts) {
    if (acc.commodity_guid) commodityGuids.add(acc.commodity_guid);
  }

  // Fetch transactions that have splits in our accounts
  // Use the non-root account guids (exclude root for split matching)
  const nonRootGuids = guids.filter((g) => g !== rootAccountGuid);
  const transactions = await prisma.transactions.findMany({
    where: {
      splits: { some: { account_guid: { in: nonRootGuids } } },
    },
    include: {
      splits: true,
      currency: true,
    },
  });

  // Add transaction currency commodity GUIDs
  for (const tx of transactions) {
    commodityGuids.add(tx.currency_guid);
  }

  // Fetch all referenced commodities
  const commodities = await prisma.commodities.findMany({
    where: { guid: { in: Array.from(commodityGuids) } },
  });

  // Fetch prices for all referenced commodities
  const prices = await prisma.prices.findMany({
    where: {
      OR: [
        { commodity_guid: { in: Array.from(commodityGuids) } },
        { currency_guid: { in: Array.from(commodityGuids) } },
      ],
    },
    include: {
      commodity: true,
      currency: true,
    },
  });

  // Fetch all budgets (not book-scoped in GnuCash schema)
  const budgets = await prisma.budgets.findMany({
    include: { amounts: true },
  });

  // Build the commodity namespace:mnemonic -> guid lookup
  const commodityLookup = new Map<string, { namespace: string; mnemonic: string }>();
  for (const c of commodities) {
    commodityLookup.set(c.guid, { namespace: c.namespace, mnemonic: c.mnemonic });
  }

  // Map commodities to export format
  const exportCommodities: GnuCashCommodity[] = commodities.map((c) => ({
    space: c.namespace,
    id: c.mnemonic,
    name: c.fullname || undefined,
    xcode: c.cusip || undefined,
    fraction: c.fraction,
    quoteFlag: c.quote_flag || undefined,
    quoteSource: c.quote_source || undefined,
    quoteTz: c.quote_tz || undefined,
  }));

  // Map accounts to export format
  const exportAccounts: GnuCashAccount[] = accounts.map((acc) => {
    const commodity = acc.commodity_guid ? commodityLookup.get(acc.commodity_guid) : undefined;
    return {
      name: acc.name,
      id: acc.guid,
      type: acc.account_type,
      commodity: commodity
        ? { space: commodity.namespace, id: commodity.mnemonic }
        : undefined,
      commodityScu: acc.commodity_scu,
      description: acc.description || undefined,
      parentId: acc.parent_guid || undefined,
    };
  });

  // Map transactions to export format
  const exportTransactions: GnuCashTransaction[] = transactions.map((tx) => {
    const currency = commodityLookup.get(tx.currency_guid);
    return {
      id: tx.guid,
      currency: currency
        ? { space: currency.namespace, id: currency.mnemonic }
        : { space: 'CURRENCY', id: 'USD' },
      num: tx.num || undefined,
      datePosted: formatGnuCashDate(tx.post_date),
      dateEntered: formatGnuCashDate(tx.enter_date),
      description: tx.description || '',
      splits: tx.splits.map((split) => ({
        id: split.guid,
        reconciledState: split.reconcile_state,
        reconcileDate: split.reconcile_date
          ? formatGnuCashDate(split.reconcile_date)
          : undefined,
        value: toFractionString(split.value_num, split.value_denom),
        quantity: toFractionString(split.quantity_num, split.quantity_denom),
        accountId: split.account_guid,
        memo: split.memo || undefined,
        action: split.action || undefined,
        lot_guid: split.lot_guid || undefined,
      })),
    };
  });

  // Map prices to export format
  const exportPrices: GnuCashPrice[] = prices.map((p) => {
    const commodity = commodityLookup.get(p.commodity_guid);
    const currency = commodityLookup.get(p.currency_guid);
    return {
      id: p.guid,
      commodity: commodity
        ? { space: commodity.namespace, id: commodity.mnemonic }
        : { space: '', id: '' },
      currency: currency
        ? { space: currency.namespace, id: currency.mnemonic }
        : { space: '', id: '' },
      date: formatGnuCashDate(p.date),
      source: p.source || '',
      type: p.type || undefined,
      value: toFractionString(p.value_num, p.value_denom),
    };
  });

  // Map budgets to export format
  const exportBudgets: GnuCashBudget[] = budgets.map((b) => {
    const amounts: GnuCashBudgetAmount[] = b.amounts.map((a) => ({
      accountId: a.account_guid,
      periodNum: a.period_num,
      amount: toFractionString(a.amount_num, a.amount_denom),
    }));

    return {
      id: b.guid,
      name: b.name,
      description: b.description || undefined,
      numPeriods: b.num_periods,
      amounts,
    };
  });

  return {
    book: {
      id: book.guid,
      idType: 'guid',
    },
    commodities: exportCommodities,
    pricedb: exportPrices,
    accounts: exportAccounts,
    transactions: exportTransactions,
    budgets: exportBudgets,
    countData: {
      account: exportAccounts.length,
      transaction: exportTransactions.length,
      commodity: exportCommodities.length,
      budget: exportBudgets.length,
    },
  };
}
