/**
 * Farm subtree aggregation for the Farm & Apiary Analyzer.
 *
 * On a household book the farm lives as ordinary income/expense subtrees
 * inside the personal chart of accounts. The user picks the subtree roots;
 * this module expands them to descendants and sums the year's splits so the
 * analyzer can work from actuals (annualization happens in the API route).
 */

import prisma from '@/lib/prisma';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { sumFarmSplitsInBookCurrency } from './farm-currency';

/** Tool-config type shared by the analyzer route and the Schedule F report. */
export const FARM_ANALYZER_TOOL_TYPE = 'farm_analyzer';

export interface FarmAccountRoots {
  incomeRootGuids: string[];
  expenseRootGuids: string[];
}

/**
 * The farm subtree roots the user pinned in the Farm & Apiary Analyzer.
 * Single source for both the analyzer GET and the Schedule F report route.
 */
export async function loadPinnedFarmRoots(
  _userId: number,
  bookGuid: string,
): Promise<FarmAccountRoots> {
  const shared = await ToolConfigService.getBookSingleton(bookGuid, FARM_ANALYZER_TOOL_TYPE);
  const config = shared?.config;
  const c = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const guids = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((g): g is string => typeof g === 'string' && g.length === 32)
      : [];
  return {
    incomeRootGuids: guids(c.farmIncomeAccountGuids),
    expenseRootGuids: guids(c.farmExpenseAccountGuids),
  };
}

export interface FarmAccountAmount {
  accountGuid: string;
  accountName: string;
  accountPath: string;
  amount: number;
}

export interface FarmBookData {
  /** YTD gross farm income (sign-corrected positive). */
  grossIncome: number;
  /** YTD farm operating expenses (positive). */
  expenses: number;
  incomeAccounts: FarmAccountAmount[];
  expenseAccounts: FarmAccountAmount[];
  /** Expanded guid set actually summed (selected roots + descendants). */
  incomeGuids: string[];
  expenseGuids: string[];
  /** Farm accounts that ALSO carry a tax-estimator mapping (double-count risk). */
  taxMappedFarmGuids: string[];
  /** Fraction of the tax year elapsed as of now (1 for past years). */
  elapsedYearFraction: number;
  /** Book report currency. */
  currencyCode: string;
  /** Foreign transaction currencies converted into the report currency. */
  convertedCurrencies: string[];
}

interface AccountRow {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
}

/** Selected roots + all their descendants, restricted to the book. */
export function expandGuidsToDescendants(
  rootGuids: string[],
  accounts: Array<{ guid: string; parent_guid: string | null }>,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const a of accounts) {
    if (!a.parent_guid) continue;
    const arr = childrenOf.get(a.parent_guid) ?? [];
    arr.push(a.guid);
    childrenOf.set(a.parent_guid, arr);
  }
  const inBook = new Set(accounts.map((a) => a.guid));
  const expanded = new Set<string>();
  const queue = rootGuids.filter((g) => inBook.has(g));
  while (queue.length > 0) {
    const guid = queue.pop()!;
    if (expanded.has(guid)) continue;
    expanded.add(guid);
    queue.push(...(childrenOf.get(guid) ?? []));
  }
  return [...expanded];
}

/**
 * Sum the year's splits for the selected farm income/expense subtrees.
 * Uses the same value-only-gains-offset exclusion as the tax aggregator.
 */
export async function aggregateFarmBookData(
  bookGuid: string,
  bookAccountGuids: string[],
  incomeRootGuids: string[],
  expenseRootGuids: string[],
  taxYear: number,
): Promise<FarmBookData> {
  const startDate = new Date(Date.UTC(taxYear, 0, 1));
  const endDate = new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59, 999));
  const now = new Date();
  const asOf = now < endDate ? now : endDate;
  const yearStart = Date.UTC(taxYear, 0, 1);
  const yearEnd = Date.UTC(taxYear + 1, 0, 1);
  const elapsedYearFraction = Math.min(
    1,
    Math.max(0.001, (asOf.getTime() - yearStart) / (yearEnd - yearStart)),
  );

  const accountRows = await prisma.$queryRaw<AccountRow[]>`
    SELECT guid, name, fullname, account_type, parent_guid
    FROM account_hierarchy
    WHERE guid = ANY(${bookAccountGuids})
  `;
  const infoMap = new Map(accountRows.map((a) => [a.guid, a]));

  const incomeGuids = expandGuidsToDescendants(incomeRootGuids, accountRows);
  const expenseGuids = expandGuidsToDescendants(expenseRootGuids, accountRows);
  const allGuids = [...new Set([...incomeGuids, ...expenseGuids])];

  const empty: FarmBookData = {
    grossIncome: 0,
    expenses: 0,
    incomeAccounts: [],
    expenseAccounts: [],
    incomeGuids,
    expenseGuids,
    taxMappedFarmGuids: [],
    elapsedYearFraction: Math.round(elapsedYearFraction * 10000) / 10000,
    currencyCode: '',
    convertedCurrencies: [],
  };
  if (allGuids.length === 0) return empty;

  const currencySums = await sumFarmSplitsInBookCurrency(
    bookGuid,
    allGuids,
    startDate,
    endDate,
  );
  const splitSums = currencySums.totals;

  const incomeSet = new Set(incomeGuids);
  const expenseSet = new Set(expenseGuids);
  const incomeAccounts: FarmAccountAmount[] = [];
  const expenseAccounts: FarmAccountAmount[] = [];
  let grossIncome = 0;
  let expenses = 0;

  for (const row of splitSums) {
    const info = infoMap.get(row.accountGuid);
    // Classify by the account's actual type, gated on which selection it came
    // from — a stale/crafted config pinning an EXPENSE account under income
    // roots (or vice versa) must not flip signs or sides.
    const isIncome = incomeSet.has(row.accountGuid) && info?.account_type === 'INCOME';
    const isExpense = expenseSet.has(row.accountGuid) && info?.account_type === 'EXPENSE';
    if (!isIncome && !isExpense) continue;
    // GnuCash sign convention: income accounts carry credits (negative).
    const amount = isIncome ? -row.total : row.total;
    if (Math.abs(amount) < 0.005) continue;
    const detail: FarmAccountAmount = {
      accountGuid: row.accountGuid,
      accountName: info?.name ?? 'Unknown',
      accountPath: info?.fullname ?? 'Unknown',
      amount: Math.round(amount * 100) / 100,
    };
    if (isIncome) {
      grossIncome += amount;
      incomeAccounts.push(detail);
    } else {
      expenses += amount;
      expenseAccounts.push(detail);
    }
  }
  incomeAccounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  expenseAccounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  /* --- Overlap with tax-estimator mappings (double-count risk) -------- */
  let taxMappedFarmGuids: string[] = [];
  try {
    const mappingRows = await prisma.gnucash_web_tax_mappings.findMany({
      where: { account_guid: { in: allGuids } },
      select: { account_guid: true },
    });
    taxMappedFarmGuids = mappingRows.map((r) => r.account_guid);
  } catch {
    // mappings table unavailable (mocked tests) — skip the warning
  }

  return {
    ...empty,
    grossIncome: Math.round(grossIncome * 100) / 100,
    expenses: Math.round(expenses * 100) / 100,
    incomeAccounts,
    expenseAccounts,
    taxMappedFarmGuids,
    currencyCode: currencySums.currencyCode,
    convertedCurrencies: currencySums.convertedCurrencies,
  };
}
