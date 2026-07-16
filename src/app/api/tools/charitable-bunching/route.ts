import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getEntityProfile } from '@/lib/services/entity.service';
import { calculateAge } from '@/lib/reports/irs-limits';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { generateCharitableGiving } from '@/lib/reports/charitable-giving';
import { computeFederalTax, emptyFederalInputs } from '@/lib/tax/federal';
import { resolveContributionActuals } from '@/lib/tax/payments';
import { compareBunching } from '@/lib/tax/bunching';
import {
  FILING_STATUSES,
  isSupportedTaxYear,
  type BookTaxData,
  type FederalTaxInputs,
  type FilingStatus,
  type TaxCategory,
  type TaxYear,
} from '@/lib/tax/types';

function categoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

/** Annualizable categories — mirrors /api/tax/estimated. */
const ANNUALIZABLE: TaxCategory[] = [
  'w2_wages', 'federal_withholding', 'state_withholding', 'estimated_tax_payment',
  'state_estimated_tax_payment', 'fica_social_security',
  'fica_medicare', 'interest_income', 'tax_exempt_interest', 'ordinary_dividends',
  'qualified_dividends',
  'self_employment_income', 'business_expense', 'rental_income', 'retirement_income',
  'social_security_benefits', 'charitable_donation', 'mortgage_interest',
  'property_tax', 'state_local_tax_paid', 'medical_expense', 'education_expense',
  'other_income', 'other_deduction',
];

/** Projected full-year federal inputs from YTD book data (always annualized). */
function buildFederalInputs(
  bookData: BookTaxData,
  year: TaxYear,
  filingStatus: FilingStatus,
  filersAge65Plus: number,
): FederalTaxInputs {
  const factor = bookData.elapsedYearFraction < 1 ? 1 / bookData.elapsedYearFraction : 1;
  const get = (c: TaxCategory) =>
    categoryTotal(bookData, c) * (ANNUALIZABLE.includes(c) ? factor : 1);

  const qualifiedDividends = get('qualified_dividends');
  const { trad401k, tradIra, hsa, sepIra, simpleIra } = resolveContributionActuals(bookData);

  return {
    ...emptyFederalInputs(year, filingStatus),
    wages: get('w2_wages'),
    interest: get('interest_income'),
    taxExemptInterest: get('tax_exempt_interest'),
    ordinaryDividends: get('ordinary_dividends') + qualifiedDividends,
    qualifiedDividends,
    shortTermCapitalGains: bookData.realizedGains.shortTerm,
    longTermCapitalGains: bookData.realizedGains.longTerm,
    selfEmploymentIncome: get('self_employment_income') - get('business_expense'),
    rentalIncome: get('rental_income'),
    retirementIncome: get('retirement_income'),
    socialSecurityBenefits: get('social_security_benefits'),
    otherIncome: get('other_income'),
    traditional401kContributions: trad401k,
    traditionalIraContributions: tradIra,
    hsaContributions: hsa,
    sepIraContributions: sepIra,
    simpleIraContributions: simpleIra,
    charitableDonations: get('charitable_donation'),
    mortgageInterest: get('mortgage_interest'),
    stateLocalTaxesPaid: get('state_withholding') + get('state_estimated_tax_payment')
      + get('property_tax') + get('state_local_tax_paid'),
    medicalExpenses: get('medical_expense'),
    otherDeductions: get('other_deduction'),
    filersAge65Plus,
  };
}

/**
 * GET /api/tools/charitable-bunching?year=2026&giving=12000&bunchYears=3
 *
 * Book-derived inputs plus a bunching comparison: current-year charitable
 * giving (keyword report), other itemizables (capped SALT + mortgage interest
 * from tax mappings), the standard deduction, and the marginal rate from the
 * book's projected income. `giving` overrides the detected annual giving.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year: TaxYear = isSupportedTaxYear(yearParam)
      ? yearParam
      : isSupportedTaxYear(new Date().getFullYear())
        ? (new Date().getFullYear() as TaxYear)
        : 2026;

    const bunchYearsParam = parseInt(searchParams.get('bunchYears') ?? '', 10);
    const bunchYears = bunchYearsParam === 2 || bunchYearsParam === 3 ? bunchYearsParam : 2;
    const givingParam = parseFloat(searchParams.get('giving') ?? '');
    const givingOverride =
      Number.isFinite(givingParam) && givingParam >= 0 ? givingParam : null;

    const entity = await getEntityProfile(bookGuid, user.id);

    /* --- Filing status / ages (mirrors /api/tax/estimated) ------------- */
    const [filingStatusPref, birthdayPref] = await Promise.all([
      getPreference<string>(user.id, 'tax_filing_status', 'single'),
      getPreference<string | null>(user.id, 'birthday', null),
    ]);
    const filingStatusRaw = entity.filingStatus ?? filingStatusPref;
    const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(filingStatusRaw)
      ? (filingStatusRaw as FilingStatus)
      : 'single';

    const selfMember = entity.members.find(m => m.role === 'self') ?? null;
    const spouseMember = entity.members.find(m => m.role === 'spouse') ?? null;
    const birthday = (!entity.synthesized && selfMember?.birthday) || birthdayPref;

    const yearEnd = new Date(`${year}-12-31`);
    const countsSpouse = filingStatus === 'mfj' || filingStatus === 'qss';
    const ages = [
      birthday ? calculateAge(birthday, yearEnd) : null,
      countsSpouse && spouseMember?.birthday ? calculateAge(spouseMember.birthday, yearEnd) : null,
    ];
    const filersAge65Plus = ages.filter(a => a !== null && a >= 65).length;

    /* --- Book data → projected federal picture ------------------------- */
    const bookAccountGuids = await getBookAccountGuids();
    const [bookData, givingReport] = await Promise.all([
      aggregateBookTaxData(bookAccountGuids, year, birthday),
      generateCharitableGiving(bookAccountGuids, year),
    ]);

    const inputs = buildFederalInputs(bookData, year, filingStatus, filersAge65Plus);
    const federal = computeFederalTax(inputs);

    // Detected giving: prefer the keyword-based charitable report; fall back
    // to the mapped charitable_donation category. Annualize partial years so
    // "your typical annual giving" isn't understated mid-year.
    const factor = bookData.elapsedYearFraction < 1 ? 1 / bookData.elapsedYearFraction : 1;
    const reportGiving = givingReport.grandTotal;
    const mappedGiving = categoryTotal(bookData, 'charitable_donation') * factor;
    const detectedGiving = Math.round(Math.max(reportGiving * factor, mappedGiving) * 100) / 100;
    const annualGiving = givingOverride ?? detectedGiving;

    // Other itemizables from the engine's own Schedule A math (SALT already
    // capped, including the OBBBA phase-down at this AGI).
    const saltAllowed = federal.itemizedBreakdown.saltAllowed;
    const mortgageInterest = federal.itemizedBreakdown.mortgageInterest;
    const otherItemizable = Math.round((saltAllowed + mortgageInterest) * 100) / 100;

    const comparison = compareBunching({
      annualGiving,
      bunchYears,
      otherItemizable,
      standardDeduction: federal.standardDeduction,
      marginalRate: federal.marginalRate,
    });

    return NextResponse.json({
      applicable: entity.entityType === 'household',
      entityType: entity.entityType,
      year,
      filingStatus,
      giving: {
        detected: detectedGiving,
        reportYtd: reportGiving,
        used: annualGiving,
        largeDonationCount: givingReport.largeDonationCount,
      },
      otherItemizables: {
        saltAllowed,
        saltCap: federal.itemizedBreakdown.saltCap,
        mortgageInterest,
        total: otherItemizable,
      },
      standardDeduction: federal.standardDeduction,
      marginalRate: federal.marginalRate,
      projectedAgi: federal.agi,
      elapsedYearFraction: bookData.elapsedYearFraction,
      comparison,
    });
  } catch (error) {
    console.error('Charitable bunching error:', error);
    return NextResponse.json({ error: 'Failed to compute bunching comparison' }, { status: 500 });
  }
}
