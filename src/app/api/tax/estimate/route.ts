import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getContributionLimit } from '@/lib/reports/irs-limits';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { getLinkedBusinessIncome, applyLinkedBusinessIncome } from '@/lib/tax/linked-business';
import { calculateAge } from '@/lib/reports/irs-limits';
import { getEntityProfile } from '@/lib/services/entity.service';
import { FILING_STATUSES, type FilingStatus } from '@/lib/tax/types';

/**
 * GET /api/tax/estimate?year=2026
 * Aggregates book data by tax category for the requested year, plus the
 * user's tax preferences and resolved IRS contribution limits, so the
 * client-side engine can compute the full estimate transparently.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const userId = roleResult.user.id;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();

    const [birthday, filingStatusPref, statePref, flatRatePref, spouseBirthday, coveredByEmployerPlanPref, spouseCoveredByEmployerPlanPref] = await Promise.all([
      getPreference<string | null>(userId, 'birthday', null),
      getPreference<string>(userId, 'tax_filing_status', 'single'),
      getPreference<string>(userId, 'tax_state', 'OTHER'),
      getPreference<number>(userId, 'tax_state_flat_rate', 0),
      getPreference<string | null>(userId, 'spouse_birthday', null),
      getPreference<boolean>(userId, 'tax_covered_by_employer_plan', true),
      getPreference<boolean>(userId, 'tax_spouse_covered_by_employer_plan', false),
    ]);

    // The entity profile is the canonical household/business description for
    // the active book (synthesized from preferences when not yet persisted).
    const bookGuid = await getActiveBookGuid();
    const entity = await getEntityProfile(bookGuid, userId);

    // Filing status, state, and flat rate are book-scoped (entity profile);
    // user preferences remain the fallback for profiles saved before these
    // fields existed, so pre-existing household setups keep their values.
    const filingStatusRaw = entity.filingStatus ?? filingStatusPref;
    const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(filingStatusRaw)
      ? (filingStatusRaw as FilingStatus)
      : 'single';
    const effectiveState = entity.taxState || statePref || 'OTHER';
    const effectiveFlatRate =
      entity.stateFlatRate ?? (typeof flatRatePref === 'number' ? flatRatePref : 0);
    const selfMember = entity.members.find(m => m.role === 'self') ?? null;
    const spouseMember = entity.members.find(m => m.role === 'spouse') ?? null;

    // Persisted household profiles override the raw preferences.
    const effectiveBirthday = (!entity.synthesized && selfMember?.birthday) || birthday;
    const effectiveSpouseBirthday = !entity.synthesized
      ? (spouseMember?.birthday ?? null)
      : (typeof spouseBirthday === 'string' ? spouseBirthday : null);
    const effectiveCovered = !entity.synthesized && selfMember
      ? selfMember.coveredByEmployerPlan
      : (typeof coveredByEmployerPlanPref === 'boolean' ? coveredByEmployerPlanPref : true);
    const effectiveSpouseCovered = !entity.synthesized && spouseMember
      ? spouseMember.coveredByEmployerPlan
      : (typeof spouseCoveredByEmployerPlanPref === 'boolean' ? spouseCoveredByEmployerPlanPref : false);

    const bookData = await aggregateBookTaxData(bookAccountGuids, year, effectiveBirthday);

    // Household books include their share of linked business books' profit
    // (Schedule C for pass-throughs, K-1 ordinary income for S-corps) — a
    // pass-through's profit is taxed on the owner's 1040 whether drawn or not.
    let linkedBusinesses: Awaited<ReturnType<typeof getLinkedBusinessIncome>> = [];
    if (entity.entityType === 'household') {
      try {
        linkedBusinesses = await getLinkedBusinessIncome(bookGuid, year);
        applyLinkedBusinessIncome(bookData, linkedBusinesses);
      } catch (err) {
        console.error('Linked-business income aggregation failed:', err);
      }
    }

    // Resolved IRS limits for scenario validation (catch-up by birthday).
    // Spouse IRA limits use the spouse's birthday so catch-up eligibility is per person.
    const [limit401k, limitIra, limitHsa, limitHsaFamily, limitSpouseIra] = await Promise.all([
      getContributionLimit(year, '401k', effectiveBirthday),
      getContributionLimit(year, 'traditional_ira', effectiveBirthday),
      getContributionLimit(year, 'hsa', effectiveBirthday),
      getContributionLimit(year, 'hsa_family', effectiveBirthday),
      getContributionLimit(year, 'traditional_ira', effectiveSpouseBirthday),
    ]);

    const yearEnd = new Date(`${year}-12-31`);
    const ageAtYearEnd = effectiveBirthday ? calculateAge(effectiveBirthday, yearEnd) : null;
    const spouseAgeAtYearEnd = effectiveSpouseBirthday ? calculateAge(effectiveSpouseBirthday, yearEnd) : null;

    // Qualifying children for the Child Tax Credit: dependents under 17 at
    // year end (requires a birthday to count).
    const dependentsUnder17 = entity.members.filter(m => {
      if (m.role !== 'dependent' || !m.birthday) return false;
      const age = calculateAge(m.birthday, yearEnd);
      return age !== null && age < 17;
    }).length;

    return NextResponse.json({
      bookData,
      linkedBusinesses,
      preferences: {
        filingStatus,
        state: effectiveState,
        stateFlatRate: effectiveFlatRate,
        birthday: effectiveBirthday,
        ageAtYearEnd,
        spouseBirthday: effectiveSpouseBirthday,
        spouseAgeAtYearEnd,
        coveredByEmployerPlan: effectiveCovered,
        spouseCoveredByEmployerPlan: effectiveSpouseCovered,
      },
      entity: {
        entityType: entity.entityType,
        entityName: entity.entityName,
        synthesized: entity.synthesized,
        memberCount: entity.members.length,
        dependentsUnder17,
        owners: entity.members
          .filter(m => m.role === 'owner')
          .map(m => ({ name: m.name, ownershipPercent: m.ownershipPercent })),
      },
      limits: {
        '401k': limit401k,
        ira: limitIra,
        hsa: limitHsa,
        hsaFamily: limitHsaFamily,
        spouseIra: limitSpouseIra,
      },
    });
  } catch (error) {
    console.error('Error generating tax estimate:', error);
    return NextResponse.json({ error: 'Failed to generate tax estimate' }, { status: 500 });
  }
}
