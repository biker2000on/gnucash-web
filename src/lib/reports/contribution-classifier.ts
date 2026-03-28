import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';

export enum ContributionType {
  CONTRIBUTION = 'contribution',
  INCOME_CONTRIBUTION = 'income_contribution',
  EMPLOYER_MATCH = 'employer_match',
  TRANSFER = 'transfer',
  FEE = 'fee',
  WITHDRAWAL = 'withdrawal',
  DIVIDEND = 'dividend',
  OTHER = 'other',
}

interface SplitLike {
  guid: string;
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
  quantity_num: bigint;
  quantity_denom: bigint;
}

interface OtherSplitLike extends SplitLike {
  account?: {
    account_type?: string | null;
    commodity_guid?: string | null;
    name?: string | null;
  } | null;
}

const MATCH_KEYWORDS = ['match', 'employer'];
const DIVIDEND_KEYWORDS = ['dividend', 'distribution', 'interest'];

export function classifyContribution(
  split: SplitLike,
  otherSplits: OtherSplitLike[],
  retirementGuids: Set<string>,
): ContributionType {
  const value = toDecimalNumber(split.value_num, split.value_denom);
  const quantity = toDecimalNumber(split.quantity_num, split.quantity_denom);

  if (value === 0 && quantity === 0) return ContributionType.OTHER;
  if (value < 0) return ContributionType.WITHDRAWAL;

  // Check share transfer from another investment account
  const shareTransferSource = otherSplits.find(s => {
    const otherQty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    const acctType = s.account?.account_type;
    return otherQty < 0 && (acctType === 'STOCK' || acctType === 'MUTUAL');
  });
  if (shareTransferSource) return ContributionType.TRANSFER;

  // Find primary cash source (largest absolute value)
  const cashSources = otherSplits
    .filter(s => {
      const v = toDecimalNumber(s.value_num, s.value_denom);
      return v < 0;
    })
    .sort((a, b) => {
      const va = Math.abs(toDecimalNumber(a.value_num, a.value_denom));
      const vb = Math.abs(toDecimalNumber(b.value_num, b.value_denom));
      return vb - va;
    });

  if (cashSources.length === 0) return ContributionType.OTHER;

  const primarySource = cashSources[0];
  const sourceType = primarySource.account?.account_type ?? '';
  const sourceName = (primarySource.account?.name ?? '').toLowerCase();

  if (retirementGuids.has(primarySource.account_guid)) {
    return ContributionType.TRANSFER;
  }

  if (sourceType === 'INCOME') {
    if (MATCH_KEYWORDS.some(kw => sourceName.includes(kw))) {
      return ContributionType.EMPLOYER_MATCH;
    }
    if (DIVIDEND_KEYWORDS.some(kw => sourceName.includes(kw))) {
      return ContributionType.DIVIDEND;
    }
    return ContributionType.INCOME_CONTRIBUTION;
  }

  if (sourceType === 'EXPENSE') return ContributionType.FEE;

  if (['BANK', 'ASSET', 'CASH', 'RECEIVABLE'].includes(sourceType)) {
    return ContributionType.CONTRIBUTION;
  }

  if (['STOCK', 'MUTUAL'].includes(sourceType)) {
    return ContributionType.TRANSFER;
  }

  return ContributionType.OTHER;
}

export async function getRetirementAccountGuids(
  bookAccountGuids: string[],
): Promise<Set<string>> {
  if (bookAccountGuids.length === 0) return new Set();

  const flaggedPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: { is_retirement: true },
    select: { account_guid: true },
  });
  const flaggedGuids = new Set(flaggedPrefs.map(p => p.account_guid));

  if (flaggedGuids.size === 0) return new Set();

  const allAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });

  const childrenOf = new Map<string, string[]>();
  for (const acct of allAccounts) {
    if (acct.parent_guid) {
      const children = childrenOf.get(acct.parent_guid) ?? [];
      children.push(acct.guid);
      childrenOf.set(acct.parent_guid, children);
    }
  }

  const retirementGuids = new Set<string>();
  const queue = [...flaggedGuids];
  while (queue.length > 0) {
    const guid = queue.pop()!;
    if (!bookAccountGuids.includes(guid)) continue;
    retirementGuids.add(guid);
    const children = childrenOf.get(guid) ?? [];
    for (const child of children) {
      if (!retirementGuids.has(child)) {
        queue.push(child);
      }
    }
  }

  return retirementGuids;
}

export async function getRetirementAccountType(
  accountGuid: string,
  bookAccountGuids: string[],
): Promise<string | null> {
  const directPref = await prisma.gnucash_web_account_preferences.findFirst({
    where: { account_guid: accountGuid, is_retirement: true },
    select: { retirement_account_type: true },
  });
  if (directPref?.retirement_account_type) return directPref.retirement_account_type;

  const allAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });
  const parentOf = new Map(allAccounts.map(a => [a.guid, a.parent_guid]));

  let current = parentOf.get(accountGuid);
  while (current) {
    const pref = await prisma.gnucash_web_account_preferences.findFirst({
      where: { account_guid: current, is_retirement: true },
      select: { retirement_account_type: true },
    });
    if (pref?.retirement_account_type) return pref.retirement_account_type;
    current = parentOf.get(current) ?? null;
  }

  return null;
}

export async function resolveContributionTaxYear(
  splitGuid: string,
  postDate: Date,
): Promise<number> {
  const override = await prisma.gnucash_web_contribution_tax_year.findFirst({
    where: { split_guid: splitGuid },
  });

  if (override) return override.tax_year;
  return postDate.getFullYear();
}
