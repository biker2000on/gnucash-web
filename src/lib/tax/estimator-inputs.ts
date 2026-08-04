/**
 * Shared federal-input assembly for the tax estimator page and the
 * withholding checkup — pure, client-safe.
 *
 * Both surfaces project the same 1040, so they MUST assemble engine inputs
 * identically (see the contribution-summing-paths rule). This module owns:
 *
 *  1. `buildFederalInputsFromBookData` — mapped book categories → raw
 *     FederalTaxInputs (optionally annualized by a factor).
 *  2. `applyHouseholdTaxDetails` — the household layer the estimator page
 *     applies on top: the Child Tax Credit count (dependents under 17) and
 *     the §219(g) traditional-IRA deduction phase-out cap (per-spouse, using
 *     a MAGI pass computed WITHOUT the IRA deduction).
 *
 * Do NOT re-implement either step elsewhere; call these.
 */

import { computeFederalTax, emptyFederalInputs } from './federal';
import { computeIraDeductionLimit, computeRothIraContributionLimit, type PhaseOutResult } from './phaseouts';
import { resolveContributionActuals } from './payments';
import type {
  BookTaxData,
  FederalTaxInputs,
  FilingStatus,
  TaxCategory,
  TaxYear,
} from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Categories that are simple annual flows we can annualize from YTD. */
export const ANNUALIZABLE_CATEGORIES: readonly TaxCategory[] = [
  'w2_wages', 'federal_withholding', 'state_withholding', 'estimated_tax_payment',
  'state_estimated_tax_payment', 'fica_social_security',
  'fica_medicare', 'interest_income', 'tax_exempt_interest', 'ordinary_dividends',
  'qualified_dividends',
  'self_employment_income', 'business_expense', 'rental_income', 'retirement_income',
  'social_security_benefits', 'charitable_donation', 'mortgage_interest',
  'property_tax', 'state_local_tax_paid', 'medical_expense', 'education_expense',
  'other_income', 'other_deduction',
];

export function bookCategoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

/**
 * Map aggregated book data to FederalTaxInputs.
 *
 * `factor` (>= 1) annualizes the simple annual flows in
 * ANNUALIZABLE_CATEGORIES; capital gains (point-in-time realized lots) and
 * retirement contributions (limit-bound) are never annualized. Pass 1 for
 * raw YTD figures (the withholding checkup annualizes later at the
 * input-field level via `annualizeInputs` — the two are equivalent).
 */
export function buildFederalInputsFromBookData(
  bookData: BookTaxData,
  year: TaxYear,
  filingStatus: FilingStatus,
  filersAge65Plus = 0,
  factor = 1,
): FederalTaxInputs {
  const f = factor > 1 ? factor : 1;
  const get = (c: TaxCategory) =>
    bookCategoryTotal(bookData, c) * (ANNUALIZABLE_CATEGORIES.includes(c) ? f : 1);

  const qualifiedDividends = get('qualified_dividends');
  // 401k/IRA/HSA contributions: the classifier-based contribution summary is
  // authoritative for flagged retirement types (it excludes internal
  // dividends/transfers/match); category totals only serve as fallback for
  // books without retirement flags. See resolveContributionActuals.
  const { trad401k, tradIra, hsa, sepIra, simpleIra } = resolveContributionActuals(bookData);

  return {
    ...emptyFederalInputs(year, filingStatus),
    wages: get('w2_wages'),
    interest: get('interest_income'),
    // Muni interest: excluded from taxable income/AGI; only feeds Social
    // Security taxability (Pub 915) inside the federal engine.
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
    // State estimated payments count as state income tax paid during the
    // year (Schedule A line 5a), same as state withholding.
    stateLocalTaxesPaid: get('state_withholding') + get('state_estimated_tax_payment')
      + get('property_tax') + get('state_local_tax_paid'),
    medicalExpenses: get('medical_expense'),
    otherDeductions: get('other_deduction'),
    filersAge65Plus,
  };
}

/* ------------------------------------------------------------------ */
/* Household layer: Child Tax Credit + IRA deduction phase-out         */
/* ------------------------------------------------------------------ */

export interface HouseholdTaxContext {
  /** Dependents under 17 at year end (Child Tax Credit count). */
  qualifyingChildrenUnder17: number;
  /** Filer is an active participant in an employer plan. */
  coveredByEmployerPlan: boolean;
  /** Spouse is an active participant in an employer plan. */
  spouseCoveredByEmployerPlan: boolean;
  /** Filer's IRA contribution limit (base + catch-up), or null when unknown. */
  selfIraLimit: number | null;
  /** Spouse's IRA contribution limit, or null when unknown / not joint. */
  spouseIraLimit: number | null;
  /**
   * Per-owner traditional-IRA contribution split (from
   * bookData.contributionsByTypeAndOwner). Optional — without it, all
   * contributions are attributed to the filer.
   */
  contributionsByTypeAndOwner?: Record<string, { self: number; spouse: number }>;
  /**
   * OBBBA §224 qualified tip income (2025-2028) — user-entered, not
   * book-derived. The engine applies the cap, MAGI phase-out, and MFS
   * exclusion. Optional; omitted/undefined leaves the base input untouched.
   */
  qualifiedTipIncome?: number;
  /** OBBBA §225 qualified overtime premium (2025-2028) — user-entered. */
  qualifiedOvertimeCompensation?: number;
  /** OBBBA §163(h)(4) qualified car-loan interest (2025-2028) — user-entered. */
  qualifiedCarLoanInterest?: number;
}

export interface PhaseOutPerson {
  deduction: PhaseOutResult | null;
  roth: PhaseOutResult | null;
  /** Traditional IRA contributions attributed to this person. */
  tradContrib: number;
}

export interface EstimatorPhaseOuts {
  /** MAGI computed WITHOUT the IRA deduction (the §219(g) base). */
  magi: number;
  self: PhaseOutPerson;
  spouse: PhaseOutPerson | null;
  /** Contributions above the deductible limit (Form 8606 non-deductible). */
  nonDeductibleIra: number;
}

export interface HouseholdTaxDetailsResult {
  /** Engine-ready inputs: CTC set, traditional IRA capped at the deductible limit. */
  inputs: FederalTaxInputs;
  phaseOuts: EstimatorPhaseOuts;
}

/**
 * Apply the household details the estimator page layers on top of raw book
 * inputs — shared verbatim by the withholding checkup:
 *
 * - Child Tax Credit: sets `qualifyingChildrenUnder17`.
 * - OBBBA §224/§225/§163(h)(4) amounts (tips / overtime premium / car-loan
 *   interest): user-entered, passed through to the engine which owns the
 *   caps, phase-outs, and year gating.
 * - Traditional IRA deduction: caps `traditionalIraContributions` at the
 *   §219(g) deductible limit per spouse, using MAGI computed without the
 *   IRA deduction itself.
 */
export function applyHouseholdTaxDetails(
  base: FederalTaxInputs,
  household: HouseholdTaxContext,
): HouseholdTaxDetailsResult {
  const { year, filingStatus } = base;
  const inputs: FederalTaxInputs = {
    ...base,
    qualifyingChildrenUnder17: Math.max(0, household.qualifyingChildrenUnder17),
    // OBBBA below-the-line inputs (do not affect AGI, so the §219(g) MAGI
    // pass below is unaffected). undefined = leave the base value as-is.
    ...(household.qualifiedTipIncome !== undefined
      ? { qualifiedTipIncome: Math.max(0, household.qualifiedTipIncome) }
      : {}),
    ...(household.qualifiedOvertimeCompensation !== undefined
      ? { qualifiedOvertimeCompensation: Math.max(0, household.qualifiedOvertimeCompensation) }
      : {}),
    ...(household.qualifiedCarLoanInterest !== undefined
      ? { qualifiedCarLoanInterest: Math.max(0, household.qualifiedCarLoanInterest) }
      : {}),
  };

  // MAGI for IRA purposes is computed WITHOUT the IRA deduction itself, so
  // run a first pass with zero traditional IRA contributions.
  const magiPass = computeFederalTax({ ...inputs, traditionalIraContributions: 0 });
  const magi = magiPass.agi;

  const isJoint = filingStatus === 'mfj' || filingStatus === 'qss';
  const byOwner = household.contributionsByTypeAndOwner;
  const tradIraSelf = isJoint && byOwner
    ? byOwner['traditional_ira']?.self ?? 0
    : inputs.traditionalIraContributions;
  const tradIraSpouse = isJoint && byOwner ? byOwner['traditional_ira']?.spouse ?? 0 : 0;
  // Owner attribution may not cover category-mapped contributions; put any
  // remainder on self so nothing is silently dropped.
  const attributed = tradIraSelf + tradIraSpouse;
  const remainder = Math.max(0, inputs.traditionalIraContributions - attributed);

  const { selfIraLimit, spouseIraLimit } = household;

  const selfPhaseOut = selfIraLimit !== null
    ? computeIraDeductionLimit({
        year, filingStatus, magi,
        coveredByEmployerPlan: household.coveredByEmployerPlan,
        spouseCoveredByEmployerPlan: household.spouseCoveredByEmployerPlan,
        iraLimit: selfIraLimit,
      })
    : null;
  const spousePhaseOut = isJoint && spouseIraLimit !== null
    ? computeIraDeductionLimit({
        year, filingStatus, magi,
        coveredByEmployerPlan: household.spouseCoveredByEmployerPlan,
        spouseCoveredByEmployerPlan: household.coveredByEmployerPlan,
        iraLimit: spouseIraLimit,
      })
    : null;

  const selfRoth = selfIraLimit !== null
    ? computeRothIraContributionLimit({ year, filingStatus, magi, iraLimit: selfIraLimit })
    : null;
  const spouseRoth = isJoint && spouseIraLimit !== null
    ? computeRothIraContributionLimit({ year, filingStatus, magi, iraLimit: spouseIraLimit })
    : null;

  const deductibleSelf = selfPhaseOut
    ? Math.min(tradIraSelf + remainder, selfPhaseOut.deductibleLimit)
    : tradIraSelf + remainder;
  const deductibleSpouse = spousePhaseOut
    ? Math.min(tradIraSpouse, spousePhaseOut.deductibleLimit)
    : tradIraSpouse;
  const deductibleIra = round2(deductibleSelf + deductibleSpouse);
  const nonDeductibleIra = Math.max(0, inputs.traditionalIraContributions - deductibleIra);

  return {
    inputs: { ...inputs, traditionalIraContributions: deductibleIra },
    phaseOuts: {
      magi,
      self: { deduction: selfPhaseOut, roth: selfRoth, tradContrib: tradIraSelf + remainder },
      spouse: isJoint
        ? { deduction: spousePhaseOut, roth: spouseRoth, tradContrib: tradIraSpouse }
        : null,
      nonDeductibleIra,
    },
  };
}
