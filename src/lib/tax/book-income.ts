/**
 * Book-data aggregation for the tax estimator.
 *
 * Sums splits in tax-mapped accounts for a tax year by category,
 * computes realized short/long-term capital gains from lots in taxable
 * (non-retirement) investment accounts, and pulls retirement contribution
 * actuals from the contribution summary (respecting tax-year overrides).
 */

import prisma from '@/lib/prisma';
import { getRetirementAccountGuids } from '@/lib/reports/contribution-classifier';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { getAccountLots } from '@/lib/lots';
import type { BookTaxData, CategoryAggregate, TaxCategory } from './types';
import { isTaxCategory } from './types';

interface AccountInfo {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Sum as integer cents to avoid floating point drift */
function sumCents(values: number[]): number {
  return values.reduce((sum, v) => sum + Math.round(v * 100), 0) / 100;
}

/**
 * Expand mappings to descendants: a mapped account covers itself and all
 * descendants unless a descendant has its own mapping.
 */
export function expandMappingsToDescendants(
  mappings: Map<string, TaxCategory>,
  accounts: Array<{ guid: string; parent_guid: string | null }>,
): Map<string, TaxCategory> {
  const childrenOf = new Map<string, string[]>();
  for (const a of accounts) {
    if (!a.parent_guid) continue;
    const arr = childrenOf.get(a.parent_guid) ?? [];
    arr.push(a.guid);
    childrenOf.set(a.parent_guid, arr);
  }
  const expanded = new Map<string, TaxCategory>(mappings);
  const queue = [...mappings.keys()];
  while (queue.length > 0) {
    const guid = queue.pop()!;
    const category = expanded.get(guid)!;
    for (const child of childrenOf.get(guid) ?? []) {
      if (mappings.has(child)) continue; // explicit child mapping wins
      expanded.set(child, category);
      queue.push(child);
    }
  }
  return expanded;
}

export async function aggregateBookTaxData(
  bookAccountGuids: string[],
  taxYear: number,
  birthday: string | null,
): Promise<BookTaxData> {
  const startDate = new Date(Date.UTC(taxYear, 0, 1));
  const endDate = new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59));
  const now = new Date();
  const asOf = now < endDate ? now : endDate;
  const yearStart = Date.UTC(taxYear, 0, 1);
  const yearEnd = Date.UTC(taxYear + 1, 0, 1);
  const elapsedYearFraction = Math.min(
    1,
    Math.max(0.001, (asOf.getTime() - yearStart) / (yearEnd - yearStart)),
  );

  /* --- Load mappings + account metadata --- */
  const mappingRows = await prisma.gnucash_web_tax_mappings.findMany({
    where: { account_guid: { in: bookAccountGuids } },
  });
  const directMappings = new Map<string, TaxCategory>();
  for (const row of mappingRows) {
    if (isTaxCategory(row.tax_category)) {
      directMappings.set(row.account_guid, row.tax_category);
    }
  }

  const accountRows = await prisma.$queryRaw<AccountInfo[]>`
    SELECT guid, name, fullname, account_type, parent_guid
    FROM account_hierarchy
    WHERE guid = ANY(${bookAccountGuids})
  `;
  const accountInfoMap = new Map(accountRows.map(a => [a.guid, a]));

  const mappings = expandMappingsToDescendants(directMappings, accountRows);

  /* --- Sum splits per mapped account in the tax year --- */
  const categories = new Map<TaxCategory, CategoryAggregate>();
  const mappedGuids = [...mappings.keys()].filter(g => mappings.get(g) !== 'exclude');

  if (mappedGuids.length > 0) {
    const splitSums = await prisma.$queryRaw<Array<{
      account_guid: string;
      total: number | null;
    }>>`
      SELECT s.account_guid,
             (SUM(s.value_num::numeric / s.value_denom))::float8 as total
      FROM splits s
      JOIN transactions t ON s.tx_guid = t.guid
      WHERE s.account_guid = ANY(${mappedGuids})
        AND t.post_date >= ${startDate}
        AND t.post_date <= ${endDate}
      GROUP BY s.account_guid
    `;

    for (const row of splitSums) {
      if (row.total === null) continue;
      const category = mappings.get(row.account_guid);
      if (!category || category === 'exclude') continue;
      const info = accountInfoMap.get(row.account_guid);
      const raw = row.total;
      // GnuCash sign convention: INCOME accounts carry credits (negative
      // values) for money earned — negate so income reads positive.
      // EXPENSE/ASSET/LIABILITY accounts read correctly as-is.
      const amount = info?.account_type === 'INCOME' ? -raw : raw;
      if (Math.abs(amount) < 0.005) continue;

      let agg = categories.get(category);
      if (!agg) {
        agg = { category, total: 0, accounts: [] };
        categories.set(category, agg);
      }
      agg.accounts.push({
        accountGuid: row.account_guid,
        accountName: info?.name ?? 'Unknown',
        accountPath: info?.fullname ?? 'Unknown',
        amount: Math.round(amount * 100) / 100,
      });
    }
    for (const agg of categories.values()) {
      agg.total = sumCents(agg.accounts.map(a => a.amount));
      agg.accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    }
  }

  /* --- Realized capital gains from lots in taxable investment accounts --- */
  const retirementGuids = await getRetirementAccountGuids(bookAccountGuids);
  const investmentAccounts = accountRows.filter(
    a =>
      (a.account_type === 'STOCK' || a.account_type === 'MUTUAL') &&
      !retirementGuids.has(a.guid),
  );

  let shortTerm = 0;
  let longTerm = 0;
  const gainAccounts: BookTaxData['realizedGains']['accounts'] = [];

  for (const acct of investmentAccounts) {
    const lots = await getAccountLots(acct.guid);
    let acctSt = 0;
    let acctLt = 0;
    for (const lot of lots) {
      if (!lot.isClosed || !lot.closeDate) continue;
      const closed = new Date(lot.closeDate);
      if (closed.getFullYear() !== taxYear) continue;
      if (Math.abs(lot.realizedGain) < 0.005) continue;
      // Holding period: close date vs (acquisition date || open date)
      const openMs = new Date(lot.acquisitionDate || lot.openDate || lot.closeDate).getTime();
      const isLongTerm = closed.getTime() - openMs > ONE_YEAR_MS;
      if (isLongTerm) acctLt += lot.realizedGain;
      else acctSt += lot.realizedGain;
    }
    if (Math.abs(acctSt) >= 0.005 || Math.abs(acctLt) >= 0.005) {
      gainAccounts.push({
        accountGuid: acct.guid,
        accountName: acct.name,
        accountPath: acct.fullname,
        shortTerm: Math.round(acctSt * 100) / 100,
        longTerm: Math.round(acctLt * 100) / 100,
      });
      shortTerm += acctSt;
      longTerm += acctLt;
    }
  }

  /* --- Retirement contributions from contribution summary (tax-year aware) --- */
  const contributionsByType: Record<string, number> = {};
  try {
    const summary = await generateContributionSummary(
      {
        // widen the window so prior-year IRA contributions made Jan-Apr with
        // tax-year overrides are captured
        startDate: `${taxYear - 1}-01-01`,
        endDate: `${taxYear + 1}-04-30`,
        bookAccountGuids,
      },
      'tax_year',
      birthday,
    );
    const period = summary.periods.find(p => p.year === taxYear);
    if (period) {
      for (const acct of period.accounts) {
        if (!acct.retirementAccountType || acct.retirementAccountType === 'brokerage') continue;
        // Employee contributions only (employer match doesn't count toward limits)
        const employee = acct.contributions + acct.incomeContributions;
        contributionsByType[acct.retirementAccountType] =
          (contributionsByType[acct.retirementAccountType] ?? 0) + employee;
      }
      for (const key of Object.keys(contributionsByType)) {
        contributionsByType[key] = Math.round(contributionsByType[key] * 100) / 100;
      }
    }
  } catch (error) {
    console.error('Tax estimator: contribution summary failed', error);
  }

  return {
    year: taxYear,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    asOfDate: asOf.toISOString().slice(0, 10),
    elapsedYearFraction: Math.round(elapsedYearFraction * 10000) / 10000,
    categories: [...categories.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    realizedGains: {
      shortTerm: Math.round(shortTerm * 100) / 100,
      longTerm: Math.round(longTerm * 100) / 100,
      accounts: gainAccounts,
    },
    contributionsByType,
    mappedAccountCount: directMappings.size,
  };
}
