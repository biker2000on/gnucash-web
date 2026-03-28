import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import {
  classifyContribution,
  ContributionType,
  getRetirementAccountGuids,
} from './contribution-classifier';
import { getContributionLimit } from './irs-limits';
import type {
  ReportFilters,
  ContributionSummaryData,
  AccountContributionSummary,
  ContributionLineItem,
} from './types';
import { ReportType } from './types';

/** Accumulate amounts as integer cents to avoid floating-point drift */
function sumCents(values: number[]): number {
  const cents = values.reduce((sum, v) => sum + Math.round(v * 100), 0);
  return cents / 100;
}

interface SplitRow {
  split_guid: string;
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
  quantity_num: bigint;
  quantity_denom: bigint;
  post_date: Date;
  description: string | null;
  other_split_guid: string;
  other_account_guid: string;
  other_value_num: bigint;
  other_value_denom: bigint;
  other_quantity_num: bigint;
  other_quantity_denom: bigint;
  other_account_type: string;
  other_account_name: string;
  other_commodity_guid: string;
}

interface AccountPath {
  guid: string;
  fullname: string;
}

function emptyReport(
  filters: ReportFilters,
  groupBy: 'tax_year' | 'calendar_year',
): ContributionSummaryData {
  return {
    type: ReportType.CONTRIBUTION_SUMMARY,
    title: 'Contribution Summary',
    generatedAt: new Date().toISOString(),
    filters,
    groupBy,
    periods: [],
    grandTotalContributions: 0,
    grandTotalEmployerMatch: 0,
    grandTotalNetContributions: 0,
  };
}

export async function generateContributionSummary(
  filters: ReportFilters,
  groupBy: 'tax_year' | 'calendar_year',
  birthday: string | null,
): Promise<ContributionSummaryData> {
  const bookAccountGuids = filters.bookAccountGuids ?? [];
  if (bookAccountGuids.length === 0) {
    return emptyReport(filters, groupBy);
  }

  // Step 1: Get all retirement account GUIDs (with hierarchy inheritance)
  const retirementGuids = await getRetirementAccountGuids(bookAccountGuids);
  if (retirementGuids.size === 0) {
    return emptyReport(filters, groupBy);
  }

  const retirementGuidArray = [...retirementGuids];
  const startDate = filters.startDate ? new Date(filters.startDate) : new Date('1970-01-01');
  const endDate = filters.endDate ? new Date(filters.endDate) : new Date();

  // Step 2: Batch-load all splits for retirement accounts in the date range
  const rows = await prisma.$queryRaw<SplitRow[]>`
    SELECT
      s.guid as split_guid,
      s.account_guid,
      s.value_num, s.value_denom,
      s.quantity_num, s.quantity_denom,
      t.post_date, t.description,
      s2.guid as other_split_guid,
      s2.account_guid as other_account_guid,
      s2.value_num as other_value_num, s2.value_denom as other_value_denom,
      s2.quantity_num as other_quantity_num, s2.quantity_denom as other_quantity_denom,
      a2.account_type as other_account_type,
      a2.name as other_account_name,
      a2.commodity_guid as other_commodity_guid
    FROM splits s
    JOIN transactions t ON s.tx_guid = t.guid
    JOIN splits s2 ON s2.tx_guid = t.guid AND s2.guid != s.guid
    JOIN accounts a2 ON s2.account_guid = a2.guid
    WHERE s.account_guid = ANY(${retirementGuidArray})
      AND t.post_date >= ${startDate}
      AND t.post_date <= ${endDate}
    ORDER BY t.post_date ASC
  `;

  // Step 3: Group by split_guid (a transaction may have multiple other splits)
  const splitMap = new Map<string, {
    split: {
      guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      quantity_num: bigint;
      quantity_denom: bigint;
    };
    postDate: Date;
    description: string;
    otherSplits: Array<{
      guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      quantity_num: bigint;
      quantity_denom: bigint;
      account?: {
        account_type?: string | null;
        commodity_guid?: string | null;
        name?: string | null;
      } | null;
    }>;
  }>();

  for (const row of rows) {
    let entry = splitMap.get(row.split_guid);
    if (!entry) {
      entry = {
        split: {
          guid: row.split_guid,
          account_guid: row.account_guid,
          value_num: row.value_num,
          value_denom: row.value_denom,
          quantity_num: row.quantity_num,
          quantity_denom: row.quantity_denom,
        },
        postDate: row.post_date,
        description: row.description ?? '',
        otherSplits: [],
      };
      splitMap.set(row.split_guid, entry);
    }
    entry.otherSplits.push({
      guid: row.other_split_guid,
      account_guid: row.other_account_guid,
      value_num: row.other_value_num,
      value_denom: row.other_value_denom,
      quantity_num: row.other_quantity_num,
      quantity_denom: row.other_quantity_denom,
      account: {
        account_type: row.other_account_type,
        commodity_guid: row.other_commodity_guid,
        name: row.other_account_name,
      },
    });
  }

  // Step 4: Get account paths
  const accountPathRows = await prisma.$queryRaw<AccountPath[]>`
    SELECT guid, fullname FROM account_hierarchy WHERE guid = ANY(${retirementGuidArray})
  `;
  const accountPathMap = new Map(accountPathRows.map(r => [r.guid, r.fullname]));

  // Step 5: Batch-load tax year overrides to avoid N+1 queries
  const allSplitGuids = [...splitMap.keys()];
  const taxYearOverrides = allSplitGuids.length > 0
    ? await prisma.gnucash_web_contribution_tax_year.findMany({
        where: { split_guid: { in: allSplitGuids } },
      })
    : [];
  const taxYearMap = new Map(taxYearOverrides.map(o => [o.split_guid, o.tax_year]));

  // Classify each split and resolve tax year
  // Keyed by accountGuid -> year -> array of line items
  const accountYearItems = new Map<string, Map<number, ContributionLineItem[]>>();

  for (const [splitGuid, entry] of splitMap) {
    const classification = classifyContribution(entry.split, entry.otherSplits, retirementGuids);
    const taxYear = taxYearMap.get(splitGuid) ?? entry.postDate.getFullYear();
    const year = groupBy === 'tax_year' ? taxYear : entry.postDate.getFullYear();

    const amount = toDecimalNumber(entry.split.value_num, entry.split.value_denom);

    // Find primary source account name
    const cashSources = entry.otherSplits
      .filter(s => toDecimalNumber(s.value_num, s.value_denom) < 0)
      .sort((a, b) =>
        Math.abs(toDecimalNumber(b.value_num, b.value_denom)) -
        Math.abs(toDecimalNumber(a.value_num, a.value_denom))
      );
    const sourceAccountName = cashSources.length > 0
      ? (cashSources[0].account?.name ?? 'Unknown')
      : (entry.otherSplits[0]?.account?.name ?? 'Unknown');

    const lineItem: ContributionLineItem = {
      splitGuid,
      date: entry.postDate.toISOString().split('T')[0],
      description: entry.description ?? '',
      amount,
      type: classification,
      taxYear,
      sourceAccountName,
    };

    const accountGuid = entry.split.account_guid;
    if (!accountYearItems.has(accountGuid)) {
      accountYearItems.set(accountGuid, new Map());
    }
    const yearMap = accountYearItems.get(accountGuid)!;
    if (!yearMap.has(year)) {
      yearMap.set(year, []);
    }
    yearMap.get(year)!.push(lineItem);
  }

  // Step 6: Batch-load retirement account types (avoid N+1)
  const activeAccountGuids = retirementGuidArray.filter(g => accountYearItems.has(g));
  const retirementPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: { account_guid: { in: retirementGuidArray }, is_retirement: true },
    select: { account_guid: true, retirement_account_type: true },
  });
  const retirementPrefMap = new Map(retirementPrefs.map(p => [p.account_guid, p.retirement_account_type]));

  // Build parent map for hierarchy walking
  const allAccountsForType = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });
  const parentOfMap = new Map(allAccountsForType.map(a => [a.guid, a.parent_guid]));

  const accountTypeMap = new Map<string, string | null>();
  for (const guid of activeAccountGuids) {
    // Check direct preference first
    if (retirementPrefMap.has(guid) && retirementPrefMap.get(guid)) {
      accountTypeMap.set(guid, retirementPrefMap.get(guid)!);
      continue;
    }
    // Walk up hierarchy
    let current = parentOfMap.get(guid);
    let found = false;
    while (current) {
      const pref = retirementPrefMap.get(current);
      if (pref) {
        accountTypeMap.set(guid, pref);
        found = true;
        break;
      }
      current = parentOfMap.get(current) ?? null;
    }
    if (!found) {
      accountTypeMap.set(guid, null);
    }
  }

  // Step 7: Get account names
  const accountNameRows = await prisma.accounts.findMany({
    where: { guid: { in: retirementGuidArray } },
    select: { guid: true, name: true },
  });
  const accountNameMap = new Map(accountNameRows.map(r => [r.guid, r.name]));

  // Step 8: Aggregate by account and year, build periods
  const allYears = new Set<number>();
  for (const yearMap of accountYearItems.values()) {
    for (const year of yearMap.keys()) {
      allYears.add(year);
    }
  }

  const periods: ContributionSummaryData['periods'] = [];

  for (const year of [...allYears].sort((a, b) => b - a)) {
    const accounts: AccountContributionSummary[] = [];

    for (const [accountGuid, yearMap] of accountYearItems) {
      const items = yearMap.get(year);
      if (!items || items.length === 0) continue;

      const byType = (t: ContributionType) => items.filter(i => i.type === t).map(i => i.amount);
      const contributions = sumCents(byType(ContributionType.CONTRIBUTION));
      const employerMatch = sumCents(byType(ContributionType.EMPLOYER_MATCH));
      const incomeContributions = sumCents(byType(ContributionType.INCOME_CONTRIBUTION));
      const transfers = sumCents(byType(ContributionType.TRANSFER));
      const withdrawals = sumCents(byType(ContributionType.WITHDRAWAL));

      const netContributions = sumCents([contributions, employerMatch, incomeContributions, transfers, withdrawals]);
      const retirementAccountType = accountTypeMap.get(accountGuid) ?? null;

      // IRS limit: employee contributions only (not employer match) count toward limits
      let irsLimit: AccountContributionSummary['irsLimit'] = null;
      if (retirementAccountType && retirementAccountType !== 'brokerage') {
        const limit = await getContributionLimit(year, retirementAccountType, birthday);
        if (limit) {
          const employeeContributions = sumCents([contributions, incomeContributions]);
          irsLimit = {
            base: limit.base,
            catchUp: limit.catchUp,
            total: limit.total,
            percentUsed: limit.total > 0
              ? Math.round((employeeContributions / limit.total) * 10000) / 100
              : 0,
          };
        }
      }

      accounts.push({
        accountGuid,
        accountName: accountNameMap.get(accountGuid) ?? 'Unknown',
        accountPath: accountPathMap.get(accountGuid) ?? 'Unknown',
        retirementAccountType,
        contributions,
        employerMatch,
        incomeContributions,
        transfers,
        withdrawals,
        netContributions,
        irsLimit,
        transactions: items,
      });
    }

    // Sort accounts by accountPath
    accounts.sort((a, b) => a.accountPath.localeCompare(b.accountPath));

    const totalContributions = sumCents(accounts.map(a => a.contributions));
    const totalEmployerMatch = sumCents(accounts.map(a => a.employerMatch));
    const totalTransfers = sumCents(accounts.map(a => a.transfers));
    const totalWithdrawals = sumCents(accounts.map(a => a.withdrawals));
    const totalNetContributions = sumCents(accounts.map(a => a.netContributions));

    periods.push({
      year,
      accounts,
      totalContributions,
      totalEmployerMatch,
      totalTransfers,
      totalWithdrawals,
      totalNetContributions,
    });
  }

  const grandTotalContributions = sumCents(periods.map(p => p.totalContributions));
  const grandTotalEmployerMatch = sumCents(periods.map(p => p.totalEmployerMatch));
  const grandTotalNetContributions = sumCents(periods.map(p => p.totalNetContributions));

  return {
    type: ReportType.CONTRIBUTION_SUMMARY,
    title: 'Contribution Summary',
    generatedAt: new Date().toISOString(),
    filters,
    groupBy,
    periods,
    grandTotalContributions,
    grandTotalEmployerMatch,
    grandTotalNetContributions,
  };
}
