import prisma from '@/lib/prisma';
import {
  resolveAccountOwners,
  withRetirementSelfDefault,
  type AccountOwner,
} from '@/lib/ownership';
import { getRetirementAccountGuids } from '@/lib/reports/contribution-classifier';
import { ReportType, ReportData, ReportFilters, ReportSection } from './types';
import { buildAccountPathMap } from './utils';

/**
 * Spending by Member report — the expense-side twin of Net Worth by Owner.
 *
 * For each transaction in the period that touches an EXPENSE account, the
 * expense amount is attributed to the household member who FUNDED it: the
 * owner of the non-expense split's account (the bank / credit-card / asset
 * side of the transaction), using the same Owner preference + ancestor
 * inheritance as src/lib/ownership.ts. When the funding splits resolve to
 * more than one member (or to an explicitly joint account) the transaction
 * lands in the Joint bucket; when no funding account has an owner it lands
 * in Unassigned.
 *
 * Refunds show up naturally: a negative expense split (store refund back to
 * the card) reduces the funding member's total for that category.
 *
 * Amounts are split quantities (the expense account's commodity — the
 * household currency in practice), matching the day-of-week and income
 * statement flow reports.
 */

export const MEMBER_BUCKET_ORDER = ['self', 'spouse', 'joint', 'unassigned'] as const;
export type MemberBucketKey = (typeof MEMBER_BUCKET_ORDER)[number];

export const MEMBER_BUCKET_LABELS: Record<MemberBucketKey, string> = {
  self: 'Self',
  spouse: 'Spouse',
  joint: 'Joint',
  unassigned: 'Unassigned',
};

/** Optional household member names (from the entity profile) for labels. */
export interface MemberBucketNames {
  self?: string | null;
  spouse?: string | null;
}

function resolveBucketLabel(owner: MemberBucketKey, names?: MemberBucketNames): string {
  if (owner === 'self' && names?.self) return names.self;
  if (owner === 'spouse' && names?.spouse) return names.spouse;
  return MEMBER_BUCKET_LABELS[owner];
}

/** One split inside a transaction, as fed to the pure bucketing core. */
export interface MemberSpendingSplitInput {
  accountGuid: string;
  /** GnuCash account type ('EXPENSE', 'BANK', 'CREDIT', ...). */
  accountType: string;
  /** Signed split quantity (expense positive; refunds negative). */
  amount: number;
}

export interface MemberSpendingTxnInput {
  txGuid: string;
  splits: MemberSpendingSplitInput[];
}

export interface MemberSpendingCategory {
  guid: string;
  /** Full account path, e.g. "Expenses:Groceries". */
  name: string;
  amount: number;
}

export interface MemberSpendingBucket {
  owner: MemberBucketKey;
  label: string;
  total: number;
  categories: MemberSpendingCategory[];
}

export interface MemberSpendingData extends ReportData {
  type: ReportType;
  startDate: string;
  endDate: string;
  currency: string;
  buckets: MemberSpendingBucket[];
  totals: { total: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Owner of a transaction's FUNDING side: the owners of its non-expense
 * splits' accounts. One distinct member → that member; any joint account or
 * a self+spouse mix → 'joint'; no owned funding account → 'unassigned'.
 * Exported for unit tests.
 */
export function resolveFundingOwner(
  splits: MemberSpendingSplitInput[],
  ownerMap: Map<string, AccountOwner>,
): MemberBucketKey {
  const owners = new Set<AccountOwner>();
  for (const split of splits) {
    if (split.accountType === 'EXPENSE') continue;
    const owner = ownerMap.get(split.accountGuid);
    if (owner) owners.add(owner);
  }
  if (owners.size === 0) return 'unassigned';
  if (owners.has('joint') || owners.size > 1) return 'joint';
  return owners.has('self') ? 'self' : 'spouse';
}

/**
 * Pure bucketing core (exported for unit tests): attribute each expense
 * split to the funding member's bucket, accumulated per expense account.
 * Categories that net to ~zero are dropped; empty buckets are omitted.
 */
export function bucketSpendingByMember(
  txns: MemberSpendingTxnInput[],
  ownerMap: Map<string, AccountOwner>,
  categoryNames: Map<string, string>,
  ownerNames?: MemberBucketNames,
): { buckets: MemberSpendingBucket[]; totals: { total: number } } {
  // bucket -> expense account guid -> amount
  const byBucket = new Map<MemberBucketKey, Map<string, number>>();

  for (const txn of txns) {
    const bucket = resolveFundingOwner(txn.splits, ownerMap);
    for (const split of txn.splits) {
      if (split.accountType !== 'EXPENSE') continue;
      if (!Number.isFinite(split.amount) || split.amount === 0) continue;
      const categories = byBucket.get(bucket) ?? new Map<string, number>();
      categories.set(split.accountGuid, (categories.get(split.accountGuid) ?? 0) + split.amount);
      byBucket.set(bucket, categories);
    }
  }

  const buckets: MemberSpendingBucket[] = [];
  let grandTotal = 0;

  for (const owner of MEMBER_BUCKET_ORDER) {
    const categoryAmounts = byBucket.get(owner);
    if (!categoryAmounts) continue;

    const categories: MemberSpendingCategory[] = [];
    for (const [guid, amount] of categoryAmounts) {
      if (Math.abs(amount) < 0.005) continue; // netted out (e.g. full refund)
      categories.push({
        guid,
        name: categoryNames.get(guid) ?? guid,
        amount: round2(amount),
      });
    }
    if (categories.length === 0) continue;

    categories.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    const total = round2(categories.reduce((sum, c) => sum + c.amount, 0));

    buckets.push({
      owner,
      label: resolveBucketLabel(owner, ownerNames),
      total,
      categories,
    });
    grandTotal = round2(grandTotal + total);
  }

  return { buckets, totals: { total: grandTotal } };
}

/** ReportViewer/CSV sections: one per member, items = expense categories. */
function buildSections(buckets: MemberSpendingBucket[]): ReportSection[] {
  return buckets.map(bucket => ({
    title: bucket.label,
    items: bucket.categories.map(category => ({
      guid: category.guid,
      name: category.name,
      amount: category.amount,
    })),
    total: bucket.total,
  }));
}

interface SplitRow {
  tx_guid: string;
  account_guid: string;
  account_type: string;
  amount: number | null;
}

/**
 * Generate the Spending by Member report for [startDate, endDate]
 * (inclusive, YYYY-MM-DD). `filters.bookAccountGuids` scopes both the
 * expense accounts and the ownership resolution.
 */
export async function generateMemberSpending(
  filters: ReportFilters,
  ownerNames?: MemberBucketNames,
): Promise<MemberSpendingData> {
  const endDate = filters.endDate ?? new Date().toISOString().split('T')[0];
  const startDate = filters.startDate ?? `${endDate.slice(0, 4)}-01-01`;

  const scopeGuids = filters.bookAccountGuids && filters.bookAccountGuids.length > 0
    ? filters.bookAccountGuids
    : (await prisma.accounts.findMany({ select: { guid: true } })).map(a => a.guid);

  const expenseAccounts = await prisma.accounts.findMany({
    where: { guid: { in: scopeGuids }, account_type: 'EXPENSE' },
    select: { guid: true },
  });
  const expenseGuids = expenseAccounts.map(a => a.guid);

  // All splits of transactions in the period that touch a scoped expense
  // account — the expense splits AND their funding-side siblings.
  let rows: SplitRow[] = [];
  if (expenseGuids.length > 0) {
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T23:59:59Z');
    rows = await prisma.$queryRaw<SplitRow[]>`
      SELECT s.tx_guid,
             s.account_guid,
             a.account_type,
             (s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS amount
      FROM splits s
      JOIN accounts a ON a.guid = s.account_guid
      JOIN transactions t ON t.guid = s.tx_guid
      WHERE t.post_date >= ${start}
        AND t.post_date <= ${end}
        AND EXISTS (
          SELECT 1
          FROM splits sx
          WHERE sx.tx_guid = s.tx_guid
            AND sx.account_guid = ANY(${expenseGuids}::text[])
        )
    `;
  }

  // Group split rows into transactions for funding-owner resolution.
  const txnMap = new Map<string, MemberSpendingTxnInput>();
  const expenseGuidSet = new Set(expenseGuids);
  for (const row of rows) {
    const txn = txnMap.get(row.tx_guid) ?? { txGuid: row.tx_guid, splits: [] };
    txn.splits.push({
      accountGuid: row.account_guid,
      // Expense accounts OUTSIDE the book scope (shouldn't happen in a
      // well-formed book) are treated as funding so nothing double counts.
      accountType: row.account_type === 'EXPENSE' && !expenseGuidSet.has(row.account_guid)
        ? 'EXPENSE_OUT_OF_SCOPE'
        : row.account_type,
      amount: Number(row.amount ?? 0),
    });
    txnMap.set(row.tx_guid, txn);
  }

  const [pathMap, explicitOwners, retirementGuids] = await Promise.all([
    buildAccountPathMap(scopeGuids),
    resolveAccountOwners(scopeGuids),
    getRetirementAccountGuids(scopeGuids),
  ]);
  // Unset retirement accounts default to Self (matches the account editor
  // and Net Worth by Owner), so an IRA-funded expense attributes correctly.
  const ownerMap = withRetirementSelfDefault(explicitOwners, retirementGuids);

  const { buckets, totals } = bucketSpendingByMember(
    [...txnMap.values()],
    ownerMap,
    pathMap,
    ownerNames,
  );

  // Report currency label: the most common currency across scoped expense
  // accounts (cosmetic — amounts are split quantities).
  let currency = 'USD';
  if (expenseGuids.length > 0) {
    const currencyRows = await prisma.$queryRaw<Array<{ mnemonic: string }>>`
      SELECT c.mnemonic
      FROM accounts a
      JOIN commodities c ON c.guid = a.commodity_guid
      WHERE a.guid = ANY(${expenseGuids}::text[])
        AND c.namespace = 'CURRENCY'
      GROUP BY c.mnemonic
      ORDER BY COUNT(*) DESC
      LIMIT 1
    `;
    if (currencyRows.length > 0) currency = currencyRows[0].mnemonic;
  }

  return {
    type: ReportType.MEMBER_SPENDING,
    title: 'Spending by Member',
    generatedAt: new Date().toISOString(),
    filters: { ...filters, startDate, endDate },
    startDate,
    endDate,
    currency,
    buckets,
    totals,
    sections: buildSections(buckets),
    grandTotal: totals.total,
  };
}
