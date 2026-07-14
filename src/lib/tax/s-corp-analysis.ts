/**
 * S-corp election analyzer — pure math, no I/O.
 *
 * Compares the total federal cost of running a pass-through business as an
 * LLC/sole-proprietorship (all profit subject to SE tax) versus an S-corp
 * (reasonable salary subject to FICA, remaining profit distributed as K-1
 * income free of employment tax) at the household level.
 *
 * MODEL & SIMPLIFICATIONS (documented in `MODEL_ASSUMPTIONS` for the UI):
 * - Federal only. State income tax is treated as equal in both scenarios
 *   (e.g. NC's flat rate applies the same to SE profit as to salary + K-1),
 *   except for the explicit state franchise tax the S-corp must pay.
 * - QBI deduction is the plain 20% computation capped at 20% of taxable
 *   income before QBI. The SSTB (specified service trade or business)
 *   phase-out is NOT modeled — for SSTBs (health services such as
 *   acupuncture, consulting, law, etc.) the QBI deduction phases out above
 *   ~$383k MFJ taxable income (2024, indexed later years), which makes the
 *   S-corp relatively MORE attractive at high incomes because losing QBI
 *   hurts the LLC's larger qualified income more.
 * - Additional Medicare tax (0.9%) and NIIT are not modeled; they are nearly
 *   identical across the two scenarios for the same total earnings.
 * - Household "other" ordinary income is taxed with the standard deduction
 *   only (no itemized deductions, no credits) — the point is the DELTA
 *   between the scenarios, and both include the identical other income.
 * - The reasonable salary is assumed to be paid to THIS household's owner in
 *   full, while distributions are split by ownershipPercent. For a 100%-owned
 *   business the distinction is moot.
 * - No accumulated-earnings, payroll-compliance-risk, or state-specific
 *   S-corp entity-tax issues (beyond the flat franchise tax input).
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { computeSeTax, getSsWageBase, getYearStatusParams, taxFromBrackets } from './federal';
import type { FilingStatus, TaxYear } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Employer/employee FICA rates (each side). */
const FICA_SS_RATE = 0.062;
const FICA_MEDICARE_RATE = 0.0145;

/** Salary sweep floor used by the breakeven curve ($30k minimum salary). */
export const SWEEP_SALARY_FLOOR = 30_000;

export const MODEL_ASSUMPTIONS: string[] = [
  'QBI deduction is the simple 20% computation capped at 20% of taxable income before QBI. The SSTB phase-out is not modeled — for specified service businesses (health services such as acupuncture, consulting, law) QBI phases out above ~$383k MFJ taxable income, which makes the S-corp relatively better at high incomes.',
  'The S-corp salary must be defensible market-rate "reasonable compensation" — the IRS can reclassify distributions as wages if the salary is too low.',
  'State income tax is treated as equal in both scenarios (a flat state rate taxes SE profit and salary + K-1 the same); only the explicit state franchise tax differs.',
  'Additional Medicare tax (0.9%) and NIIT are not modeled — they are nearly identical between scenarios.',
  'Household income tax uses the standard deduction only (no itemized deductions or credits); both scenarios include the same other household income, so the savings delta is unaffected.',
  'The full reasonable salary is assumed paid to this household’s owner; distributions are split by ownership percent.',
  'No accumulated-earnings or payroll-compliance risk modeling.',
];

export interface CompareScenariosInput {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** Whole-business net profit for the year (before owner salary). */
  annualProfit: number;
  /** This household's ownership of the business, 0–100. */
  ownershipPercent: number;
  /** Proposed S-corp reasonable salary (clamped to profit). */
  reasonableSalary: number;
  /** Annual payroll-service cost the S-corp must pay (LLC: $0). */
  payrollServiceCost: number;
  /** Incremental tax-prep cost of the 1120-S vs a Schedule C. */
  taxPrepCost: number;
  /** Annual state franchise/entity tax on the S-corp. */
  stateFranchiseTax: number;
  /** Household ordinary income outside this business (W-2, interest, dividends...). */
  otherHouseholdOrdinaryIncome: number;
  /** Other household self-employment profit (e.g. spouse's Schedule C). */
  otherHouseholdSeIncome?: number;
  /**
   * Household W-2 Social Security wages — reduce the SS wage base available
   * to SE earnings (LLC) and to the employee side of S-corp salary (excess
   * employee SS withholding is refunded at filing). Optional, defaults 0.
   */
  otherHouseholdW2Wages?: number;
}

export interface ScenarioDetail {
  /**
   * Employment taxes for the scenario. LLC: all household SE tax (this
   * business + other SE income). S-corp: employee FICA + owner's share of
   * employer FICA (the employer half is also the owner's money in a
   * wholly-owned business) + SE tax on other household SE income.
   */
  seTaxOrFica: number;
  /** Household federal income tax (bracket tax after QBI + standard deduction). */
  incomeTax: number;
  qbiDeduction: number;
  /** Owner's share of S-corp-only costs: payroll service, tax prep, franchise tax. */
  extraCosts: number;
  /** seTaxOrFica + incomeTax + extraCosts. */
  totalCost: number;
  /**
   * Owner's cash from the business after all business-attributable taxes and
   * costs: gross owner income minus (totalCost − baseline household tax
   * without the business).
   */
  netAfterTax: number;
  /** Owner's gross economic income from the business in this scenario. */
  grossOwnerIncome: number;
  /** Household taxable income after deductions in this scenario. */
  taxableIncome: number;
}

export interface ScorpScenarioDetail extends ScenarioDetail {
  /** Salary actually used (clamped to profit). */
  salaryUsed: number;
  employerFica: number;
  employeeFica: number;
  /** Owner's K-1 share of distributable profit (may be negative). */
  k1Income: number;
}

export interface BreakevenPoint {
  profit: number;
  savings: number;
}

export interface CompareScenariosResult {
  llc: ScenarioDetail;
  scorp: ScorpScenarioDetail;
  /** llc.totalCost − scorp.totalCost. Positive = S-corp saves money. */
  savings: number;
  /** True when reasonableSalary exceeded profit and was clamped. */
  salaryClamped: boolean;
  /** Savings swept across profit levels, holding the salary strategy constant. */
  breakevenCurve: BreakevenPoint[];
  /** First sweep profit where savings > 0 (null when never positive). */
  breakevenProfit: number | null;
}

/** Employer-side FICA on a salary (per-employer SS wage base). */
function employerFicaOn(salary: number, year: TaxYear): number {
  const base = getSsWageBase(year);
  return Math.min(salary, base) * FICA_SS_RATE + salary * FICA_MEDICARE_RATE;
}

/**
 * Employee-side FICA on a salary, coordinating the SS wage base with other
 * household W-2 wages (excess employee SS withheld across employers is
 * refunded at filing, so only the remaining base effectively costs money).
 */
function employeeFicaOn(salary: number, year: TaxYear, otherW2Wages: number): number {
  const base = getSsWageBase(year);
  const remaining = Math.max(0, base - Math.max(0, otherW2Wages));
  return Math.min(salary, remaining) * FICA_SS_RATE + salary * FICA_MEDICARE_RATE;
}

interface HouseholdTaxParts {
  incomeTax: number;
  qbiDeduction: number;
  taxableIncome: number;
}

/**
 * Household bracket income tax on (otherOrdinary + otherSe + businessOrdinary)
 * with the given above-the-line adjustments and a QBI base for THIS business.
 * QBI = 20% × qbiBase, capped at 20% of taxable income before QBI.
 * (QBI on other household SE income is intentionally ignored — identical in
 * both scenarios, so it cancels out of the savings delta.)
 */
function householdIncomeTax(
  input: CompareScenariosInput,
  businessOrdinaryIncome: number,
  adjustments: number,
  qbiBase: number,
): HouseholdTaxParts {
  const p = getYearStatusParams(input.year, input.filingStatus);
  const otherSe = Math.max(0, input.otherHouseholdSeIncome ?? 0);
  const income = input.otherHouseholdOrdinaryIncome + otherSe + businessOrdinaryIncome;
  const taxableBeforeQbi = Math.max(0, income - adjustments - p.standardDeduction);
  const qbi = Math.min(0.2 * Math.max(0, qbiBase), 0.2 * taxableBeforeQbi);
  const taxable = Math.max(0, taxableBeforeQbi - qbi);
  return {
    incomeTax: round2(taxFromBrackets(taxable, p.brackets)),
    qbiDeduction: round2(qbi),
    taxableIncome: round2(taxable),
  };
}

/**
 * Compare LLC vs S-corp at a single profit level. Internal core used both
 * for the headline comparison and the breakeven sweep.
 */
function compareAtProfit(
  input: CompareScenariosInput,
  annualProfit: number,
  reasonableSalary: number,
): Omit<CompareScenariosResult, 'breakevenCurve' | 'breakevenProfit'> {
  const pct = Math.min(100, Math.max(0, input.ownershipPercent)) / 100;
  const otherSe = Math.max(0, input.otherHouseholdSeIncome ?? 0);
  const otherW2 = Math.max(0, input.otherHouseholdW2Wages ?? 0);
  const p = getYearStatusParams(input.year, input.filingStatus);

  /* ---- Baseline: household without this business ------------------- */
  // Used to attribute income tax to the business when computing netAfterTax.
  const seOther = computeSeTax(otherSe, input.year, otherW2);
  const baseTaxableBefore = Math.max(
    0,
    input.otherHouseholdOrdinaryIncome + otherSe - seOther.halfDeduction - p.standardDeduction,
  );
  const baselineIncomeTax = taxFromBrackets(baseTaxableBefore, p.brackets);
  const baselineTotal = baselineIncomeTax + seOther.total;

  /* ---- LLC scenario ------------------------------------------------- */
  // Owner picks up their share of profit on Schedule C/K-1 subject to SE tax.
  const ownerProfit = Math.max(0, annualProfit) * pct;
  // SE tax on ALL household SE income combined (this business + other SE),
  // with household W-2 wages consuming the SS wage base first — this matches
  // how Schedule SE actually stacks. computeSeTax supports the W-2 offset;
  // combining the two SE streams into one call reproduces the shared base.
  const seCombined = computeSeTax(ownerProfit + otherSe, input.year, otherW2);
  // QBI base: qualified business income reduced by the attributable half-SE
  // deduction (simplified proration by income share).
  const totalSeIncome = ownerProfit + otherSe;
  const halfSeAttributable =
    totalSeIncome > 0 ? seCombined.halfDeduction * (ownerProfit / totalSeIncome) : 0;
  const llcTaxParts = householdIncomeTax(
    input,
    ownerProfit,
    seCombined.halfDeduction,
    ownerProfit - halfSeAttributable,
  );
  const llcSeTax = round2(seCombined.total);
  const llcTotal = round2(llcSeTax + llcTaxParts.incomeTax);
  const llc: ScenarioDetail = {
    seTaxOrFica: llcSeTax,
    incomeTax: llcTaxParts.incomeTax,
    qbiDeduction: llcTaxParts.qbiDeduction,
    extraCosts: 0,
    totalCost: llcTotal,
    netAfterTax: round2(ownerProfit - (llcTotal - baselineTotal)),
    grossOwnerIncome: round2(ownerProfit),
    taxableIncome: llcTaxParts.taxableIncome,
  };

  /* ---- S-corp scenario ---------------------------------------------- */
  // Salary cannot exceed profit — flag when the requested salary is clamped.
  const profitFloor = Math.max(0, annualProfit);
  const salaryClamped = reasonableSalary > profitFloor;
  const salary = Math.min(Math.max(0, reasonableSalary), profitFloor);

  // Business-side deductible costs of running the S-corp.
  const employerFica = employerFicaOn(salary, input.year);
  const adminCosts =
    Math.max(0, input.payrollServiceCost) +
    Math.max(0, input.taxPrepCost) +
    Math.max(0, input.stateFranchiseTax);

  // Distributable profit after salary and S-corp costs; owner takes pct share
  // as K-1 income — NO SE tax, but salary is not QBI (only the K-1 share is).
  const distributable = annualProfit - salary - employerFica - adminCosts;
  const k1Income = distributable * pct;

  // Employee FICA withheld from the salary. The employer half is also
  // economically the owner's money in a wholly-owned business — both halves
  // (owner's share of the employer side) count toward the scenario cost.
  const employeeFica = employeeFicaOn(salary, input.year, otherW2);
  const ficaTotal = round2(employeeFica + employerFica * pct + seOther.total);

  // Income tax: full salary lands in this household (assumption documented
  // above); K-1 distributions split by pct. Half-SE deduction only for the
  // OTHER household SE income (business income is now W-2 + K-1).
  const scorpTaxParts = householdIncomeTax(
    input,
    salary + k1Income,
    seOther.halfDeduction,
    Math.max(0, k1Income), // QBI: K-1 share only; salary is NOT QBI
  );

  const extraCosts = round2(adminCosts * pct); // owner's share of admin costs
  const scorpTotal = round2(ficaTotal + scorpTaxParts.incomeTax + extraCosts);
  // Owner's gross economic income: full salary + pct share of pre-cost
  // profit above the salary. Costs/FICA are then charged via totalCost
  // (they're NOT double-counted through k1Income here).
  const grossOwner = salary + (annualProfit - salary) * pct;
  const scorp: ScorpScenarioDetail = {
    seTaxOrFica: ficaTotal,
    incomeTax: scorpTaxParts.incomeTax,
    qbiDeduction: scorpTaxParts.qbiDeduction,
    extraCosts,
    totalCost: scorpTotal,
    netAfterTax: round2(grossOwner - (scorpTotal - baselineTotal)),
    grossOwnerIncome: round2(grossOwner),
    taxableIncome: scorpTaxParts.taxableIncome,
    salaryUsed: round2(salary),
    employerFica: round2(employerFica),
    employeeFica: round2(employeeFica),
    k1Income: round2(k1Income),
  };

  return {
    llc,
    scorp,
    savings: round2(llc.totalCost - scorp.totalCost),
    salaryClamped,
  };
}

/**
 * Compare the LLC and S-corp scenarios and sweep a breakeven curve.
 *
 * The sweep holds the salary STRATEGY constant: the salary-as-%-of-profit
 * ratio implied by the inputs is applied at each profit level, with a $30k
 * floor and a cap at profit.
 */
export function compareScenarios(input: CompareScenariosInput): CompareScenariosResult {
  const headline = compareAtProfit(input, input.annualProfit, input.reasonableSalary);

  // Salary ratio for the sweep (default 50% when profit is not positive).
  const ratio =
    input.annualProfit > 0
      ? Math.min(1, Math.max(0, input.reasonableSalary) / input.annualProfit)
      : 0.5;

  const maxProfit = Math.max(200_000, 2 * input.annualProfit);
  const breakevenCurve: BreakevenPoint[] = [];
  let breakevenProfit: number | null = null;
  for (let profit = 10_000; profit <= maxProfit; profit += 5_000) {
    const sweepSalary = Math.min(Math.max(SWEEP_SALARY_FLOOR, ratio * profit), profit);
    const point = compareAtProfit(input, profit, sweepSalary);
    breakevenCurve.push({ profit, savings: point.savings });
    if (breakevenProfit === null && point.savings > 0) breakevenProfit = profit;
  }

  return { ...headline, breakevenCurve, breakevenProfit };
}

/**
 * Solo-401(k) employer contribution capacity.
 * - Sole prop / LLC: ~20% of (net profit − ½ SE tax) (IRC §404 self-employed
 *   rate: 25% of compensation ⇒ 20% of net earnings).
 * - S-corp: 25% of W-2 salary.
 */
export function soloEmployerCapacity(
  year: TaxYear,
  kind: 'pass_through' | 's_corp',
  amount: number,
): number {
  if (kind === 's_corp') return round2(Math.max(0, amount) * 0.25);
  const se = computeSeTax(Math.max(0, amount), year);
  return round2(Math.max(0, (Math.max(0, amount) - se.halfDeduction) * 0.2));
}
