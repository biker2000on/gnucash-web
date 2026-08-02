import { getYearStatusParams } from '@/lib/tax/federal';
import { isSupportedTaxYear, type FilingStatus, type TaxYear } from '@/lib/tax/types';
import type { Donation, GivingProfile } from './types';

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Written acknowledgment letter required for any single donation at or above this amount. */
export const ACKNOWLEDGMENT_THRESHOLD = 250;
/** Form 8283 required when total noncash donations for a tax year exceed this amount. */
export const FORM_8283_THRESHOLD = 500;
/** Qualified appraisal required for any single noncash donation above this amount. */
export const QUALIFIED_APPRAISAL_THRESHOLD = 5_000;
/**
 * Per-person annual QCD limit. 2025 figure (Notice 2024-80, indexed under
 * SECURE 2.0); the repo has no QCD limits module, so this is a local constant.
 */
export const QCD_ANNUAL_LIMIT_PER_PERSON = 108_000;
/** QCDs are allowed starting at age 70½. */
export const QCD_ELIGIBLE_AGE = 70.5;
/** The bunching comparison looks at this many years of planned giving. */
export const BUNCHING_WINDOW_YEARS = 2;

export interface GivingContext {
  /** Current-year charity-purpose miles from the mileage log. */
  charityMiles: number;
  /** Deduction value of those miles at the IRS charity rate. */
  charityMileageDeduction: number;
}

export function donationTaxYear(donation: Donation): number {
  return Number(donation.date.slice(0, 4));
}

function toTaxYear(year: number): TaxYear {
  return isSupportedTaxYear(year) ? year : year < 2024 ? 2024 : 2026;
}

function toFilingStatus(status: GivingProfile['settings']['filingStatus']): FilingStatus {
  return status === 'married_joint' ? 'mfj' : 'single';
}

/**
 * With only a birth year on file, eligibility is granted once age 70½ is
 * certain by year end (i.e. the person turns 71 or older during the year).
 */
function qcdEligible(birthYear: number | null | undefined, currentYear: number): boolean {
  return birthYear != null && currentYear - birthYear >= Math.ceil(QCD_ELIGIBLE_AGE);
}

export function calculateGivingPlan(
  profile: GivingProfile,
  context: GivingContext,
  asOf = new Date(),
) {
  const { settings } = profile;
  const currentYear = asOf.getUTCFullYear();
  const years = [...new Set(profile.donations.map(donationTaxYear))].sort();
  const yearTotals = years.map(taxYear => {
    const rows = profile.donations.filter(donation => donationTaxYear(donation) === taxYear);
    const sumKind = (kind: Donation['kind']) => round2(rows
      .filter(donation => donation.kind === kind)
      .reduce((sum, donation) => sum + donation.amount, 0));
    const cashTotal = sumKind('cash');
    const noncashTotal = sumKind('noncash');
    const qcdTotal = sumKind('qcd');
    return {
      taxYear,
      cashTotal,
      noncashTotal,
      qcdTotal,
      total: round2(cashTotal + noncashTotal + qcdTotal),
      form8283Required: noncashTotal > FORM_8283_THRESHOLD,
    };
  });
  const donations = profile.donations.map(donation => {
    const taxYear = donationTaxYear(donation);
    const yearRow = yearTotals.find(row => row.taxYear === taxYear);
    return {
      ...donation,
      taxYear,
      needsAcknowledgment: donation.kind !== 'qcd'
        && donation.amount >= ACKNOWLEDGMENT_THRESHOLD
        && !donation.acknowledged,
      needsForm8283: donation.kind === 'noncash' && Boolean(yearRow?.form8283Required),
      needsAppraisal: donation.kind === 'noncash' && donation.amount > QUALIFIED_APPRAISAL_THRESHOLD,
    };
  });
  const currentYearRow = yearTotals.find(row => row.taxYear === currentYear);
  const currentYearTotal = currentYearRow?.total ?? 0;
  const charityMileageDeduction = round2(context.charityMileageDeduction);
  // QCDs are excluded from income rather than itemized, so they are not part
  // of the itemizable charitable deduction.
  const currentYearDeductibleGiving = round2(
    (currentYearRow?.cashTotal ?? 0) + (currentYearRow?.noncashTotal ?? 0) + charityMileageDeduction,
  );
  const substantiationIssueCount = donations
    .filter(donation => donation.needsAcknowledgment || donation.needsAppraisal)
    .length;

  const selfEligible = qcdEligible(settings.birthYear, currentYear);
  const spouseEligible = settings.filingStatus === 'married_joint'
    && qcdEligible(settings.spouseBirthYear, currentYear);
  const qcdThisYear = currentYearRow?.qcdTotal ?? 0;
  const eligiblePeople = Number(selfEligible) + Number(spouseEligible);
  const qcd = {
    eligible: selfEligible || spouseEligible,
    selfEligible,
    spouseEligible,
    annualLimitPerPerson: QCD_ANNUAL_LIMIT_PER_PERSON,
    householdAnnualLimit: round2(QCD_ANNUAL_LIMIT_PER_PERSON * eligiblePeople),
    qcdThisYear,
    remainingCapacity: round2(Math.max(0, QCD_ANNUAL_LIMIT_PER_PERSON * eligiblePeople - qcdThisYear)),
  };

  const taxYear = toTaxYear(currentYear);
  const standardDeduction = settings.standardDeductionOverride
    ?? getYearStatusParams(taxYear, toFilingStatus(settings.filingStatus)).standardDeduction;
  const giving = settings.plannedAnnualGiving;
  const other = settings.otherItemizedAnnual;
  const evenYearDeduction = Math.max(standardDeduction, other + giving);
  const bunchYear1Deduction = Math.max(standardDeduction, other + giving * BUNCHING_WINDOW_YEARS);
  const bunchYear2Deduction = Math.max(standardDeduction, other);
  const evenTotal = round2(evenYearDeduction * BUNCHING_WINDOW_YEARS);
  const bunchTotal = round2(bunchYear1Deduction + bunchYear2Deduction);
  const incrementalDeduction = round2(bunchTotal - evenTotal);
  const combinedRatePct = settings.marginalRatePct + (settings.stateRatePct ?? 0);
  const estimatedTaxSavings = round2(Math.max(0, incrementalDeduction) * combinedRatePct / 100);
  const bunching = {
    taxYear,
    standardDeduction: round2(standardDeduction),
    plannedAnnualGiving: round2(giving),
    otherItemizedAnnual: round2(other),
    even: {
      year1Deduction: round2(evenYearDeduction),
      year2Deduction: round2(evenYearDeduction),
      totalDeductions: evenTotal,
    },
    bunch: {
      year1Deduction: round2(bunchYear1Deduction),
      year2Deduction: round2(bunchYear2Deduction),
      totalDeductions: bunchTotal,
    },
    incrementalDeduction,
    combinedRatePct: round2(combinedRatePct),
    estimatedTaxSavings,
    recommendBunching: estimatedTaxSavings >= 250,
    formula: 'savings = (max(std, other + 2×giving) + max(std, other) - 2×max(std, other + giving)) × (marginal% + state%)',
  };

  return {
    settings,
    donations,
    yearTotals,
    currentYear,
    currentYearTotal,
    charityMiles: round2(context.charityMiles),
    charityMileageDeduction,
    currentYearDeductibleGiving,
    remainingPlannedGiving: round2(Math.max(0, giving - currentYearTotal)),
    substantiationIssueCount,
    qcd,
    bunching,
  };
}
