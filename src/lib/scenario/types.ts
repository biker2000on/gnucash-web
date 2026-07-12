/**
 * Scenario Sandbox — shared types.
 *
 * A Scenario is a named list of financial "deltas" (what-if changes), each
 * starting at a date: one-time cash flows, new recurring income/expenses,
 * new loans, asset purchases, salary changes, and pre-tax retirement
 * deferral changes. The pure composition engine in ./engine.ts threads one
 * scenario through the app's existing engines — cash-flow run rate,
 * a deterministic net-worth projection, the federal+state tax engine, and a
 * deterministic FIRE projection — side by side with the baseline.
 *
 * Scenarios persist per user under the SCENARIO_PREF_KEY preference key via
 * the generic /api/user/preferences PUT pattern (same as other tool params).
 */

import type {
  FederalTaxInputs,
  FilingStatus,
  TaxYear,
} from '@/lib/tax/types';

/* ------------------------------------------------------------------ */
/* Deltas                                                              */
/* ------------------------------------------------------------------ */

export const SCENARIO_DELTA_KINDS = [
  'one_time',
  'recurring',
  'loan',
  'asset',
  'income_change',
  'contribution_change',
] as const;

export type ScenarioDeltaKind = (typeof SCENARIO_DELTA_KINDS)[number];

export const DELTA_KIND_LABELS: Record<ScenarioDeltaKind, string> = {
  one_time: 'One-time cash flow',
  recurring: 'Recurring income/expense',
  loan: 'New loan',
  asset: 'Asset purchase',
  income_change: 'Income change',
  contribution_change: 'Retirement contribution change',
};

interface ScenarioDeltaBase {
  id: string;
  kind: ScenarioDeltaKind;
  label: string;
  /** YYYY-MM-DD — effects begin in this calendar month */
  startDate: string;
}

/** One-time cash flow. Signed: positive = inflow (windfall), negative = outflow (down payment). */
export interface OneTimeDelta extends ScenarioDeltaBase {
  kind: 'one_time';
  amount: number;
}

/** Recurring tax treatments the composition engine understands. */
export type RecurringTaxTreatment = 'none' | 'property_tax' | 'taxable_income';

/** New recurring flow. Signed monthly amount: positive = income, negative = expense. */
export interface RecurringDelta extends ScenarioDeltaBase {
  kind: 'recurring';
  monthlyAmount: number;
  /** Optional annual growth percent, compounded every 12 months after start */
  annualGrowthPct?: number;
  /** Optional end date (YYYY-MM-DD, inclusive month); null/undefined = open-ended */
  endDate?: string | null;
  /**
   * 'property_tax': an expense that feeds the SALT itemized deduction.
   * 'taxable_income': income taxed as ordinary other income.
   * 'none' (default): no tax effect.
   */
  taxTreatment?: RecurringTaxTreatment;
}

/**
 * New loan. Payment via standard amortization: P·r / (1 − (1+r)^−n).
 * The principal is NOT modeled as a cash inflow (it finances a purchase);
 * the monthly payment is a cash outflow for the term, and the declining
 * balance is a liability in the net-worth projection.
 */
export interface LoanDelta extends ScenarioDeltaBase {
  kind: 'loan';
  principal: number;
  annualRatePct: number;
  termMonths: number;
  /** When true, the interest portion feeds the mortgage-interest itemized deduction */
  interestDeductible?: boolean;
}

/** Asset purchase: adds a non-liquid asset value with optional appreciation. */
export interface AssetPurchaseDelta extends ScenarioDeltaBase {
  kind: 'asset';
  value: number;
  /** Annual appreciation percent (compounded monthly-fractionally) */
  annualAppreciationPct?: number;
}

/** Gross salary change (annual, signed). Taxed as W-2 wages. */
export interface IncomeChangeDelta extends ScenarioDeltaBase {
  kind: 'income_change';
  annualAmount: number;
}

/**
 * Pre-tax (traditional) retirement deferral change (annual, signed).
 * Positive = defer more: reduces taxable income AND take-home cash; the
 * deferred dollars land in invested assets (a transfer, not an expense).
 */
export interface ContributionChangeDelta extends ScenarioDeltaBase {
  kind: 'contribution_change';
  annualAmount: number;
}

export type ScenarioDelta =
  | OneTimeDelta
  | RecurringDelta
  | LoanDelta
  | AssetPurchaseDelta
  | IncomeChangeDelta
  | ContributionChangeDelta;

export interface Scenario {
  name: string;
  deltas: ScenarioDelta[];
}

/* ------------------------------------------------------------------ */
/* Assumptions (user-tunable model parameters)                         */
/* ------------------------------------------------------------------ */

export interface ScenarioAssumptions {
  /** Cash-flow projection horizon in months (default 60 = 5 years) */
  cashFlowMonths: number;
  /** Net-worth projection horizon in years (default 30) */
  netWorthYears: number;
  /** Nominal annual return on invested assets for the net-worth projection, percent */
  investedReturnPct: number;
  /** Real annual return for the deterministic FIRE projection, percent */
  fireRealReturnPct: number;
  /** Safe withdrawal rate for the FI number, percent */
  swrPct: number;
}

export const DEFAULT_SCENARIO_ASSUMPTIONS: ScenarioAssumptions = {
  cashFlowMonths: 60,
  netWorthYears: 30,
  investedReturnPct: 6,
  fireRealReturnPct: 5,
  swrPct: 4,
};

/** Merge a possibly-partial persisted assumption object with defaults, clamped sane. */
export function mergeScenarioAssumptions(
  partial: Partial<ScenarioAssumptions> | undefined | null,
): ScenarioAssumptions {
  const merged = { ...DEFAULT_SCENARIO_ASSUMPTIONS, ...(partial ?? {}) };
  merged.cashFlowMonths = clamp(Math.round(merged.cashFlowMonths), 12, 120);
  merged.netWorthYears = clamp(Math.round(merged.netWorthYears), 5, 50);
  merged.investedReturnPct = clamp(merged.investedReturnPct, -5, 20);
  merged.fireRealReturnPct = clamp(merged.fireRealReturnPct, -5, 15);
  merged.swrPct = clamp(merged.swrPct, 1, 10);
  return merged;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/* ------------------------------------------------------------------ */
/* Baseline (prefilled from the book — DB loaders live in data.ts)     */
/* ------------------------------------------------------------------ */

export interface ScenarioBaseline {
  /** YYYY-MM-DD; the projection starts in this calendar month */
  asOfDate: string;
  /** Current net worth (assets + investments at market + liabilities) */
  netWorth: number;
  /** Current BANK + CASH balance (the cushion for negative-month detection) */
  liquidBalance: number;
  /** STOCK/MUTUAL holdings at latest price (the FIRE / growth portfolio) */
  investedAssets: number;
  /** Trailing-12-month average monthly income */
  monthlyIncome: number;
  /** Trailing-12-month average monthly expenses */
  monthlyExpenses: number;
  /** monthlyIncome − monthlyExpenses */
  monthlyNet: number;
  /** Trailing-12-month savings rate, percent */
  savingsRatePct: number;
  filingStatus: FilingStatus;
  /** State code for the state tax module ('OTHER' uses the flat-rate override) */
  state: string;
  stateFlatRatePct: number;
  /** Birthday-derived age, when the preference is set */
  currentAge: number | null;
  /** Tax-engine year applied to the current calendar year (clamped to supported years) */
  currentTaxYear: TaxYear;
  /** Tax-engine year applied to next calendar year (clamped to supported years) */
  nextTaxYear: TaxYear;
  /** Annualized federal inputs built from the book for the current year */
  federalInputsCurrentYear: FederalTaxInputs;
  /** Same flows applied at next year's rules (income assumed flat) */
  federalInputsNextYear: FederalTaxInputs;
}

/* ------------------------------------------------------------------ */
/* Engine results                                                      */
/* ------------------------------------------------------------------ */

export interface AmortizationMonth {
  /** 0-based month within the loan */
  monthIndex: number;
  payment: number;
  interest: number;
  principal: number;
  /** Remaining balance after this payment */
  balance: number;
}

export interface LoanSchedule {
  monthlyPayment: number;
  totalInterest: number;
  months: AmortizationMonth[];
}

export interface CashFlowMonthPoint {
  /** YYYY-MM */
  month: string;
  baselineNet: number;
  scenarioNet: number;
  baselineBalance: number;
  scenarioBalance: number;
}

export interface CashFlowProjection {
  months: CashFlowMonthPoint[];
  /** YYYY-MM months where the scenario liquid balance is below zero */
  negativeMonths: string[];
  firstNegativeMonth: string | null;
  /** True when the baseline itself dips below zero within the horizon */
  baselineGoesNegative: boolean;
  /** Steady-state annual tax delta spread across months (signed; positive = more tax) */
  monthlyTaxDelta: number;
}

export interface NetWorthYearPoint {
  yearIndex: number;
  /** Calendar year */
  year: number;
  baseline: number;
  scenario: number;
  /** Scenario-only components, for the tooltip */
  scenarioAssetValue: number;
  scenarioLoanBalance: number;
}

export interface NetWorthProjection {
  points: NetWorthYearPoint[];
  endingBaseline: number;
  endingScenario: number;
  endingDelta: number;
}

export interface TaxSide {
  federalTax: number;
  stateTax: number;
  total: number;
  agi: number;
  taxableIncome: number;
  marginalRate: number;
  effectiveRate: number;
  usedItemized: boolean;
  itemizedDeduction: number;
  standardDeduction: number;
  deductionTaken: number;
}

export interface TaxYearComparison {
  /** Calendar year being modeled */
  calendarYear: number;
  /** Tax-engine rule year used (clamped to supported years) */
  taxYear: TaxYear;
  baseline: TaxSide;
  scenario: TaxSide;
  /** scenario.total − baseline.total (positive = scenario owes more) */
  delta: number;
  /** Itemize-vs-standard, computed both ways for the scenario */
  itemizeDecision: {
    itemized: number;
    standard: number;
    picked: 'itemized' | 'standard';
    /** itemized − standard (positive = itemizing wins) */
    advantage: number;
  };
}

export interface FireImpact {
  method: 'deterministic';
  fiNumberBaseline: number;
  fiNumberScenario: number;
  annualExpensesBaseline: number;
  annualExpensesScenario: number;
  /** Years from now until the FI number is reached; null = not within 60 years */
  baselineYearsToFi: number | null;
  scenarioYearsToFi: number | null;
  baselineFiYear: number | null;
  scenarioFiYear: number | null;
  baselineFiAge: number | null;
  scenarioFiAge: number | null;
  /** scenarioYears − baselineYears (positive = FI pushed later); null when either side never reaches FI */
  shiftYears: number | null;
}

export interface LoanSummary {
  id: string;
  label: string;
  principal: number;
  annualRatePct: number;
  termMonths: number;
  monthlyPayment: number;
  totalInterest: number;
  firstYearInterest: number;
}

export interface ScenarioRunResult {
  scenarioName: string;
  assumptions: ScenarioAssumptions;
  cashFlow: CashFlowProjection;
  netWorth: NetWorthProjection;
  tax: {
    currentYear: TaxYearComparison;
    nextYear: TaxYearComparison;
    /** Steady-state (full-year deltas) annual tax change used for cash/NW/FIRE adjustments */
    steadyStateAnnualDelta: number;
  };
  fire: FireImpact;
  loans: LoanSummary[];
  /** Model documentation: what is deterministic / simplified */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

/** User-preference key holding the saved-scenario list (JSON array). */
export const SCENARIO_PREF_KEY = 'scenario_sandbox.saved.v1';

export interface SavedScenario {
  scenario: Scenario;
  assumptions?: Partial<ScenarioAssumptions>;
  savedAt: string;
}

/* ------------------------------------------------------------------ */
/* Normalization (shared by API + client)                              */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function dateStr(v: unknown, fallback: string): string {
  const s = str(v, '');
  return DATE_RE.test(s) ? s : fallback;
}

/**
 * Sanitize an untrusted scenario payload into a well-formed Scenario.
 * Unknown delta kinds are dropped; malformed numbers become 0.
 */
export function normalizeScenario(raw: unknown, todayIso: string): Scenario {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const name = str(obj.name, 'Untitled scenario').slice(0, 120);
  const rawDeltas = Array.isArray(obj.deltas) ? obj.deltas : [];
  const deltas: ScenarioDelta[] = [];

  for (const rawDelta of rawDeltas.slice(0, 50)) {
    const d = (rawDelta ?? {}) as Record<string, unknown>;
    const kind = str(d.kind, '');
    if (!(SCENARIO_DELTA_KINDS as readonly string[]).includes(kind)) continue;
    const base = {
      id: str(d.id, `d${deltas.length}`).slice(0, 40),
      label: str(d.label, DELTA_KIND_LABELS[kind as ScenarioDeltaKind]).slice(0, 120),
      startDate: dateStr(d.startDate, todayIso),
    };
    switch (kind as ScenarioDeltaKind) {
      case 'one_time':
        deltas.push({ ...base, kind: 'one_time', amount: num(d.amount) });
        break;
      case 'recurring': {
        const tt = str(d.taxTreatment, 'none');
        deltas.push({
          ...base,
          kind: 'recurring',
          monthlyAmount: num(d.monthlyAmount),
          annualGrowthPct: num(d.annualGrowthPct),
          endDate: DATE_RE.test(str(d.endDate, '')) ? str(d.endDate) : null,
          taxTreatment: tt === 'property_tax' || tt === 'taxable_income' ? tt : 'none',
        });
        break;
      }
      case 'loan':
        deltas.push({
          ...base,
          kind: 'loan',
          principal: Math.max(0, num(d.principal)),
          annualRatePct: Math.max(0, num(d.annualRatePct)),
          termMonths: Math.min(600, Math.max(1, Math.round(num(d.termMonths, 360)))),
          interestDeductible: d.interestDeductible === true,
        });
        break;
      case 'asset':
        deltas.push({
          ...base,
          kind: 'asset',
          value: Math.max(0, num(d.value)),
          annualAppreciationPct: num(d.annualAppreciationPct),
        });
        break;
      case 'income_change':
        deltas.push({ ...base, kind: 'income_change', annualAmount: num(d.annualAmount) });
        break;
      case 'contribution_change':
        deltas.push({ ...base, kind: 'contribution_change', annualAmount: num(d.annualAmount) });
        break;
    }
  }

  return { name, deltas };
}
