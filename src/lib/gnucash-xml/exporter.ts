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
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000');
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

  // Fetch prices only for commodities actually used by this book's accounts
  // Use AND (both commodity and currency must be in our set) to avoid pulling
  // prices from other books that happen to share a currency
  const prices = await prisma.prices.findMany({
    where: {
      commodity_guid: { in: Array.from(commodityGuids) },
      currency_guid: { in: Array.from(commodityGuids) },
    },
    include: {
      commodity: true,
      currency: true,
    },
  });

  // Fetch budgets with recurrences and filter to only those referencing accounts in this book
  const allBudgets = await prisma.budgets.findMany({
    include: { amounts: true, recurrences: true },
  });
  const guidSet = new Set(guids);
  const budgets = allBudgets
    .filter((b) => b.amounts.some((a) => guidSet.has(a.account_guid)))
    .map((b) => ({
      ...b,
      amounts: b.amounts.filter((a) => guidSet.has(a.account_guid)),
    }));

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

  // Topologically sort accounts: ROOT first, then parents before children
  const sortedAccounts = topologicalSortAccounts(accounts, rootAccountGuid);

  // Map accounts to export format
  const exportAccounts: GnuCashAccount[] = sortedAccounts.map((acc) => {
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

  // Map prices to export format, skipping any with unresolvable commodities
  const exportPrices: GnuCashPrice[] = [];
  for (const p of prices) {
    const commodity = commodityLookup.get(p.commodity_guid);
    const currency = commodityLookup.get(p.currency_guid);
    if (!commodity || !currency) continue;
    exportPrices.push({
      id: p.guid,
      commodity: { space: commodity.namespace, id: commodity.mnemonic },
      currency: { space: currency.namespace, id: currency.mnemonic },
      date: formatGnuCashDate(p.date),
      source: p.source || '',
      type: p.type || undefined,
      value: toFractionString(p.value_num, p.value_denom),
    });
  }

  // Map budgets to export format
  const exportBudgets: GnuCashBudget[] = budgets.map((b) => {
    const amounts: GnuCashBudgetAmount[] = b.amounts.map((a) => ({
      accountId: a.account_guid,
      periodNum: a.period_num,
      amount: toFractionString(a.amount_num, a.amount_denom),
    }));

    const recurrence = b.recurrences[0];
    return {
      id: b.guid,
      name: b.name,
      description: b.description || undefined,
      numPeriods: b.num_periods,
      recurrence: recurrence ? {
        mult: recurrence.recurrence_mult,
        periodType: recurrence.recurrence_period_type,
        periodStart: recurrence.recurrence_period_start.toISOString().slice(0, 10),
      } : undefined,
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

/**
 * Topologically sort accounts so ROOT comes first, then parents before children.
 * GnuCash desktop requires parent accounts to appear before their children.
 */
function topologicalSortAccounts<T extends { guid: string; parent_guid: string | null }>(
  accounts: T[],
  rootAccountGuid: string,
): T[] {
  const byGuid = new Map<string, T>();
  const childrenOf = new Map<string, T[]>();

  for (const acc of accounts) {
    byGuid.set(acc.guid, acc);
    const parentKey = acc.parent_guid || '';
    const siblings = childrenOf.get(parentKey) || [];
    siblings.push(acc);
    childrenOf.set(parentKey, siblings);
  }

  const sorted: T[] = [];
  const visited = new Set<string>();

  function visit(guid: string) {
    if (visited.has(guid)) return;
    visited.add(guid);
    const acc = byGuid.get(guid);
    if (acc) sorted.push(acc);
    const children = childrenOf.get(guid) || [];
    for (const child of children) {
      visit(child.guid);
    }
  }

  // Start from root
  visit(rootAccountGuid);

  // Pick up any orphans (shouldn't happen, but safety)
  for (const acc of accounts) {
    if (!visited.has(acc.guid)) {
      sorted.push(acc);
    }
  }

  return sorted;
}
