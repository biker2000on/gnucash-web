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
  memo?: string | null;
}

interface OtherSplitLike extends SplitLike {
  account?: {
    account_type?: string | null;
    commodity_guid?: string | null;
    name?: string | null;
    /** Full account path (from account_hierarchy), e.g. "Income:Employer:Match" */
    fullname?: string | null;
  } | null;
}

export interface ClassifyOptions {
  /**
   * Account GUIDs (already expanded to descendants) mapped to the
   * 'employer_match' tax category. Money arriving from these accounts is
   * ALWAYS classified EMPLOYER_MATCH — a durable user override for books
   * where the match comes from accounts named e.g. 'Salary' or 'non-taxable'.
   */
  employerMatchGuids?: Set<string>;
}

const MATCH_KEYWORDS = ['match', 'employer'];
const DIVIDEND_KEYWORDS = ['dividend', 'distribution', 'interest'];
const CAPITAL_GAINS_KEYWORDS = ['realized', 'capital gain', 'short term', 'long term', 'short-term', 'long-term'];

export function classifyContribution(
  split: SplitLike,
  otherSplits: OtherSplitLike[],
  retirementGuids: Set<string>,
  description?: string,
  options?: ClassifyOptions,
): ContributionType {
  const employerMatchGuids = options?.employerMatchGuids;
  const value = toDecimalNumber(split.value_num, split.value_denom);
  const quantity = toDecimalNumber(split.quantity_num, split.quantity_denom);

  if (value === 0 && quantity === 0) return ContributionType.OTHER;

  // Capital-gains bookkeeping: lot-scrub (ours or GnuCash desktop's) posts a
  // zero-quantity, non-zero-value offset split into the stock account, paired
  // with a Short/Long-Term gains INCOME split. No money enters or leaves the
  // plan — these must never count as contributions or withdrawals. The
  // signature is exact: cash/currency splits always have quantity === value,
  // so zero quantity with non-zero value only occurs on these entries.
  if (quantity === 0 && value !== 0) return ContributionType.OTHER;

  if (value < 0) {
    // Money leaving this account: if the primary destination is itself within
    // the retirement umbrella (e.g. an investment buy moving cash -> stock
    // inside a 401k, or a rollover to another retirement account), this is an
    // internal transfer, not a withdrawal.
    const destinations = otherSplits
      .filter(s => {
        const v = toDecimalNumber(s.value_num, s.value_denom);
        // TRADING splits are GnuCash bookkeeping entries, not real destinations
        return v > 0 && s.account?.account_type !== 'TRADING';
      })
      .sort((a, b) => {
        const va = Math.abs(toDecimalNumber(a.value_num, a.value_denom));
        const vb = Math.abs(toDecimalNumber(b.value_num, b.value_denom));
        return vb - va;
      });
    if (destinations.length > 0 && retirementGuids.has(destinations[0].account_guid)) {
      return ContributionType.TRANSFER;
    }
    // Money leaving to an EXPENSE account (recordkeeping/advisory fees) is a
    // fee, not a withdrawal — tracked separately and excluded from net.
    if (destinations.length > 0 && destinations[0].account?.account_type === 'EXPENSE') {
      return ContributionType.FEE;
    }
    return ContributionType.WITHDRAWAL;
  }

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
      // TRADING splits are GnuCash bookkeeping entries, not real sources
      return v < 0 && s.account?.account_type !== 'TRADING';
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

  // User override: accounts mapped to the 'employer_match' tax category are
  // always employer money, regardless of naming or account type.
  if (employerMatchGuids?.has(primarySource.account_guid)) {
    return ContributionType.EMPLOYER_MATCH;
  }

  if (retirementGuids.has(primarySource.account_guid)) {
    return ContributionType.TRANSFER;
  }

  if (sourceType === 'INCOME') {
    // Match keywords may appear in the account name, its full path
    // (e.g. "Income:Employer Benefits:401k"), or the split memos.
    const sourceFullname = (primarySource.account?.fullname ?? '').toLowerCase();
    const memos = `${split.memo ?? ''} ${primarySource.memo ?? ''}`.toLowerCase();
    if (MATCH_KEYWORDS.some(kw =>
      sourceName.includes(kw) || sourceFullname.includes(kw) || memos.includes(kw)
    )) {
      return ContributionType.EMPLOYER_MATCH;
    }
    const desc = (description ?? '').toLowerCase();
    if (DIVIDEND_KEYWORDS.some(kw => sourceName.includes(kw) || desc.includes(kw))) {
      return ContributionType.DIVIDEND;
    }
    // Realized capital-gains income (e.g. "Income:Investments:Long Term",
    // "Realized Gain — ..." transactions) is investment income, not a
    // contribution toward any limit.
    if (CAPITAL_GAINS_KEYWORDS.some(kw =>
      sourceName.includes(kw) || sourceFullname.includes(kw) || desc.includes(kw)
    )) {
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

  // Scope to book accounts only
  const flaggedPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: { is_retirement: true, account_guid: { in: bookAccountGuids } },
    select: { account_guid: true },
  });
  const flaggedGuids = new Set(flaggedPrefs.map(p => p.account_guid));

  if (flaggedGuids.size === 0) return new Set();

  const allAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });

  const childrenOf = new Map<string, string[]>();
  const bookGuidsSet = new Set(bookAccountGuids);
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
    if (!bookGuidsSet.has(guid)) continue;
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
  // post_dates are stored in UTC (05:59-10:59Z) — bucket by UTC year so
  // Jan 1 transactions don't fall into the prior year in western timezones.
  return postDate.getUTCFullYear();
}
