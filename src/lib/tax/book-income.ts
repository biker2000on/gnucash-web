/**
 * Book-data aggregation for the tax estimator.
 *
 * Sums splits in tax-mapped accounts for a tax year by category,
 * computes realized short/long-term capital gains via the per-sale
 * extraction shared with the Form 8949 report (loadRealizedSales in
 * @/lib/reports/capital-gains), and pulls retirement contribution
 * actuals from the contribution summary (respecting tax-year overrides).
 */

import prisma from '@/lib/prisma';
import { getRetirementAccountGuids } from '@/lib/reports/contribution-classifier';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { loadRealizedSales } from '@/lib/reports/capital-gains';
import { isLongTerm } from '@/lib/holding-period';
import type { BookTaxData, CategoryAggregate, TaxCategory } from './types';
import { isTaxCategory } from './types';

interface AccountInfo {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
}

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
  /**
   * Optional inclusive ISO date bound (YYYY-MM-DD) for the Form 2210
   * Schedule AI annualization periods: splits and realized sales after this
   * date are excluded. Must fall inside the tax year. Retirement
   * contributions stay full-tax-year figures (they are limit-bound annual
   * amounts; the annualized-installment engine treats them as evenly
   * accrued — the same Form 2210 default already applied to withholding).
   */
  throughDate?: string,
): Promise<BookTaxData> {
  const startDate = new Date(Date.UTC(taxYear, 0, 1));
  let endDate = new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59));
  if (throughDate) {
    const [ty, tm, td] = throughDate.slice(0, 10).split('-').map(Number);
    const bound = new Date(Date.UTC(ty, tm - 1, td, 23, 59, 59));
    if (bound >= startDate && bound < endDate) endDate = bound;
  }
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

  // Tax-sheltered asset accounts: retirement-flagged subtrees plus any
  // non-income/expense account the user mapped to 'exclude' (non-taxable
  // brokerage etc.). Income earned INSIDE these accounts is not taxable even
  // when it credits a mapped income account (e.g. IRA dividends flowing into a
  // shared Income:Dividends account).
  const retirementGuids = await getRetirementAccountGuids(bookAccountGuids);
  const excludedAssetGuids = accountRows
    .filter(a =>
      mappings.get(a.guid) === 'exclude' &&
      a.account_type !== 'INCOME' &&
      a.account_type !== 'EXPENSE',
    )
    .map(a => a.guid);
  const shelteredGuids = [...new Set([...retirementGuids, ...excludedAssetGuids])];

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
        -- Exclude capital-gains bookkeeping: lot-scrub posts a zero-quantity,
        -- non-zero-value offset split into the stock account (paired with a
        -- Short/Long-Term gains income split). No money enters the account, so
        -- these must not inflate contribution/income category totals. A real
        -- cash or share split always has a non-zero quantity, so this targets
        -- ONLY the value-only gains offsets. (Do NOT exclude by the
        -- gnucash_web_generated slot — the scrub engine also tags its resized
        -- buy/sell sub-splits, which carry real quantities and legitimate
        -- value flow.)
        AND NOT (s.quantity_num = 0 AND s.value_num <> 0)
        -- Sheltered-income guard: skip splits whose exact-opposite counter
        -- lands in a retirement or excluded asset account. A dividend paid
        -- inside a 401k/IRA posts income -X against IRA cash +X — not taxable
        -- regardless of which income account it credits. Exact-value matching
        -- keeps multi-leg paychecks safe (the salary credit never equals the
        -- 401k contribution leg).
        AND NOT EXISTS (
          SELECT 1 FROM splits s2
          WHERE s2.tx_guid = s.tx_guid
            AND s2.guid != s.guid
            AND s2.value_num = -s.value_num
            AND s2.value_denom = s.value_denom
            AND s2.account_guid = ANY(${shelteredGuids})
        )
        -- Mirror guard, asset side: a split INTO a sheltered account whose
        -- exact-opposite counter is an INCOME account is income earned inside
        -- the shelter (reinvested dividend / interest / employer match), not a
        -- contribution. Without this, IRA/401k accounts mapped to contribution
        -- categories count internal dividends as contributions in the raw
        -- category sums (the provenance table and the unflagged-book
        -- fallback). Real contributions are safe: their counter is a bank or
        -- salary *leg* that never exact-matches (multi-leg paycheck) or is a
        -- non-INCOME account (direct transfers from checking).
        AND NOT (
          s.account_guid = ANY(${shelteredGuids})
          AND EXISTS (
            SELECT 1 FROM splits s2
            JOIN accounts a2 ON a2.guid = s2.account_guid
            WHERE s2.tx_guid = s.tx_guid
              AND s2.guid != s.guid
              AND s2.value_num = -s.value_num
              AND s2.value_denom = s.value_denom
              AND a2.account_type = 'INCOME'
          )
        )
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

  /* --- Realized capital gains: per-sale extraction shared with Form 8949 --- */
  // The estimator and the 8949 report MUST agree on Schedule D numbers, so
  // both consume loadRealizedSales — one row per SELL SPLIT — which gives:
  //  - per-sale YEAR attribution (a lot sold across years splits its gain
  //    across those years instead of booking it all in the close year),
  //  - the realized portions of still-open (partially-sold) lots,
  //  - UTC calendar-year bucketing on each sale's post date,
  //  - carried acquisition dates + carried_basis for transferred lots, and
  //  - the SAME retirement/'exclude' filtering (loadRealizedSales applies
  //    getRetirementAccountGuids + the effective 'exclude' mappings itself).
  // Each sale's ST/LT term uses the shared IRS calendar-anniversary rule.

  // Excluded-account count for the UI: STOCK/MUTUAL accounts outside
  // retirement subtrees whose EFFECTIVE mapping (direct or inherited via
  // expandMappingsToDescendants) is 'exclude'.
  const investmentCandidates = accountRows.filter(
    a =>
      (a.account_type === 'STOCK' || a.account_type === 'MUTUAL') &&
      !retirementGuids.has(a.guid),
  );
  const excludedInvestmentAccountCount = investmentCandidates.filter(
    a => mappings.get(a.guid) === 'exclude',
  ).length;

  let shortTerm = 0;
  let longTerm = 0;
  const gainAccounts: BookTaxData['realizedGains']['accounts'] = [];

  const allSales = await loadRealizedSales(bookAccountGuids, taxYear);
  // Period bound: Schedule AI columns only count sales settled by the
  // period end (same inclusive day bound as the splits query above).
  const throughDay = throughDate?.slice(0, 10);
  const sales = throughDay
    ? allSales.filter(sale => sale.dateSold.slice(0, 10) <= throughDay)
    : allSales;
  const gainsByAccount = new Map<string, { st: number; lt: number }>();
  for (const sale of sales) {
    const gain = sale.proceeds - sale.costBasis;
    const slot = gainsByAccount.get(sale.accountGuid) ?? { st: 0, lt: 0 };
    if (isLongTerm(sale.dateAcquired, sale.dateSold)) slot.lt += gain;
    else slot.st += gain;
    gainsByAccount.set(sale.accountGuid, slot);
  }
  for (const [guid, sums] of gainsByAccount) {
    if (Math.abs(sums.st) < 0.005 && Math.abs(sums.lt) < 0.005) continue;
    const info = accountInfoMap.get(guid);
    gainAccounts.push({
      accountGuid: guid,
      accountName: info?.name ?? 'Unknown',
      accountPath: info?.fullname ?? 'Unknown',
      shortTerm: Math.round(sums.st * 100) / 100,
      longTerm: Math.round(sums.lt * 100) / 100,
    });
    shortTerm += sums.st;
    longTerm += sums.lt;
  }

  /* --- Retirement contributions from contribution summary (tax-year aware) --- */
  // NOTE: all retirement account types flow through here keyed by
  // retirement_account_type (401k, traditional_ira, sep_ira, simple_ira,
  // education_529, coverdell_esa, ...). Only 'brokerage' is skipped.
  // Education types (529/ESA) are included so the UI can display them, but
  // they must NOT feed AGI adjustments — that mapping decision happens in
  // the page's buildInputs, not here.
  const contributionsByType: Record<string, number> = {};
  const contributionsByTypeAndOwner: Record<string, { self: number; spouse: number }> = {};

  // Which retirement types are flagged in this book at all. When a type is
  // flagged, the classifier-based contribution summary is authoritative for
  // it and the raw category sum must NOT override it (the category sum counts
  // dividends/interest received inside a mapped retirement account as
  // contributions).
  let flaggedRetirementTypes: string[] = [];
  try {
    const prefRows = await prisma.gnucash_web_account_preferences.findMany({
      where: { account_guid: { in: bookAccountGuids }, is_retirement: true },
      select: { retirement_account_type: true },
    });
    flaggedRetirementTypes = [
      ...new Set(
        prefRows
          .map(r => r.retirement_account_type)
          .filter((t): t is string => !!t && t !== 'brokerage'),
      ),
    ];
  } catch {
    // model unavailable (mocked tests) — leave empty; callers fall back
  }

  try {
    const summary = await generateContributionSummary(
      {
        // widen the window so prior-year IRA contributions made Jan-Apr with
        // tax-year overrides are captured. The end date is INCLUSIVE (the
        // report parses it as end-of-day UTC), so April 30 — the IRA
        // contribution deadline day — is covered.
        startDate: `${taxYear - 1}-01-01`,
        endDate: `${taxYear + 1}-04-30`,
        bookAccountGuids,
      },
      'tax_year',
      birthday,
    );
    const period = summary.periods.find(p => p.year === taxYear);
    if (period) {
      // Employee contributions only (employer match doesn't count toward limits)
      const perAccount: Array<{ guid: string; type: string; employee: number }> = [];
      for (const acct of period.accounts) {
        if (!acct.retirementAccountType || acct.retirementAccountType === 'brokerage') continue;
        perAccount.push({
          guid: acct.accountGuid,
          type: acct.retirementAccountType,
          employee: acct.contributions + acct.incomeContributions,
        });
      }

      /* --- Per-owner attribution ('self' | 'spouse') --- */
      // The owner column on gnucash_web_account_preferences is added by a
      // separate migration; query it defensively and fall back to all-'self'
      // when the column (or $queryRaw itself, in mocked tests) is unavailable.
      let ownerMap = new Map<string, 'self' | 'spouse'>();
      if (perAccount.length > 0) {
        try {
          const guids = perAccount.map(a => a.guid);
          const ownerRows = await prisma.$queryRaw<Array<{
            account_guid: string;
            owner: string;
          }>>`
            -- Bucket to exactly 'self' | 'spouse'. 'joint' is valid on
            -- balance-sheet accounts but retirement accounts shouldn't carry
            -- it; if data has it anyway, fold it into 'self' rather than
            -- creating a third bucket.
            SELECT account_guid, CASE WHEN owner = 'spouse' THEN 'spouse' ELSE 'self' END AS owner
            FROM gnucash_web_account_preferences
            WHERE account_guid = ANY(${guids})
          `;
          ownerMap = new Map(
            ownerRows.map(r => [r.account_guid, r.owner === 'spouse' ? 'spouse' : 'self']),
          );
        } catch {
          // owner column doesn't exist yet — attribute everything to 'self'
        }
      }

      for (const { guid, type, employee } of perAccount) {
        contributionsByType[type] = (contributionsByType[type] ?? 0) + employee;
        const owner = ownerMap.get(guid) ?? 'self';
        const slot = contributionsByTypeAndOwner[type] ?? { self: 0, spouse: 0 };
        slot[owner] += employee;
        contributionsByTypeAndOwner[type] = slot;
      }
      for (const key of Object.keys(contributionsByType)) {
        contributionsByType[key] = Math.round(contributionsByType[key] * 100) / 100;
      }
      for (const slot of Object.values(contributionsByTypeAndOwner)) {
        slot.self = Math.round(slot.self * 100) / 100;
        slot.spouse = Math.round(slot.spouse * 100) / 100;
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
      excludedAccountCount: excludedInvestmentAccountCount,
    },
    contributionsByType,
    contributionsByTypeAndOwner,
    flaggedRetirementTypes,
    mappedAccountCount: directMappings.size,
  };
}
