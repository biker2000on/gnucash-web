/**
 * Job-offer comparison engine — pure functions, no I/O.
 *
 * Extends the single-paycheck model (paycheck.ts) into a full offer
 * comparison mirroring a "Pay Comparison" spreadsheet: per-scenario total
 * compensation, PTO economics, all-in healthcare cost, self-employment
 * taxes, and an Overall Annual Total that can be compared across any
 * number of scenarios against a designated baseline.
 *
 * KEY CONVENTIONS (documented for the UI):
 * - Salaried W-2: PTO (holidays + vacation) is paid, so it ADDS value —
 *   ptoValue = days x (salary / 260 working days).
 * - Hourly W-2 and 1099: time off is unpaid, so it REDUCES annual pay
 *   (working-weeks logic) instead of adding a PTO line.
 * - Total Compensation = pay + overtime + expected bonus + 401(k) match +
 *   other employer contributions + ESOP potential. Employer money counts
 *   toward Total Comp but never toward take-home.
 * - Expected out-of-pocket care cost =
 *     min(oopMax, min(billed, deductible) + coins% x max(0, billed - deductible))
 *   i.e. below the deductible you pay what was billed, between deductible
 *   and the OOP max you pay deductible + your coinsurance share, and the
 *   plan's OOP max caps the total.
 * - HDHP plans get credit for the tax value of the employee's HSA payroll
 *   contribution at the combined marginal rate (the sheet's "Tax Deduction"
 *   line). allInHealthcareCost = premiums x 12 + expected OOP - employer
 *   HSA seed - HSA tax value.
 * - 1099: SE tax (both halves, Schedule SE) is charged against the Overall
 *   Annual Total; income tax handles the half-SE deduction internally via
 *   the federal engine. Premiums are paid personally, so they are also
 *   subtracted from 1099 take-home for comparability with W-2 net pay
 *   (which is already net of cafeteria premiums).
 * - Overall Annual Total = Total Comp + ptoValue (salaried only)
 *   - allInHealthcareCost - SE tax (1099 only). This is a PRE-income-tax
 *   economic measure like the spreadsheet's bottom line; take-home/month is
 *   reported separately (post-tax, post-deduction).
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { computeFederalTax, computeSeTax, emptyFederalInputs } from './federal';
import { computeStateTax } from './state';
import { computePaycheck } from './paycheck';
import { compareScenarios } from './s-corp-analysis';
import type { FilingStatus, TaxYear } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const money = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

/** Standard working days per year (52 weeks x 5 days). */
export const WORKING_DAYS_PER_YEAR = 260;
/** Default annual billable hours for a full-time 1099 engagement. */
export const DEFAULT_BILLABLE_HOURS = 2080;

export type EmploymentType = 'salaried_w2' | 'hourly_w2' | 'self_employed_1099';

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  salaried_w2: 'Salaried (W-2)',
  hourly_w2: 'Hourly (W-2)',
  self_employed_1099: 'Self-employed (1099)',
};

export interface OfferScenario {
  id: string;
  name: string;
  employmentType: EmploymentType;

  /* ---- Pay ---- */
  /** Annual salary (salaried_w2). */
  salary: number;
  /** Hourly rate (hourly_w2 and 1099-hourly). */
  hourlyRate: number;
  /** Scheduled hours per week (hourly_w2). Default 40. */
  hoursPerWeek: number;
  /** Expected overtime hours per year (hourly_w2 only). */
  overtimeHoursPerYear: number;
  /** Overtime pay multiplier. Default 1.5. */
  overtimeMultiplier: number;
  /** 1099 pay basis. */
  payBasis1099: 'hourly' | 'flat';
  /** Annual billable hours (1099-hourly). Default 2080. */
  billableHoursPerYear: number;
  /** Flat annual revenue (1099-flat). */
  flatAnnual1099: number;
  /** Business deductions as % of gross revenue (1099). */
  deductionsPercent1099: number;

  /* ---- Bonus & equity ---- */
  /** Target bonus as % of base pay. */
  bonusPercent: number;
  /** Expected-payout factor 0-2 (0 zeroes out an unreliable bonus). */
  bonusMultiplier: number;
  /** Annual ESOP / equity potential value ($). */
  esopPotential: number;

  /* ---- Employer retirement money ---- */
  /** 401(k) employer match as % of base pay (counts toward Total Comp). */
  match401kPercent: number;
  /** Other employer contributions $ (HSA seed to 401k, profit sharing...). */
  otherEmployerContrib: number;
  /** Label for the other-contribution line. */
  otherEmployerContribLabel: string;

  /* ---- Time off ---- */
  holidays: number;
  vacationDays: number;

  /* ---- Healthcare ---- */
  medicalPremiumMonthly: number;
  dentalPremiumMonthly: number;
  otherPremiumMonthly: number;
  /** Employer HSA seed $ / year (reduces net healthcare cost). */
  hsaSeed: number;
  deductible: number;
  oopMax: number;
  /** Your coinsurance share after the deductible, % (e.g. 20). */
  coinsurancePercentAfterDeductible: number;
  /** Your estimate of annual billed care $. */
  expectedAnnualCareBilled: number;
  isHdhp: boolean;

  /* ---- Employee-side deferrals / taxes ---- */
  /** Traditional 401(k) elective deferral as % of gross. */
  employee401kPercent: number;
  hsaPerPaycheck: number;
  fsaPerPaycheck: number;
  payPeriodsPerYear: number;
}

export interface SharedTaxSettings {
  year: TaxYear;
  filingStatus: FilingStatus;
  stateCode: string;
  stateFlatRate?: number;
}

export interface OfferScenarioResult {
  scenarioId: string;
  name: string;
  employmentType: EmploymentType;

  /** Annual base pay AFTER unpaid-time-off reduction (hourly/1099). */
  basePay: number;
  overtimePay: number;
  estimatedBonus: number;
  employerMatch: number;
  otherEmployerContrib: number;
  esopPotential: number;
  /** basePay + overtime + bonus + match + other employer + ESOP. */
  totalCompensation: number;

  /** Paid-time-off value (salaried_w2 only; 0 otherwise). */
  ptoValue: number;
  /** Pay lost to unpaid time off (hourly_w2 / 1099; informational). */
  unpaidTimeOffReduction: number;

  premiumsAnnual: number;
  expectedOopCost: number;
  hsaSeed: number;
  /** Tax value of the employee HSA contribution when the plan is HDHP. */
  hsaTaxValue: number;
  /** premiums + expected OOP - HSA seed - HSA tax value. */
  allInHealthcareCost: number;

  /** Schedule SE tax, both halves (1099 only; 0 for W-2). */
  seTax: number;
  /** Estimated S-corp election savings at 50% reasonable salary (1099 only). */
  scorpSavingsHint: number | null;

  /** TotalComp + ptoValue(salaried) - healthcare - SE tax(1099). */
  overallAnnualTotal: number;
  overallMonthly: number;

  /** Post-tax, post-deduction cash. */
  takeHomeAnnual: number;
  takeHomeMonthly: number;

  /** Hours actually worked (net of time off; incl. overtime). */
  workedHours: number;
  /** overallAnnualTotal / workedHours. */
  effectiveHourlyRate: number;

  combinedMarginalRate: number;
  effectiveTaxRate: number;

  /** Null on the baseline itself. */
  deltaVsBaseline: { amount: number; percent: number } | null;
}

export interface OfferComparisonResult {
  results: OfferScenarioResult[];
  baselineId: string;
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/**
 * Expected annual out-of-pocket care cost.
 * Below the deductible you pay the billed amount; between the deductible
 * and the OOP max you add your coinsurance share; the OOP max caps it.
 */
export function expectedOopCost(
  deductible: number,
  oopMax: number,
  coinsurancePercent: number,
  billed: number,
): number {
  const ded = money(deductible);
  const cap = money(oopMax);
  const coins = clamp(coinsurancePercent, 0, 100) / 100;
  const b = money(billed);
  const raw = Math.min(b, ded) + coins * Math.max(0, b - ded);
  return round2(Math.min(cap > 0 ? cap : raw, raw));
}

interface ResolvedPay {
  basePay: number;
  overtimePay: number;
  workedHours: number;
  ptoValue: number;
  unpaidTimeOffReduction: number;
}

/** Resolve annual pay, worked hours, and the PTO / unpaid-time-off split. */
export function resolveAnnualPay(s: OfferScenario): ResolvedPay {
  const daysOff = money(s.holidays) + money(s.vacationDays);

  if (s.employmentType === 'salaried_w2') {
    const salary = money(s.salary);
    const dailyRate = salary / WORKING_DAYS_PER_YEAR;
    return {
      basePay: salary,
      overtimePay: 0,
      workedHours: Math.max(0, WORKING_DAYS_PER_YEAR - daysOff) * 8,
      ptoValue: round2(daysOff * dailyRate),
      unpaidTimeOffReduction: 0,
    };
  }

  if (s.employmentType === 'hourly_w2') {
    const rate = money(s.hourlyRate);
    const hoursPerWeek = money(s.hoursPerWeek) || 40;
    const hoursPerDay = hoursPerWeek / 5;
    const scheduledHours = hoursPerWeek * 52;
    const baseHours = Math.max(0, scheduledHours - daysOff * hoursPerDay);
    const otHours = money(s.overtimeHoursPerYear);
    const otMult = clamp(s.overtimeMultiplier || 1.5, 1, 3);
    return {
      basePay: round2(rate * baseHours),
      overtimePay: round2(rate * otMult * otHours),
      workedHours: baseHours + otHours,
      ptoValue: 0,
      unpaidTimeOffReduction: round2(rate * Math.min(scheduledHours, daysOff * hoursPerDay)),
    };
  }

  // self_employed_1099
  if (s.payBasis1099 === 'flat') {
    const flat = money(s.flatAnnual1099);
    const workedDays = Math.max(0, WORKING_DAYS_PER_YEAR - daysOff);
    const factor = workedDays / WORKING_DAYS_PER_YEAR;
    return {
      basePay: round2(flat * factor),
      overtimePay: 0,
      workedHours: workedDays * 8,
      ptoValue: 0,
      unpaidTimeOffReduction: round2(flat * (1 - factor)),
    };
  }
  const rate = money(s.hourlyRate);
  const billable = money(s.billableHoursPerYear) || DEFAULT_BILLABLE_HOURS;
  const hours = Math.max(0, billable - daysOff * 8);
  return {
    basePay: round2(rate * hours),
    overtimePay: 0,
    workedHours: hours,
    ptoValue: 0,
    unpaidTimeOffReduction: round2(rate * Math.min(billable, daysOff * 8)),
  };
}

/* ------------------------------------------------------------------ */
/* Scenario computation                                                */
/* ------------------------------------------------------------------ */

export function computeOfferScenario(
  s: OfferScenario,
  shared: SharedTaxSettings,
): Omit<OfferScenarioResult, 'deltaVsBaseline'> {
  const pay = resolveAnnualPay(s);
  const periods = s.payPeriodsPerYear > 0 ? s.payPeriodsPerYear : 26;

  /* ---- Bonus & employer money ---- */
  const bonusMult = clamp(s.bonusMultiplier, 0, 2);
  const estimatedBonus = round2(pay.basePay * (money(s.bonusPercent) / 100) * bonusMult);
  const matchBase = pay.basePay + pay.overtimePay;
  const employerMatch = round2(matchBase * (money(s.match401kPercent) / 100));
  const otherEmployerContrib = round2(money(s.otherEmployerContrib));
  const esopPotential = round2(money(s.esopPotential));

  const totalCompensation = round2(
    pay.basePay + pay.overtimePay + estimatedBonus + employerMatch + otherEmployerContrib + esopPotential,
  );

  /* ---- Healthcare ---- */
  const premiumsAnnual = round2(
    (money(s.medicalPremiumMonthly) + money(s.dentalPremiumMonthly) + money(s.otherPremiumMonthly)) * 12,
  );
  const oop = expectedOopCost(
    s.deductible,
    s.oopMax,
    s.coinsurancePercentAfterDeductible,
    s.expectedAnnualCareBilled,
  );
  const hsaSeed = round2(money(s.hsaSeed));
  const employeeHsaAnnual = money(s.hsaPerPaycheck) * periods;

  /* ---- Taxes / take-home ---- */
  let takeHomeAnnual: number;
  let combinedMarginalRate: number;
  let effectiveTaxRate: number;
  let seTax = 0;
  let scorpSavingsHint: number | null = null;

  if (s.employmentType === 'self_employed_1099') {
    const grossRevenue = pay.basePay + estimatedBonus;
    const deductPct = clamp(s.deductionsPercent1099 || 0, 0, 100) / 100;
    const profit = Math.max(0, grossRevenue * (1 - deductPct));

    const d401k = profit * (clamp(s.employee401kPercent || 0, 0, 100) / 100);
    const federal = computeFederalTax({
      ...emptyFederalInputs(shared.year, shared.filingStatus),
      selfEmploymentIncome: profit,
      traditional401kContributions: d401k,
      hsaContributions: employeeHsaAnnual,
    });
    const state = computeStateTax(shared.stateCode, {
      year: shared.year,
      filingStatus: shared.filingStatus,
      federalAgi: federal.agi,
      flatRateOverride: shared.stateFlatRate,
    });

    seTax = round2(computeSeTax(profit, shared.year).total);
    // Premiums are paid personally on 1099 — subtracted here so take-home is
    // comparable to W-2 net pay (which is net of cafeteria premiums).
    takeHomeAnnual = round2(
      profit - federal.totalTax - state.tax - d401k - employeeHsaAnnual - premiumsAnnual,
    );
    combinedMarginalRate =
      Math.round((federal.marginalRate + state.marginalRate) * 10000) / 10000;
    effectiveTaxRate =
      profit > 0
        ? Math.round(((federal.totalTax + state.tax) / profit) * 10000) / 10000
        : 0;

    if (profit > 0) {
      scorpSavingsHint = compareScenarios({
        year: shared.year,
        filingStatus: shared.filingStatus,
        annualProfit: profit,
        ownershipPercent: 100,
        reasonableSalary: profit * 0.5,
        payrollServiceCost: 0,
        taxPrepCost: 0,
        stateFranchiseTax: 0,
        otherHouseholdOrdinaryIncome: 0,
      }).savings;
    }
  } else {
    const annualGross = pay.basePay + pay.overtimePay + estimatedBonus;
    const pc = computePaycheck({
      year: shared.year,
      filingStatus: shared.filingStatus,
      stateCode: shared.stateCode,
      stateFlatRate: shared.stateFlatRate,
      payPeriodsPerYear: periods,
      annualGross,
      trad401kPercent: clamp(s.employee401kPercent || 0, 0, 100),
      hsaPerPaycheck: money(s.hsaPerPaycheck),
      fsaPerPaycheck: money(s.fsaPerPaycheck),
      healthPremiumPerPaycheck: premiumsAnnual / periods,
    });
    takeHomeAnnual = pc.annual.net;
    combinedMarginalRate = pc.combinedMarginalRate;
    effectiveTaxRate = pc.effectiveTaxRate;
  }

  const hsaTaxValue = s.isHdhp
    ? round2(employeeHsaAnnual * combinedMarginalRate)
    : 0;
  const allInHealthcareCost = round2(premiumsAnnual + oop - hsaSeed - hsaTaxValue);

  /* ---- Overall total ---- */
  const overallAnnualTotal = round2(
    totalCompensation +
      (s.employmentType === 'salaried_w2' ? pay.ptoValue : 0) -
      allInHealthcareCost -
      seTax,
  );

  return {
    scenarioId: s.id,
    name: s.name,
    employmentType: s.employmentType,
    basePay: round2(pay.basePay),
    overtimePay: round2(pay.overtimePay),
    estimatedBonus,
    employerMatch,
    otherEmployerContrib,
    esopPotential,
    totalCompensation,
    ptoValue: pay.ptoValue,
    unpaidTimeOffReduction: pay.unpaidTimeOffReduction,
    premiumsAnnual,
    expectedOopCost: oop,
    hsaSeed,
    hsaTaxValue,
    allInHealthcareCost,
    seTax,
    scorpSavingsHint,
    overallAnnualTotal,
    overallMonthly: round2(overallAnnualTotal / 12),
    takeHomeAnnual: round2(takeHomeAnnual),
    takeHomeMonthly: round2(takeHomeAnnual / 12),
    workedHours: Math.round(pay.workedHours),
    effectiveHourlyRate:
      pay.workedHours > 0 ? round2(overallAnnualTotal / pay.workedHours) : 0,
    combinedMarginalRate,
    effectiveTaxRate,
  };
}

/**
 * Compute every scenario and attach delta-vs-baseline on the Overall Annual
 * Total. Falls back to the first scenario when baselineId is missing.
 */
export function compareOffers(
  scenarios: OfferScenario[],
  baselineId: string,
  shared: SharedTaxSettings,
): OfferComparisonResult {
  const computed = scenarios.map(s => computeOfferScenario(s, shared));
  const effectiveBaselineId = computed.some(r => r.scenarioId === baselineId)
    ? baselineId
    : (computed[0]?.scenarioId ?? baselineId);
  const baseline = computed.find(r => r.scenarioId === effectiveBaselineId);

  const results: OfferScenarioResult[] = computed.map(r => {
    if (!baseline || r.scenarioId === effectiveBaselineId) {
      return { ...r, deltaVsBaseline: null };
    }
    const amount = round2(r.overallAnnualTotal - baseline.overallAnnualTotal);
    const percent =
      baseline.overallAnnualTotal !== 0
        ? Math.round((amount / Math.abs(baseline.overallAnnualTotal)) * 10000) / 10000
        : 0;
    return { ...r, deltaVsBaseline: { amount, percent } };
  });

  return { results, baselineId: effectiveBaselineId };
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function defaultOfferScenario(id: string, name: string): OfferScenario {
  return {
    id,
    name,
    employmentType: 'salaried_w2',
    salary: 85_000,
    hourlyRate: 40,
    hoursPerWeek: 40,
    overtimeHoursPerYear: 0,
    overtimeMultiplier: 1.5,
    payBasis1099: 'hourly',
    billableHoursPerYear: DEFAULT_BILLABLE_HOURS,
    flatAnnual1099: 0,
    deductionsPercent1099: 0,
    bonusPercent: 0,
    bonusMultiplier: 1,
    esopPotential: 0,
    match401kPercent: 0,
    otherEmployerContrib: 0,
    otherEmployerContribLabel: 'Other employer contribution',
    holidays: 10,
    vacationDays: 15,
    medicalPremiumMonthly: 0,
    dentalPremiumMonthly: 0,
    otherPremiumMonthly: 0,
    hsaSeed: 0,
    deductible: 0,
    oopMax: 0,
    coinsurancePercentAfterDeductible: 20,
    expectedAnnualCareBilled: 0,
    isHdhp: false,
    employee401kPercent: 6,
    hsaPerPaycheck: 0,
    fsaPerPaycheck: 0,
    payPeriodsPerYear: 26,
  };
}
