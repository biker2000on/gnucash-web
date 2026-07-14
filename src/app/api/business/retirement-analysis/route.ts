import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import { getLinksForBusinessBook } from '@/lib/services/book-links.service';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { computeSeTax } from '@/lib/tax/federal';
import { soloEmployerCapacity } from '@/lib/tax/s-corp-analysis';
import { getContributionLimit } from '@/lib/reports/irs-limits';
import { isSupportedTaxYear, type BookTaxData, type TaxCategory } from '@/lib/tax/types';

/** Entity types the self-employed retirement planner applies to. */
const APPLICABLE_TYPES = new Set(['sole_prop', 'llc_single', 'llc_partnership', 's_corp']);

/**
 * IRC §415(c) overall annual-additions limit (employee deferral + employer
 * contributions combined). The age-50+ catch-up rides ON TOP of this cap —
 * it is not counted against §415(c).
 */
const OVERALL_415C_CAP: Record<number, number> = { 2024: 69_000, 2025: 70_000, 2026: 72_000 };

function categoryTotal(data: BookTaxData, category: TaxCategory): number {
  return data.categories.find(c => c.category === category)?.total ?? 0;
}

/**
 * GET /api/business/retirement-analysis
 *
 * Query params:
 *   year    Tax year (default: current). Must be 2024–2026.
 *   salary  S-corp W-2 salary for the 25% employer computation (default:
 *           pinned s_corp_analyzer salary, else 50% of annualized profit).
 *
 * Auth: readonly. Active book must be a pass-through business or S-corp.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (!isSupportedTaxYear(year)) {
      return NextResponse.json(
        { error: `Unsupported tax year ${year}. Supported years: 2024, 2025, 2026.` },
        { status: 400 },
      );
    }

    const entity = await getEntityProfile(bookGuid, user.id);
    if (!APPLICABLE_TYPES.has(entity.entityType)) {
      return NextResponse.json({ applicable: false, entityType: entity.entityType });
    }
    const isScorp = entity.entityType === 's_corp';

    /* --- Net profit from the business book ----------------------------- */
    const bookAccountGuids = await getBookAccountGuids();
    const bookData = await aggregateBookTaxData(bookAccountGuids, year, null);
    const ytdNetProfit =
      categoryTotal(bookData, 'self_employment_income') -
      categoryTotal(bookData, 'business_expense');
    const elapsed = bookData.elapsedYearFraction;
    const annualizedProfit =
      elapsed > 0 ? Math.round((ytdNetProfit / elapsed) * 100) / 100 : ytdNetProfit;

    /* --- Owner + ownership share --------------------------------------- */
    // Owner birthday: first business-book member with role 'owner' and a
    // birthday (falls back to 'self' for synthesized profiles), else null —
    // no catch-up is assumed without a birthday.
    const ownerMember =
      entity.members.find(m => m.role === 'owner' && m.birthday) ??
      entity.members.find(m => m.role === 'self' && m.birthday) ??
      null;
    const birthday = ownerMember?.birthday ?? null;

    const links = await getLinksForBusinessBook(bookGuid);
    const ownershipPercent = links[0]?.ownershipPercent ?? 100;
    const ownerProfit = Math.max(0, annualizedProfit) * (ownershipPercent / 100);

    /* --- S-corp salary (only used for the 25%-of-W-2 employer math) ----- */
    let salary: number | null = null;
    if (isScorp) {
      const raw = searchParams.get('salary');
      const parsed = raw === null || raw === '' ? NaN : parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        salary = parsed;
      } else {
        // Fall back to the pinned S-corp analyzer salary, then 50% of profit.
        const configs = await ToolConfigService.listByUser(user.id, bookGuid, 's_corp_analyzer');
        const pinned = configs[0]?.config as Record<string, unknown> | undefined;
        salary =
          typeof pinned?.salary === 'number' && Number.isFinite(pinned.salary) && pinned.salary >= 0
            ? pinned.salary
            : Math.round(0.5 * Math.max(0, annualizedProfit));
      }
      salary = Math.min(salary, Math.max(0, annualizedProfit));
    }

    /* --- Contribution buckets ------------------------------------------ */
    const deferralLimit = await getContributionLimit(year, '401k', birthday);
    const deferralBase = deferralLimit?.base ?? 0;
    // getContributionLimit already folds the catch-up into `total` when the
    // birthday makes the owner 50+ by year end.
    const catchUp = deferralLimit ? deferralLimit.total - deferralLimit.base : 0;
    const catchUpEligible = catchUp > 0;

    // Compensation available to support contributions: W-2 salary for the
    // S-corp; net earnings (profit − ½ SE tax) for pass-throughs. The
    // employee deferral cannot exceed compensation.
    const se = computeSeTax(ownerProfit, year);
    const compensation = isScorp ? (salary ?? 0) : Math.max(0, ownerProfit - se.halfDeduction);
    const employeeDeferral = Math.round(Math.min(deferralBase, compensation) * 100) / 100;

    const employerMax = isScorp
      ? soloEmployerCapacity(year, 's_corp', salary ?? 0)
      : soloEmployerCapacity(year, 'pass_through', ownerProfit);

    const overallCap = OVERALL_415C_CAP[year];
    // §415(c) cap applies to deferral + employer; the 50+ catch-up rides on
    // top of the cap (and annual additions also cannot exceed compensation).
    const combinedBeforeCatchUp = Math.min(
      employeeDeferral + employerMax,
      overallCap,
      Math.max(0, compensation),
    );
    const solo401kTotal = Math.round((combinedBeforeCatchUp + (catchUpEligible ? catchUp : 0)) * 100) / 100;

    // SEP-IRA: employer-only bucket, same 25%-of-W-2 / 20%-of-net-earnings
    // math, capped at §415(c). No employee deferral, no catch-up bucket.
    const sepTotal = Math.round(Math.min(employerMax, overallCap, Math.max(0, compensation)) * 100) / 100;

    /* --- Deadlines ------------------------------------------------------ */
    // Employee deferrals must be elected (and for S-corps, run through
    // payroll) by 12/31. Employer contributions can wait until the business
    // return's filing deadline, including extension.
    const filingDeadline = isScorp ? `${year + 1}-03-15` : `${year + 1}-04-15`;
    const extendedDeadline = isScorp ? `${year + 1}-09-15` : `${year + 1}-10-15`;

    return NextResponse.json({
      applicable: true,
      year,
      entityType: entity.entityType,
      ytdNetProfit: Math.round(ytdNetProfit * 100) / 100,
      annualizedProfit,
      elapsedYearFraction: elapsed,
      ownershipPercent,
      ownerProfit: Math.round(ownerProfit * 100) / 100,
      salary,
      compensation: Math.round(compensation * 100) / 100,
      birthday,
      catchUpEligible,
      overallCap,
      plans: [
        {
          type: 'solo_401k',
          label: 'Solo 401(k)',
          employeeDeferral,
          employeeDeferralLimit: deferralBase,
          employerMax,
          catchUp: catchUpEligible ? catchUp : 0,
          combinedCap: overallCap,
          total: solo401kTotal,
        },
        {
          type: 'sep_ira',
          label: 'SEP-IRA',
          employeeDeferral: 0,
          employeeDeferralLimit: 0,
          employerMax,
          catchUp: 0,
          combinedCap: overallCap,
          total: sepTotal,
        },
      ],
      deadlines: {
        employeeDeferral: `${year}-12-31`,
        employerContribution: filingDeadline,
        employerContributionExtended: extendedDeadline,
      },
      notes: [
        isScorp
          ? 'S-corp: employee deferrals must run through payroll by 12/31; employer contributions are 25% of W-2 salary and can be made until the 1120-S filing deadline (including extension).'
          : 'Pass-through: employer contributions are ~20% of net self-employment earnings (25% of compensation after the deduction loops back) and can be made until the personal filing deadline (including extension).',
        'The age-50+ catch-up rides on top of the §415(c) overall cap.',
        'Record actual contributions in the household book and track them in the Contribution Summary report.',
      ],
    });
  } catch (error) {
    console.error('Error generating retirement analysis:', error);
    return NextResponse.json({ error: 'Failed to generate retirement analysis' }, { status: 500 });
  }
}
