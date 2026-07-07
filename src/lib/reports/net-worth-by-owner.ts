import prisma from '@/lib/prisma';
import { buildAccountValuationContext } from '@/lib/account-valuation';
import { resolveAccountOwners, AccountOwner } from '@/lib/ownership';
import { ReportType, ReportData, ReportFilters, ReportSection } from './types';
import { buildAccountPathMap } from './utils';

/**
 * Net Worth by Owner report.
 *
 * Groups balance-sheet accounts (assets + liabilities, no equity) by their
 * effective owner — an account's own owner preference, inherited from the
 * nearest ancestor when unset (see src/lib/ownership.ts). Joint accounts are
 * their own bucket; they are NOT split 50/50. Accounts with no owner anywhere
 * in their ancestry land in the Unassigned bucket.
 *
 * Account-type classification and sign conventions mirror
 * src/lib/reports/balance-sheet.ts: asset balances keep their natural sign,
 * liability balances are credit-normal (negative in GnuCash when owed) and
 * are negated for display so "amount owed" reads positive. A contra balance
 * (e.g. an overpaid credit card) correctly reduces the liability total.
 */

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE'] as const;
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'] as const;

export const OWNER_BUCKET_ORDER = ['self', 'spouse', 'joint', 'unassigned'] as const;
export type OwnerBucketKey = (typeof OWNER_BUCKET_ORDER)[number];

export const OWNER_BUCKET_LABELS: Record<OwnerBucketKey, string> = {
  self: 'Self',
  spouse: 'Spouse',
  joint: 'Joint',
  unassigned: 'Unassigned',
};

/**
 * Optional household member names used to resolve the self/spouse bucket
 * labels (e.g. 'Self' → 'Alice'). The `owner` bucket key is always the
 * stable 'self'|'spouse'|'joint'|'unassigned' value; only `label` changes.
 */
export interface OwnerBucketNames {
  self?: string | null;
  spouse?: string | null;
}

function resolveBucketLabel(owner: OwnerBucketKey, names?: OwnerBucketNames): string {
  if (owner === 'self' && names?.self) return names.self;
  if (owner === 'spouse' && names?.spouse) return names.spouse;
  return OWNER_BUCKET_LABELS[owner];
}

export interface OwnerAccountRow {
  guid: string;
  fullname: string;
  account_type: string;
  category: 'asset' | 'liability';
  /**
   * Balance in report currency. Assets keep their natural sign; liabilities
   * are negated so the amount owed is positive (contra balances go negative).
   */
  balance: number;
}

export interface OwnerBucket {
  owner: OwnerBucketKey;
  label: string;
  totalAssets: number;
  /** Positive = owed (credit-normal balances negated) */
  totalLiabilities: number;
  /** totalAssets - totalLiabilities */
  netWorth: number;
  accounts: OwnerAccountRow[];
}

export interface NetWorthByOwnerTotals {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

export interface NetWorthByOwnerData extends ReportData {
  type: ReportType;
  /** ISO date the balances are computed through (inclusive) */
  asOf: string;
  currency: string;
  buckets: OwnerBucket[];
  totals: NetWorthByOwnerTotals;
}

/** Input row for the pure bucketing core: raw signed report-currency balance. */
export interface OwnerBalanceInput {
  guid: string;
  fullname: string;
  account_type: string;
  /** Raw signed balance in report currency (liabilities negative when owed) */
  balance: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure bucketing core (exported for unit tests).
 *
 * Rows with a near-zero balance (placeholders, aggregation nodes) are
 * dropped; buckets with no remaining accounts are omitted entirely.
 */
export function bucketAccountsByOwner(
  rows: OwnerBalanceInput[],
  ownerMap: Map<string, AccountOwner>,
  ownerNames?: OwnerBucketNames,
): { buckets: OwnerBucket[]; totals: NetWorthByOwnerTotals } {
  const assetTypes = new Set<string>(ASSET_TYPES);
  const liabilityTypes = new Set<string>(LIABILITY_TYPES);

  const byOwner = new Map<OwnerBucketKey, OwnerAccountRow[]>();

  for (const row of rows) {
    const isAsset = assetTypes.has(row.account_type);
    const isLiability = liabilityTypes.has(row.account_type);
    if (!isAsset && !isLiability) continue; // not a balance-sheet account
    if (Math.abs(row.balance) < 0.005) continue; // placeholder / zero balance

    const owner: OwnerBucketKey = ownerMap.get(row.guid) ?? 'unassigned';
    const list = byOwner.get(owner) ?? [];
    list.push({
      guid: row.guid,
      fullname: row.fullname,
      account_type: row.account_type,
      category: isAsset ? 'asset' : 'liability',
      // Liabilities are credit-normal: negate so owed amounts read positive.
      balance: round2(isAsset ? row.balance : -row.balance),
    });
    byOwner.set(owner, list);
  }

  const buckets: OwnerBucket[] = [];
  const totals: NetWorthByOwnerTotals = { totalAssets: 0, totalLiabilities: 0, netWorth: 0 };

  for (const owner of OWNER_BUCKET_ORDER) {
    const accounts = byOwner.get(owner);
    if (!accounts || accounts.length === 0) continue;

    accounts.sort((a, b) =>
      a.category === b.category
        ? a.fullname.localeCompare(b.fullname)
        : a.category === 'asset' ? -1 : 1
    );

    const totalAssets = round2(
      accounts.filter(a => a.category === 'asset').reduce((sum, a) => sum + a.balance, 0)
    );
    const totalLiabilities = round2(
      accounts.filter(a => a.category === 'liability').reduce((sum, a) => sum + a.balance, 0)
    );
    const netWorth = round2(totalAssets - totalLiabilities);

    buckets.push({
      owner,
      label: resolveBucketLabel(owner, ownerNames),
      totalAssets,
      totalLiabilities,
      netWorth,
      accounts,
    });

    totals.totalAssets = round2(totals.totalAssets + totalAssets);
    totals.totalLiabilities = round2(totals.totalLiabilities + totalLiabilities);
  }
  totals.netWorth = round2(totals.totalAssets - totals.totalLiabilities);

  return { buckets, totals };
}

/**
 * Build ReportViewer/CSV-compatible sections: one section per owner bucket,
 * items signed by their contribution to net worth (liabilities negative) so
 * each section total equals the bucket's net worth.
 */
function buildSections(buckets: OwnerBucket[]): ReportSection[] {
  return buckets.map(bucket => ({
    title: bucket.label,
    items: bucket.accounts.map(account => ({
      guid: account.guid,
      name: account.category === 'liability' ? `${account.fullname} (liability)` : account.fullname,
      amount: account.category === 'liability' ? -account.balance : account.balance,
    })),
    total: bucket.netWorth,
  }));
}

/**
 * Generate the Net Worth by Owner report.
 * Balances are computed through `filters.endDate` (inclusive; defaults to today).
 * Pass `ownerNames` (resolved by the caller, e.g. from the book's entity
 * profile) to label the self/spouse buckets with household member names.
 */
export async function generateNetWorthByOwner(
  filters: ReportFilters,
  ownerNames?: OwnerBucketNames,
): Promise<NetWorthByOwnerData> {
  const asOf = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

  // Ownership inheritance needs the full account tree (ancestors may be
  // placeholders/hidden), so resolve owners over the whole book scope.
  const scopeGuids = filters.bookAccountGuids && filters.bookAccountGuids.length > 0
    ? filters.bookAccountGuids
    : (await prisma.accounts.findMany({ select: { guid: true } })).map(a => a.guid);

  const accounts = await prisma.accounts.findMany({
    where: {
      guid: { in: scopeGuids },
      account_type: { in: [...ASSET_TYPES, ...LIABILITY_TYPES] },
      hidden: 0,
    },
    select: {
      guid: true,
      name: true,
      account_type: true,
      commodity_guid: true,
      commodity: { select: { namespace: true } },
    },
  });

  const valuation = await buildAccountValuationContext(
    accounts.map(account => ({
      accountType: account.account_type,
      commodityGuid: account.commodity_guid,
      commodityNamespace: account.commodity?.namespace,
    })),
    asOf
  );

  // Batch balance aggregation (single query — no per-account round trips)
  const accountGuids = accounts.map(a => a.guid);
  const balanceRows = accountGuids.length > 0
    ? await prisma.$queryRaw<Array<{ account_guid: string; quantity: number }>>`
        SELECT s.account_guid,
               COALESCE(SUM(s.quantity_num::float8 / s.quantity_denom::float8), 0)::float8 AS quantity
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${accountGuids}::text[])
          AND t.post_date <= ${asOf}
        GROUP BY s.account_guid
      `
    : [];
  const quantityByGuid = new Map(balanceRows.map(r => [r.account_guid, r.quantity]));

  const [pathMap, ownerMap] = await Promise.all([
    buildAccountPathMap(scopeGuids),
    resolveAccountOwners(scopeGuids),
  ]);

  const rows: OwnerBalanceInput[] = accounts.map(account => {
    const quantity = quantityByGuid.get(account.guid) ?? 0;
    const multiplier = valuation.getMultiplier({
      accountType: account.account_type,
      commodityGuid: account.commodity_guid,
      commodityNamespace: account.commodity?.namespace,
    });
    return {
      guid: account.guid,
      fullname: pathMap.get(account.guid) || account.name,
      account_type: account.account_type,
      balance: quantity * multiplier,
    };
  });

  const { buckets, totals } = bucketAccountsByOwner(rows, ownerMap, ownerNames);

  return {
    type: ReportType.NET_WORTH_BY_OWNER,
    title: 'Net Worth by Owner',
    generatedAt: new Date().toISOString(),
    filters,
    asOf: asOf.toISOString().split('T')[0],
    currency: valuation.reportCurrencyMnemonic,
    buckets,
    totals,
    sections: buildSections(buckets),
    grandTotal: totals.netWorth,
  };
}
