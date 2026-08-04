import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getContributionLimit, calculateAge } from '@/lib/reports/irs-limits';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { getLinkedBusinessIncome, applyLinkedBusinessIncome } from '@/lib/tax/linked-business';
import { getEntityProfile } from '@/lib/services/entity.service';
import { FILING_STATUSES, isSupportedTaxYear, type FilingStatus } from '@/lib/tax/types';
import type { AccountOwner } from '@/lib/tax/filing-comparison';

/**
 * GET /api/tax/filing-comparison?year=2026
 *
 * Data loading ONLY for the MFJ vs MFS filing-comparison tool. Returns the
 * household's aggregated book data (with linked-business income folded in),
 * the per-account owner map from `gnucash_web_account_preferences.owner`,
 * and the per-spouse household context (65+, employer-plan coverage, IRA
 * limits). The pure comparison engine
 * (src/lib/tax/filing-comparison.ts) runs client-side, mirroring the tax
 * estimator page. Allocation persistence uses the generic
 * /api/tools/config endpoints (toolType 'filing-comparison').
 *
 * The comparison is only meaningful when the household files jointly today
 * (mfj/qss) — other statuses return { applicable: false }.
 *
 * Auth: readonly.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const userId = roleResult.user.id;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (!isSupportedTaxYear(year)) {
      return NextResponse.json(
        { error: `Unsupported tax year ${year}. Supported years: 2024, 2025, 2026.` },
        { status: 400 },
      );
    }

    const bookGuid = await getActiveBookGuid();
    const entity = await getEntityProfile(bookGuid, userId);
    const [birthdayPref, filingStatusPref, spouseBirthdayPref, coveredPref, spouseCoveredPref] =
      await Promise.all([
        getPreference<string | null>(userId, 'birthday', null),
        getPreference<string>(userId, 'tax_filing_status', 'single'),
        getPreference<string | null>(userId, 'spouse_birthday', null),
        getPreference<boolean>(userId, 'tax_covered_by_employer_plan', true),
        getPreference<boolean>(userId, 'tax_spouse_covered_by_employer_plan', false),
      ]);

    const filingStatusRaw = entity.filingStatus ?? filingStatusPref;
    const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(filingStatusRaw)
      ? (filingStatusRaw as FilingStatus)
      : 'single';

    if (entity.entityType !== 'household' || (filingStatus !== 'mfj' && filingStatus !== 'qss')) {
      return NextResponse.json({
        applicable: false,
        entityType: entity.entityType,
        filingStatus,
      });
    }

    const selfMember = entity.members.find(m => m.role === 'self') ?? null;
    const spouseMember = entity.members.find(m => m.role === 'spouse') ?? null;
    const birthday = (!entity.synthesized && selfMember?.birthday) || birthdayPref;
    const spouseBirthday = !entity.synthesized
      ? (spouseMember?.birthday ?? null)
      : (typeof spouseBirthdayPref === 'string' ? spouseBirthdayPref : null);
    const coveredByEmployerPlan = !entity.synthesized && selfMember
      ? selfMember.coveredByEmployerPlan
      : (typeof coveredPref === 'boolean' ? coveredPref : true);
    const spouseCoveredByEmployerPlan = !entity.synthesized && spouseMember
      ? spouseMember.coveredByEmployerPlan
      : (typeof spouseCoveredPref === 'boolean' ? spouseCoveredPref : false);

    const yearEnd = new Date(`${year}-12-31`);
    const ageAtYearEnd = birthday ? calculateAge(birthday, yearEnd) : null;
    const spouseAgeAtYearEnd = spouseBirthday ? calculateAge(spouseBirthday, yearEnd) : null;
    const dependentsUnder17 = entity.members.filter(m => {
      if (m.role !== 'dependent' || !m.birthday) return false;
      const age = calculateAge(m.birthday, yearEnd);
      return age !== null && age < 17;
    }).length;

    /* --- Book data + linked business income (same as /api/tax/estimate) --- */
    const bookAccountGuids = await getBookAccountGuids();
    const bookData = await aggregateBookTaxData(bookAccountGuids, year, birthday);
    try {
      const linked = await getLinkedBusinessIncome(bookGuid, year);
      applyLinkedBusinessIncome(bookData, linked);
    } catch (err) {
      console.error('Filing comparison: linked-business aggregation failed:', err);
    }

    /* --- Per-account owner map ('self' | 'spouse' | 'joint') --- */
    // The owner column is added by a separate migration; query defensively
    // and fall back to an empty map (everything unattributed) when missing.
    let ownerByAccount: Record<string, AccountOwner> = {};
    try {
      const rows = await prisma.$queryRaw<Array<{ account_guid: string; owner: string | null }>>`
        SELECT account_guid, owner
        FROM gnucash_web_account_preferences
        WHERE account_guid = ANY(${bookAccountGuids})
          AND owner IS NOT NULL
      `;
      ownerByAccount = Object.fromEntries(
        rows
          .filter(r => r.owner === 'self' || r.owner === 'spouse' || r.owner === 'joint')
          .map(r => [r.account_guid, r.owner as AccountOwner]),
      );
    } catch {
      // owner column not present yet — allocation UI handles the residual
    }

    /* --- Per-spouse IRA limits (catch-up by each spouse's birthday) --- */
    const [selfIraLimit, spouseIraLimit] = await Promise.all([
      getContributionLimit(year, 'traditional_ira', birthday),
      getContributionLimit(year, 'traditional_ira', spouseBirthday),
    ]);

    return NextResponse.json({
      applicable: true,
      year,
      filingStatus,
      bookData,
      ownerByAccount,
      household: {
        selfName: selfMember?.name ?? null,
        spouseName: spouseMember?.name ?? null,
        dependentsUnder17,
        self: {
          age65: ageAtYearEnd !== null && ageAtYearEnd >= 65,
          coveredByEmployerPlan,
          iraLimit: selfIraLimit?.total ?? null,
        },
        spouse: {
          age65: spouseAgeAtYearEnd !== null && spouseAgeAtYearEnd >= 65,
          coveredByEmployerPlan: spouseCoveredByEmployerPlan,
          iraLimit: spouseIraLimit?.total ?? null,
        },
      },
    });
  } catch (error) {
    console.error('Error loading filing comparison data:', error);
    return NextResponse.json({ error: 'Failed to load filing comparison data' }, { status: 500 });
  }
}
