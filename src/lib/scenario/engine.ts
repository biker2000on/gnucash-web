/**
 * Scenario Sandbox — pure composition engine.
 *
 * Threads ONE what-if definition (a Scenario: a list of dated deltas)
 * through four deterministic models, side by side with the baseline:
 *
 * 1. Cash flow (monthly, default 5 years): baseline monthly net cash flow
 *    (trailing run rate, which already reflects scheduled transactions in
 *    the book history) vs the scenario with deltas applied — including
 *    amortized loan payments — flagging months where the liquid balance
 *    goes negative.
 * 2. Net worth (annual, default 30 years): current net worth projected with
 *    the average savings rate and a configurable return on invested assets,
 *    vs the scenario with cash deltas, appreciating purchased assets, and
 *    amortizing loan balances.
 * 3. Tax (current + next calendar year): annual federal + state through the
 *    existing tax engine with income / deduction deltas (mortgage interest
 *    and property tax vs the standard deduction — both computed, the better
 *    one picked and reported).
 * 4. FIRE impact: deterministic years-to-FI with adjusted saving/spending.
 *
 * EVERYTHING here is pure and deterministic — no I/O, no randomness.
 * DB loaders live in ./data.ts. Documented simplifications are returned in
 * `ScenarioRunResult.notes`.
 */

import { computeFederalTax } from '@/lib/tax/federal';
import { computeStateTax } from '@/lib/tax/state';
import type { FederalTaxInputs, FederalTaxResult, TaxYear } from '@/lib/tax/types';
import type {
  AmortizationMonth,
  CashFlowMonthPoint,
  CashFlowProjection,
  FireImpact,
  LoanSchedule,
  LoanSummary,
  NetWorthProjection,
  NetWorthYearPoint,
  Scenario,
  ScenarioAssumptions,
  ScenarioBaseline,
  ScenarioDelta,
  ScenarioRunResult,
  TaxSide,
  TaxYearComparison,
} from './types';
import { mergeScenarioAssumptions } from './types';

const round2 = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

/** Longest FIRE search horizon, years. */
const FIRE_HORIZON_YEARS = 60;

/* ------------------------------------------------------------------ */
/* Date / month helpers                                                */
/* ------------------------------------------------------------------ */

/** The projection's origin month. month0 is 0-based (0 = January). */
export interface MonthCursor {
  year: number;
  month0: number;
}

export function cursorFromIso(dateIso: string): MonthCursor {
  const year = parseInt(dateIso.slice(0, 4), 10);
  const month = parseInt(dateIso.slice(5, 7), 10);
  return { year: Number.isFinite(year) ? year : 1970, month0: Number.isFinite(month) ? month - 1 : 0 };
}

/** Month index of a YYYY-MM-DD date relative to the cursor (may be negative). */
export function monthIndexOf(dateIso: string, start: MonthCursor): number {
  const c = cursorFromIso(dateIso);
  return (c.year - start.year) * 12 + (c.month0 - start.month0);
}

/** YYYY-MM key of the month at `index` months after the cursor. */
export function monthKeyAt(start: MonthCursor, index: number): string {
  const total = start.year * 12 + start.month0 + index;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Calendar year containing the month at `index` months after the cursor. */
function calendarYearAt(start: MonthCursor, index: number): number {
  return Math.floor((start.year * 12 + start.month0 + index) / 12);
}

/** Tax-engine rule year for a calendar year (rules clamp to supported years). */
export function toTaxYear(calendarYear: number): TaxYear {
  if (calendarYear <= 2024) return 2024;
  if (calendarYear === 2025) return 2025;
  return 2026;
}

/* ------------------------------------------------------------------ */
/* Amortization                                                        */
/* ------------------------------------------------------------------ */

/**
 * Standard fixed-payment amortization schedule.
 * payment = P·r / (1 − (1+r)^−n); zero-rate loans pay P/n.
 * The final month's principal is the remaining balance, so the schedule
 * always closes at exactly 0.
 */
export function computeLoanSchedule(
  principal: number,
  annualRatePct: number,
  termMonths: number,
): LoanSchedule {
  const n = Math.max(1, Math.round(termMonths));
  const p = Math.max(0, principal);
  const r = Math.max(0, annualRatePct) / 100 / 12;
  const payment = r > 0 ? (p * r) / (1 - Math.pow(1 + r, -n)) : p / n;

  const months: AmortizationMonth[] = new Array(n);
  let balance = p;
  let totalInterest = 0;
  for (let i = 0; i < n; i++) {
    const interest = balance * r;
    let principalPart = payment - interest;
    if (i === n - 1 || principalPart > balance) principalPart = balance;
    balance = Math.max(0, balance - principalPart);
    totalInterest += interest;
    months[i] = {
      monthIndex: i,
      payment: round2(interest + principalPart),
      interest: round2(interest),
      principal: round2(principalPart),
      balance: round2(balance),
    };
  }

  return {
    monthlyPayment: round2(payment),
    totalInterest: round2(totalInterest),
    months,
  };
}

/* ------------------------------------------------------------------ */
/* Delta resolution                                                    */
/* ------------------------------------------------------------------ */

export interface ResolvedDelta {
  delta: ScenarioDelta;
  /** Month index relative to the projection start, clamped to >= 0 */
  startIdx: number;
  /** Unclamped start index (one-time deltas in the past are skipped) */
  rawStartIdx: number;
  /** Inclusive end month index for recurring deltas; null = open-ended */
  endIdx: number | null;
  /** Amortization schedule for loan deltas */
  schedule: LoanSchedule | null;
}

export function resolveDeltas(scenario: Scenario, start: MonthCursor): ResolvedDelta[] {
  return scenario.deltas.map(delta => {
    const rawStartIdx = monthIndexOf(delta.startDate, start);
    const startIdx = Math.max(0, rawStartIdx);
    let endIdx: number | null = null;
    if (delta.kind === 'recurring' && delta.endDate) {
      endIdx = monthIndexOf(delta.endDate, start);
    }
    const schedule =
      delta.kind === 'loan'
        ? computeLoanSchedule(delta.principal, delta.annualRatePct, delta.termMonths)
        : null;
    return { delta, startIdx, rawStartIdx, endIdx, schedule };
  });
}

export type CashPerspective = 'liquid' | 'netWorth';

/**
 * Signed cash effect of one delta in month `m` (0-based from projection start).
 *
 * 'liquid' is take-home cash: a contribution change reduces it.
 * 'netWorth' treats a pre-tax deferral as a transfer into invested assets
 * (cash − / invested + cancel), so contribution changes contribute 0 there;
 * their net-worth effect is purely the tax savings, applied separately.
 */
export function deltaCashAt(rd: ResolvedDelta, m: number, perspective: CashPerspective): number {
  const d = rd.delta;
  switch (d.kind) {
    case 'one_time':
      return rd.rawStartIdx === m ? d.amount : 0;
    case 'recurring': {
      if (m < rd.startIdx) return 0;
      if (rd.endIdx !== null && m > rd.endIdx) return 0;
      const yearsElapsed = Math.floor((m - rd.startIdx) / 12);
      const g = (d.annualGrowthPct ?? 0) / 100;
      return d.monthlyAmount * Math.pow(1 + g, yearsElapsed);
    }
    case 'loan': {
      if (!rd.schedule) return 0;
      const k = m - rd.startIdx;
      if (k < 0 || k >= rd.schedule.months.length) return 0;
      return -rd.schedule.months[k].payment;
    }
    case 'asset':
      return 0; // value tracked separately; the cash outlay is a one-time/loan delta
    case 'income_change':
      return m >= rd.startIdx ? d.annualAmount / 12 : 0;
    case 'contribution_change':
      return perspective === 'liquid' && m >= rd.startIdx ? -d.annualAmount / 12 : 0;
  }
}

/** Sum of all delta cash effects in month m. */
function totalDeltaCashAt(resolved: ResolvedDelta[], m: number, perspective: CashPerspective): number {
  let sum = 0;
  for (const rd of resolved) sum += deltaCashAt(rd, m, perspective);
  return sum;
}

/** Does this delta change taxable income or deductions? */
function isTaxAffecting(d: ScenarioDelta): boolean {
  switch (d.kind) {
    case 'income_change':
    case 'contribution_change':
      return true;
    case 'loan':
      return d.interestDeductible === true;
    case 'recurring':
      return d.taxTreatment === 'property_tax' || d.taxTreatment === 'taxable_income';
    default:
      return false;
  }
}

/** First month index where any tax-affecting delta is active, or null. */
function firstTaxActiveMonth(resolved: ResolvedDelta[]): number | null {
  let first: number | null = null;
  for (const rd of resolved) {
    if (!isTaxAffecting(rd.delta)) continue;
    if (first === null || rd.startIdx < first) first = rd.startIdx;
  }
  return first;
}

/* ------------------------------------------------------------------ */
/* Tax composition                                                     */
/* ------------------------------------------------------------------ */

interface TaxDeltas {
  wages: number;
  contributions: number;
  mortgageInterest: number;
  salt: number;
  otherIncome: number;
}

/** Delta amounts landing in one calendar year (prorated by months active). */
function taxDeltasForCalendarYear(
  resolved: ResolvedDelta[],
  start: MonthCursor,
  calendarYear: number,
): TaxDeltas {
  const out: TaxDeltas = { wages: 0, contributions: 0, mortgageInterest: 0, salt: 0, otherIncome: 0 };
  // Month index of January of calendarYear, relative to the cursor
  const janIdx = (calendarYear - start.year) * 12 - start.month0;
  for (let m = Math.max(0, janIdx); m < janIdx + 12; m++) {
    if (m < 0) continue;
    if (calendarYearAt(start, m) !== calendarYear) continue;
    for (const rd of resolved) {
      const d = rd.delta;
      switch (d.kind) {
        case 'income_change':
          if (m >= rd.startIdx) out.wages += d.annualAmount / 12;
          break;
        case 'contribution_change':
          if (m >= rd.startIdx) out.contributions += d.annualAmount / 12;
          break;
        case 'recurring': {
          const amt = deltaCashAt(rd, m, 'liquid');
          if (d.taxTreatment === 'property_tax' && amt < 0) out.salt += -amt;
          else if (d.taxTreatment === 'taxable_income' && amt > 0) out.otherIncome += amt;
          break;
        }
        case 'loan': {
          if (d.interestDeductible === true && rd.schedule) {
            const k = m - rd.startIdx;
            if (k >= 0 && k < rd.schedule.months.length) {
              out.mortgageInterest += rd.schedule.months[k].interest;
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}

/** Steady-state (full annual rate) deltas, used for cash / NW / FIRE adjustments. */
function taxDeltasSteadyState(resolved: ResolvedDelta[]): TaxDeltas {
  const out: TaxDeltas = { wages: 0, contributions: 0, mortgageInterest: 0, salt: 0, otherIncome: 0 };
  for (const rd of resolved) {
    const d = rd.delta;
    switch (d.kind) {
      case 'income_change':
        out.wages += d.annualAmount;
        break;
      case 'contribution_change':
        out.contributions += d.annualAmount;
        break;
      case 'recurring':
        if (d.taxTreatment === 'property_tax' && d.monthlyAmount < 0) {
          out.salt += -d.monthlyAmount * 12;
        } else if (d.taxTreatment === 'taxable_income' && d.monthlyAmount > 0) {
          out.otherIncome += d.monthlyAmount * 12;
        }
        break;
      case 'loan':
        if (d.interestDeductible === true && rd.schedule) {
          // First 12 months of interest ≈ the near-term annual deduction
          out.mortgageInterest += rd.schedule.months
            .slice(0, 12)
            .reduce((sum, row) => sum + row.interest, 0);
        }
        break;
      default:
        break;
    }
  }
  return out;
}

function applyTaxDeltas(base: FederalTaxInputs, deltas: TaxDeltas, year: TaxYear): FederalTaxInputs {
  return {
    ...base,
    year,
    wages: Math.max(0, base.wages + deltas.wages),
    traditional401kContributions: Math.max(0, base.traditional401kContributions + deltas.contributions),
    mortgageInterest: Math.max(0, base.mortgageInterest + deltas.mortgageInterest),
    stateLocalTaxesPaid: Math.max(0, base.stateLocalTaxesPaid + deltas.salt),
    otherIncome: base.otherIncome + deltas.otherIncome,
  };
}

interface TaxTotals {
  federal: FederalTaxResult;
  stateTax: number;
  total: number;
}

function computeTotals(
  inputs: FederalTaxInputs,
  state: string,
  stateFlatRatePct: number,
): TaxTotals {
  const federal = computeFederalTax(inputs);
  const stateResult = computeStateTax(state, {
    year: inputs.year,
    filingStatus: inputs.filingStatus,
    federalAgi: federal.agi,
    flatRateOverride: state === 'OTHER' ? stateFlatRatePct / 100 : undefined,
  });
  return { federal, stateTax: stateResult.tax, total: federal.totalTax + stateResult.tax };
}

function toTaxSide(t: TaxTotals): TaxSide {
  return {
    federalTax: round2(t.federal.totalTax),
    stateTax: round2(t.stateTax),
    total: round2(t.total),
    agi: round2(t.federal.agi),
    taxableIncome: round2(t.federal.taxableIncome),
    marginalRate: t.federal.marginalRate,
    effectiveRate: t.federal.effectiveRate,
    usedItemized: t.federal.usedItemized,
    itemizedDeduction: round2(t.federal.itemizedDeduction),
    standardDeduction: round2(t.federal.standardDeduction),
    deductionTaken: round2(t.federal.deductionTaken),
  };
}

/**
 * Compare baseline vs scenario for one calendar year through the federal +
 * state engines. The federal engine computes BOTH the itemized and standard
 * deduction and takes the larger; both are surfaced in `itemizeDecision`.
 */
export function compareTaxYear(
  baselineInputs: FederalTaxInputs,
  resolved: ResolvedDelta[],
  start: MonthCursor,
  calendarYear: number,
  state: string,
  stateFlatRatePct: number,
): TaxYearComparison {
  const taxYear = toTaxYear(calendarYear);
  const deltas = taxDeltasForCalendarYear(resolved, start, calendarYear);
  const scenarioInputs = applyTaxDeltas(baselineInputs, deltas, taxYear);
  const baseTotals = computeTotals({ ...baselineInputs, year: taxYear }, state, stateFlatRatePct);
  const scenarioTotals = computeTotals(scenarioInputs, state, stateFlatRatePct);
  const scenarioSide = toTaxSide(scenarioTotals);
  return {
    calendarYear,
    taxYear,
    baseline: toTaxSide(baseTotals),
    scenario: scenarioSide,
    delta: round2(scenarioTotals.total - baseTotals.total),
    itemizeDecision: {
      itemized: scenarioSide.itemizedDeduction,
      standard: scenarioSide.standardDeduction,
      picked: scenarioSide.usedItemized ? 'itemized' : 'standard',
      advantage: round2(scenarioSide.itemizedDeduction - scenarioSide.standardDeduction),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cash flow projection                                                */
/* ------------------------------------------------------------------ */

export interface CashFlowOptions {
  baseline: ScenarioBaseline;
  resolved: ResolvedDelta[];
  start: MonthCursor;
  months: number;
  /** Steady-state annual tax delta (positive = scenario owes more) */
  annualTaxDelta: number;
  /** Month index the tax delta starts applying, or null when no tax effect */
  taxStartIdx: number | null;
}

export function runCashFlowProjection(opts: CashFlowOptions): CashFlowProjection {
  const { baseline, resolved, start, months, annualTaxDelta, taxStartIdx } = opts;
  const monthlyTaxDelta = annualTaxDelta / 12;

  const points: CashFlowMonthPoint[] = [];
  const negativeMonths: string[] = [];
  let baselineGoesNegative = false;
  let baselineBalance = baseline.liquidBalance;
  let scenarioBalance = baseline.liquidBalance;

  for (let m = 0; m < months; m++) {
    const key = monthKeyAt(start, m);
    const baselineNet = baseline.monthlyNet;
    const taxAdj = taxStartIdx !== null && m >= taxStartIdx ? -monthlyTaxDelta : 0;
    const scenarioNet = baselineNet + totalDeltaCashAt(resolved, m, 'liquid') + taxAdj;

    baselineBalance += baselineNet;
    scenarioBalance += scenarioNet;

    if (scenarioBalance < 0) negativeMonths.push(key);
    if (baselineBalance < 0) baselineGoesNegative = true;

    points.push({
      month: key,
      baselineNet: round2(baselineNet),
      scenarioNet: round2(scenarioNet),
      baselineBalance: round2(baselineBalance),
      scenarioBalance: round2(scenarioBalance),
    });
  }

  return {
    months: points,
    negativeMonths,
    firstNegativeMonth: negativeMonths.length > 0 ? negativeMonths[0] : null,
    baselineGoesNegative,
    monthlyTaxDelta: round2(monthlyTaxDelta),
  };
}

/* ------------------------------------------------------------------ */
/* Net worth projection                                                */
/* ------------------------------------------------------------------ */

export interface NetWorthOptions {
  baseline: ScenarioBaseline;
  resolved: ResolvedDelta[];
  start: MonthCursor;
  years: number;
  investedReturnPct: number;
  annualTaxDelta: number;
  taxStartIdx: number | null;
}

/**
 * Deterministic annual net-worth projection.
 *
 * Model: invested assets grow at the configured return; all savings
 * (baseline monthly net + scenario cash deltas) are added to the invested
 * pool at the end of each year; the non-invested remainder of net worth is
 * held flat. Scenario adds purchased-asset values (appreciating from the
 * purchase month) and subtracts remaining loan balances. Loan proceeds are
 * not a cash inflow (they finance a purchase directly), so pair a loan with
 * an asset delta for the financed item — the pair's long-run net-worth cost
 * is then exactly the loan's interest.
 */
export function runNetWorthProjection(opts: NetWorthOptions): NetWorthProjection {
  const { baseline, resolved, start, years, investedReturnPct, annualTaxDelta, taxStartIdx } = opts;
  const r = investedReturnPct / 100;
  const monthlyTaxDelta = annualTaxDelta / 12;
  const annualSavings = baseline.monthlyNet * 12;
  const other = baseline.netWorth - baseline.investedAssets;

  let investedBaseline = baseline.investedAssets;
  let investedScenario = baseline.investedAssets;

  const points: NetWorthYearPoint[] = [
    {
      yearIndex: 0,
      year: start.year,
      baseline: round2(baseline.netWorth),
      scenario: round2(baseline.netWorth),
      scenarioAssetValue: 0,
      scenarioLoanBalance: 0,
    },
  ];

  for (let y = 1; y <= years; y++) {
    investedBaseline = investedBaseline * (1 + r) + annualSavings;

    let yearDelta = 0;
    for (let m = (y - 1) * 12; m < y * 12; m++) {
      yearDelta += totalDeltaCashAt(resolved, m, 'netWorth');
      if (taxStartIdx !== null && m >= taxStartIdx) yearDelta -= monthlyTaxDelta;
    }
    investedScenario = investedScenario * (1 + r) + annualSavings + yearDelta;

    const endMonth = y * 12; // months elapsed at the end of projection year y
    let assetValue = 0;
    let loanBalance = 0;
    for (const rd of resolved) {
      const d = rd.delta;
      if (d.kind === 'asset') {
        const monthsHeld = endMonth - rd.startIdx;
        if (monthsHeld > 0) {
          const a = (d.annualAppreciationPct ?? 0) / 100;
          assetValue += d.value * Math.pow(1 + a, monthsHeld / 12);
        }
      } else if (d.kind === 'loan' && rd.schedule) {
        const paymentsMade = endMonth - rd.startIdx;
        if (paymentsMade <= 0) {
          // Not originated yet within the projection
        } else if (paymentsMade >= rd.schedule.months.length) {
          loanBalance += 0;
        } else {
          loanBalance += rd.schedule.months[paymentsMade - 1].balance;
        }
      }
    }

    points.push({
      yearIndex: y,
      year: start.year + y,
      baseline: round2(investedBaseline + other),
      scenario: round2(investedScenario + other + assetValue - loanBalance),
      scenarioAssetValue: round2(assetValue),
      scenarioLoanBalance: round2(loanBalance),
    });
  }

  const last = points[points.length - 1];
  return {
    points,
    endingBaseline: last.baseline,
    endingScenario: last.scenario,
    endingDelta: round2(last.scenario - last.baseline),
  };
}

/* ------------------------------------------------------------------ */
/* FIRE impact                                                         */
/* ------------------------------------------------------------------ */

export interface FireOptions {
  baseline: ScenarioBaseline;
  resolved: ResolvedDelta[];
  start: MonthCursor;
  realReturnPct: number;
  swrPct: number;
  annualTaxDelta: number;
  taxStartIdx: number | null;
}

/**
 * Deterministic FIRE projection (labeled as such — no Monte Carlo).
 *
 * FI number = annual retirement expenses / SWR, in today's dollars. The
 * invested portfolio grows at the configured REAL return; each year's
 * contribution is the baseline annual savings plus that year's scenario
 * cash deltas (including one-time flows, loan payments while active, and
 * the steady-state tax delta). Retirement spending is adjusted only by
 * OPEN-ENDED recurring deltas (finite-term items like loan payments affect
 * accumulation but are assumed finished by retirement).
 */
export function runFireImpact(opts: FireOptions): FireImpact {
  const { baseline, resolved, start, realReturnPct, swrPct, annualTaxDelta, taxStartIdx } = opts;
  const r = realReturnPct / 100;
  const monthlyTaxDelta = annualTaxDelta / 12;
  const annualSavings = baseline.monthlyNet * 12;
  const annualExpensesBaseline = Math.max(0, baseline.monthlyExpenses * 12);

  // Open-ended recurring deltas shift retirement spending (initial amounts,
  // today's dollars): a persistent -$500/mo expense raises annual spending
  // by $6,000; persistent income lowers it.
  let openEndedMonthly = 0;
  for (const rd of resolved) {
    if (rd.delta.kind === 'recurring' && rd.endIdx === null) {
      openEndedMonthly += rd.delta.monthlyAmount;
    }
  }
  const annualExpensesScenario = Math.max(0, annualExpensesBaseline - openEndedMonthly * 12);

  const swr = swrPct / 100;
  const fiNumberBaseline = swr > 0 ? annualExpensesBaseline / swr : Infinity;
  const fiNumberScenario = swr > 0 ? annualExpensesScenario / swr : Infinity;

  const yearsToFi = (fiNumber: number, withDeltas: boolean): number | null => {
    if (fiNumber <= 0) return 0;
    let portfolio = baseline.investedAssets;
    if (portfolio >= fiNumber) return 0;
    for (let y = 1; y <= FIRE_HORIZON_YEARS; y++) {
      let contribution = annualSavings;
      if (withDeltas) {
        for (let m = (y - 1) * 12; m < y * 12; m++) {
          contribution += totalDeltaCashAt(resolved, m, 'liquid');
          if (taxStartIdx !== null && m >= taxStartIdx) contribution -= monthlyTaxDelta;
        }
      }
      portfolio = portfolio * (1 + r) + contribution;
      if (portfolio >= fiNumber) return y;
    }
    return null;
  };

  const baselineYears = yearsToFi(fiNumberBaseline, false);
  const scenarioYears = yearsToFi(fiNumberScenario, true);

  return {
    method: 'deterministic',
    fiNumberBaseline: round2(fiNumberBaseline),
    fiNumberScenario: round2(fiNumberScenario),
    annualExpensesBaseline: round2(annualExpensesBaseline),
    annualExpensesScenario: round2(annualExpensesScenario),
    baselineYearsToFi: baselineYears,
    scenarioYearsToFi: scenarioYears,
    baselineFiYear: baselineYears !== null ? start.year + baselineYears : null,
    scenarioFiYear: scenarioYears !== null ? start.year + scenarioYears : null,
    baselineFiAge:
      baselineYears !== null && baseline.currentAge !== null
        ? baseline.currentAge + baselineYears
        : null,
    scenarioFiAge:
      scenarioYears !== null && baseline.currentAge !== null
        ? baseline.currentAge + scenarioYears
        : null,
    shiftYears:
      baselineYears !== null && scenarioYears !== null ? scenarioYears - baselineYears : null,
  };
}

/* ------------------------------------------------------------------ */
/* Top-level orchestration                                             */
/* ------------------------------------------------------------------ */

export function runScenario(
  baseline: ScenarioBaseline,
  scenario: Scenario,
  partialAssumptions?: Partial<ScenarioAssumptions> | null,
): ScenarioRunResult {
  const assumptions = mergeScenarioAssumptions(partialAssumptions);
  const start = cursorFromIso(baseline.asOfDate);
  const resolved = resolveDeltas(scenario, start);
  const taxStartIdx = firstTaxActiveMonth(resolved);

  /* --- Taxes: current year, next year, and steady state --- */
  const taxCurrent = compareTaxYear(
    baseline.federalInputsCurrentYear,
    resolved,
    start,
    start.year,
    baseline.state,
    baseline.stateFlatRatePct,
  );
  const taxNext = compareTaxYear(
    baseline.federalInputsNextYear,
    resolved,
    start,
    start.year + 1,
    baseline.state,
    baseline.stateFlatRatePct,
  );

  // Steady state: all tax-affecting deltas at their full annual rate, under
  // next-year rules — this is the tax adjustment while deltas are active,
  // spread monthly across the cash-flow / net-worth / FIRE projections.
  const steadyDeltas = taxDeltasSteadyState(resolved);
  const steadyBaseInputs = { ...baseline.federalInputsNextYear, year: baseline.nextTaxYear };
  const steadyScenarioInputs = applyTaxDeltas(steadyBaseInputs, steadyDeltas, baseline.nextTaxYear);
  const steadyBaseTotals = computeTotals(steadyBaseInputs, baseline.state, baseline.stateFlatRatePct);
  const steadyScenarioTotals = computeTotals(
    steadyScenarioInputs,
    baseline.state,
    baseline.stateFlatRatePct,
  );
  const annualTaxDelta =
    taxStartIdx !== null ? steadyScenarioTotals.total - steadyBaseTotals.total : 0;

  /* --- Projections --- */
  const cashFlow = runCashFlowProjection({
    baseline,
    resolved,
    start,
    months: assumptions.cashFlowMonths,
    annualTaxDelta,
    taxStartIdx,
  });

  const netWorth = runNetWorthProjection({
    baseline,
    resolved,
    start,
    years: assumptions.netWorthYears,
    investedReturnPct: assumptions.investedReturnPct,
    annualTaxDelta,
    taxStartIdx,
  });

  const fire = runFireImpact({
    baseline,
    resolved,
    start,
    realReturnPct: assumptions.fireRealReturnPct,
    swrPct: assumptions.swrPct,
    annualTaxDelta,
    taxStartIdx,
  });

  /* --- Loan summaries --- */
  const loans: LoanSummary[] = [];
  for (const rd of resolved) {
    if (rd.delta.kind !== 'loan' || !rd.schedule) continue;
    loans.push({
      id: rd.delta.id,
      label: rd.delta.label,
      principal: round2(rd.delta.principal),
      annualRatePct: rd.delta.annualRatePct,
      termMonths: rd.delta.termMonths,
      monthlyPayment: rd.schedule.monthlyPayment,
      totalInterest: rd.schedule.totalInterest,
      firstYearInterest: round2(
        rd.schedule.months.slice(0, 12).reduce((sum, row) => sum + row.interest, 0),
      ),
    });
  }

  const notes: string[] = [
    'Deterministic model — no Monte Carlo. Every projection is a single path from fixed assumptions.',
    `Cash flow: baseline is the trailing-12-month average monthly net (${fmtUsd(baseline.monthlyNet)}/mo), held flat; scheduled transactions are already reflected in that history. Scenario deltas (including amortized loan payments) are applied on top.`,
    `Net worth: invested assets grow at ${assumptions.investedReturnPct}%/yr nominal; all savings are added to the invested pool at year end; the non-invested remainder of net worth is held flat. Loans cost exactly their interest in net-worth terms; purchased assets appreciate from the purchase month.`,
    `Taxes: annual federal + state via the built-in tax engine (${baseline.currentTaxYear} rules for the current year, ${baseline.nextTaxYear} rules beyond — later years are NOT inflation-indexed). Itemized vs standard deduction is computed both ways and the better one is taken. The steady-state tax delta (full-year rates, first-year loan interest) is spread monthly across the projections from the first month a tax-affecting delta is active.`,
    `FIRE: deterministic years-to-FI at a ${assumptions.fireRealReturnPct}% real return and ${assumptions.swrPct}% SWR. Retirement spending shifts only from open-ended recurring deltas; finite-term items (loan payments) affect accumulation but are assumed finished by retirement. Purchased assets are non-liquid and excluded from the FI portfolio.`,
    'Income and contribution changes are modeled pre-tax in gross dollars; their tax effect flows through the tax engine, not a flat rate. Estimates only — not tax, legal, or investment advice.',
  ];

  return {
    scenarioName: scenario.name,
    assumptions,
    cashFlow,
    netWorth,
    tax: {
      currentYear: taxCurrent,
      nextYear: taxNext,
      steadyStateAnnualDelta: round2(annualTaxDelta),
    },
    fire,
    loans,
    notes,
  };
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
