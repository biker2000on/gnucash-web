import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import prisma from '@/lib/prisma';
import { expandMappingsToDescendants } from '@/lib/tax/book-income';
import type { TaxCategory } from '@/lib/tax/types';
import { isTaxCategory } from '@/lib/tax/types';
import {
  estimateSocialSecurityBenefit,
  type EarningsRecord,
} from '@/lib/fire/social-security';

/**
 * GET /api/fire/social-security?claimingAge=67
 *
 * Estimates the user's Social Security retirement benefit from their actual
 * earnings history in the book. Annual covered earnings come from accounts
 * mapped to w2_wages / self_employment_income in gnucash_web_tax_mappings;
 * when no such mappings exist, falls back to INCOME accounts whose name or
 * path looks like salary/wages/paycheck/payroll. The earnings array is
 * returned so the client can recompute per claiming age with the pure engine.
 */

const EARNINGS_CATEGORIES: ReadonlySet<TaxCategory> = new Set([
  'w2_wages',
  'self_employment_income',
]);

const FALLBACK_NAME_PATTERN = /salary|wages|paycheck|payroll/i;

interface AccountInfo {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const userId = roleResult.user.id;

    const { searchParams } = new URL(request.url);
    const claimingAgeParam = parseInt(searchParams.get('claimingAge') ?? '', 10);
    const claimingAge = Number.isFinite(claimingAgeParam)
      ? Math.min(70, Math.max(62, claimingAgeParam))
      : 67;

    const [bookAccountGuids, birthday] = await Promise.all([
      getBookAccountGuids(),
      getPreference<string | null>(userId, 'birthday', null),
    ]);

    const accountRows = await prisma.$queryRaw<AccountInfo[]>`
      SELECT guid, name, fullname, account_type, parent_guid
      FROM account_hierarchy
      WHERE guid = ANY(${bookAccountGuids})
    `;
    const accountInfoMap = new Map(accountRows.map(a => [a.guid, a]));

    /* --- Resolve earnings accounts: tax mappings first, heuristic fallback --- */
    const mappingRows = await prisma.gnucash_web_tax_mappings.findMany({
      where: { account_guid: { in: bookAccountGuids } },
    });
    const directMappings = new Map<string, TaxCategory>();
    for (const row of mappingRows) {
      if (isTaxCategory(row.tax_category)) {
        directMappings.set(row.account_guid, row.tax_category);
      }
    }
    const expanded = expandMappingsToDescendants(directMappings, accountRows);

    let earningsGuids = [...expanded.entries()]
      .filter(([, category]) => EARNINGS_CATEGORIES.has(category))
      .map(([guid]) => guid);
    let source: 'mappings' | 'heuristic' = 'mappings';

    if (earningsGuids.length === 0) {
      earningsGuids = accountRows
        .filter(
          a =>
            a.account_type === 'INCOME' &&
            (FALLBACK_NAME_PATTERN.test(a.name) || FALLBACK_NAME_PATTERN.test(a.fullname)),
        )
        .map(a => a.guid);
      source = 'heuristic';
    }

    /* --- Sum splits per calendar year across earnings accounts --- */
    const earningsByYear = new Map<number, number>();
    if (earningsGuids.length > 0) {
      const yearSums = await prisma.$queryRaw<Array<{
        account_guid: string;
        year: number;
        total: number | null;
      }>>`
        SELECT s.account_guid,
               EXTRACT(YEAR FROM t.post_date)::int AS year,
               (SUM(s.value_num::numeric / s.value_denom))::float8 AS total
        FROM splits s
        JOIN transactions t ON s.tx_guid = t.guid
        WHERE s.account_guid = ANY(${earningsGuids})
        GROUP BY s.account_guid, year
      `;
      for (const row of yearSums) {
        if (row.total === null || !Number.isFinite(row.year)) continue;
        const info = accountInfoMap.get(row.account_guid);
        // INCOME accounts carry credits (negative) for money earned — negate.
        const amount = info?.account_type === 'INCOME' ? -row.total : row.total;
        earningsByYear.set(row.year, (earningsByYear.get(row.year) ?? 0) + amount);
      }
    }

    const earningsYears: EarningsRecord[] = [...earningsByYear.entries()]
      .map(([year, earnings]) => ({ year, earnings: Math.round(earnings * 100) / 100 }))
      .filter(r => r.earnings > 0)
      .sort((a, b) => a.year - b.year);

    const birthYear = birthday ? parseInt(birthday.slice(0, 4), 10) : null;
    const available =
      birthYear !== null && Number.isFinite(birthYear) && earningsYears.length > 0;

    if (!available) {
      return NextResponse.json({
        available: false,
        reason: !birthYear ? 'no_birthday' : 'no_earnings',
        source: earningsGuids.length > 0 ? source : null,
        birthYear,
        earningsYears,
        yearsWithEarnings: earningsYears.length,
      });
    }

    const estimate = estimateSocialSecurityBenefit({
      earnings: earningsYears,
      birthYear: birthYear!,
      claimingAge,
      projectFutureEarnings: true,
    });

    const lastYear = earningsYears[earningsYears.length - 1];

    return NextResponse.json({
      available: true,
      source,
      birthYear,
      claimingAge,
      earningsYears,
      yearsWithEarnings: earningsYears.length,
      assumedFutureEarnings:
        estimate.diagnostics.projectedYears > 0 ? lastYear.earnings : null,
      estimatedMonthlyBenefit: estimate.monthlyBenefit,
      estimatedAnnualBenefit: estimate.annualBenefit,
      diagnostics: estimate.diagnostics,
    });
  } catch (error) {
    console.error('Error estimating Social Security benefit:', error);
    return NextResponse.json(
      { error: 'Failed to estimate Social Security benefit' },
      { status: 500 },
    );
  }
}
