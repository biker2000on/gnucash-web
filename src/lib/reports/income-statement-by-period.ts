import prisma from '@/lib/prisma';
import {
  ReportType,
  ReportFilters,
  PeriodicReportData,
  PeriodicReportSection,
  PeriodicLineItem,
  PeriodGrouping,
  PeriodColumn,
} from './types';
import { toDecimal, resolveRootGuid } from './utils';
import { generatePeriods } from '@/lib/datePresets';

interface AccountRow {
  guid: string;
  name: string;
  account_type: string;
  parent_guid: string | null;
}

interface AccountWithPeriodAmounts extends AccountRow {
  amounts: number[];
}

/**
 * Build PeriodicLineItem hierarchy, rolling child period amounts up to parents.
 */
function buildPeriodicHierarchy(
  accounts: AccountWithPeriodAmounts[],
  parentGuid: string | null,
  depth: number,
  periodCount: number
): PeriodicLineItem[] {
  const children = accounts.filter(a => a.parent_guid === parentGuid);
  return children.map(acc => {
    const childItems = buildPeriodicHierarchy(accounts, acc.guid, depth + 1, periodCount);
    const amounts = Array.from({ length: periodCount }, (_, i) =>
      acc.amounts[i] + childItems.reduce((sum, c) => sum + c.amounts[i], 0)
    );
    const total = amounts.reduce((s, v) => s + v, 0);
    return {
      guid: acc.guid,
      name: acc.name,
      amounts,
      total,
      children: childItems.length > 0 ? childItems : undefined,
      depth,
    };
  });
}

/**
 * Generate Income Statement broken out into period columns (month / quarter /
 * year) for side-by-side comparison across time.
 *
 * Implementation fetches all splits for the full range once and buckets by
 * period in memory so we don't issue one query per (account × period).
 */
export async function generateIncomeStatementByPeriod(
  filters: ReportFilters,
  grouping: PeriodGrouping
): Promise<PeriodicReportData> {
  const now = new Date();
  const startDate = filters.startDate
    ? new Date(filters.startDate + 'T00:00:00')
    : new Date(now.getFullYear(), 0, 1);
  const endDate = filters.endDate
    ? new Date(filters.endDate + 'T23:59:59')
    : now;

  const periodWindows = generatePeriods(startDate, endDate, grouping);
  const periods: PeriodColumn[] = periodWindows;
  const periodCount = periods.length;

  // Precompute numeric boundaries for fast bucketing
  const periodStarts = periods.map(p => new Date(p.startDate + 'T00:00:00').getTime());
  const periodEnds = periods.map(p => new Date(p.endDate + 'T23:59:59').getTime());

  const rootGuid = await resolveRootGuid(filters.bookAccountGuids);

  // Fetch income + expense accounts in scope
  const accounts: AccountRow[] = await prisma.accounts.findMany({
    where: {
      ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
      account_type: { in: ['INCOME', 'EXPENSE'] },
      hidden: 0,
    },
    select: {
      guid: true,
      name: true,
      account_type: true,
      parent_guid: true,
    },
  });

  if (accounts.length === 0) {
    return {
      type: ReportType.INCOME_STATEMENT_BY_PERIOD,
      title: 'Income Statement by Period',
      generatedAt: new Date().toISOString(),
      filters,
      grouping,
      periods,
      sections: [
        { title: 'Income', items: [], totals: new Array(periodCount).fill(0), grandTotal: 0 },
        { title: 'Expenses', items: [], totals: new Array(periodCount).fill(0), grandTotal: 0 },
      ],
      netByPeriod: new Array(periodCount).fill(0),
      netTotal: 0,
    };
  }

  const accountGuids = accounts.map(a => a.guid);

  // One DB call for all splits in the whole window, then bucket in memory
  const rangeStart = periodStarts[0] ? new Date(periodStarts[0]) : startDate;
  const rangeEnd = periodEnds[periodEnds.length - 1] ? new Date(periodEnds[periodEnds.length - 1]) : endDate;

  const splits = await prisma.splits.findMany({
    where: {
      account_guid: { in: accountGuids },
      transaction: {
        post_date: { gte: rangeStart, lte: rangeEnd },
      },
    },
    select: {
      account_guid: true,
      quantity_num: true,
      quantity_denom: true,
      transaction: { select: { post_date: true } },
    },
  });

  // Bucket splits: guid → amounts[period]
  const amountsByGuid = new Map<string, number[]>();
  for (const acc of accounts) {
    amountsByGuid.set(acc.guid, new Array(periodCount).fill(0));
  }

  for (const s of splits) {
    const postDate = s.transaction.post_date?.getTime();
    if (!postDate) continue;
    // Linear search is fine for small period counts (< ~50)
    for (let i = 0; i < periodCount; i++) {
      if (postDate >= periodStarts[i] && postDate <= periodEnds[i]) {
        const bucket = amountsByGuid.get(s.account_guid);
        if (bucket) bucket[i] += toDecimal(s.quantity_num, s.quantity_denom);
        break;
      }
    }
  }

  const accountsWithAmounts: AccountWithPeriodAmounts[] = accounts.map(a => ({
    ...a,
    amounts: amountsByGuid.get(a.guid)!,
  }));

  const incomeAccounts = accountsWithAmounts.filter(a => a.account_type === 'INCOME');
  const expenseAccounts = accountsWithAmounts.filter(a => a.account_type === 'EXPENSE');

  // Income is stored negative in GnuCash; flip the sign for display
  const incomeItems = buildPeriodicHierarchy(incomeAccounts, rootGuid, 0, periodCount).map(negateItem);
  const expenseItems = buildPeriodicHierarchy(expenseAccounts, rootGuid, 0, periodCount);

  const incomeTotals = sumTopLevelAmounts(incomeItems, periodCount);
  const expenseTotals = sumTopLevelAmounts(expenseItems, periodCount);

  const netByPeriod = incomeTotals.map((v, i) => v - expenseTotals[i]);
  const netTotal = netByPeriod.reduce((s, v) => s + v, 0);

  const sections: PeriodicReportSection[] = [
    {
      title: 'Income',
      items: incomeItems,
      totals: incomeTotals,
      grandTotal: incomeTotals.reduce((s, v) => s + v, 0),
    },
    {
      title: 'Expenses',
      items: expenseItems,
      totals: expenseTotals,
      grandTotal: expenseTotals.reduce((s, v) => s + v, 0),
    },
  ];

  return {
    type: ReportType.INCOME_STATEMENT_BY_PERIOD,
    title: 'Income Statement by Period',
    generatedAt: new Date().toISOString(),
    filters,
    grouping,
    periods,
    sections,
    netByPeriod,
    netTotal,
  };
}

function negateItem(item: PeriodicLineItem): PeriodicLineItem {
  return {
    ...item,
    amounts: item.amounts.map(v => -v),
    total: -item.total,
    children: item.children?.map(negateItem),
  };
}

function sumTopLevelAmounts(items: PeriodicLineItem[], periodCount: number): number[] {
  const totals = new Array(periodCount).fill(0);
  for (const it of items) {
    for (let i = 0; i < periodCount; i++) totals[i] += it.amounts[i];
  }
  return totals;
}
