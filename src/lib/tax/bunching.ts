/**
 * Charitable bunching comparison — pure functions, no I/O.
 *
 * Strategy A ("give yearly"): donate the same amount every year and take
 * whichever is larger each year — itemized (other deductions + gift) or the
 * standard deduction.
 *
 * Strategy B ("bunch"): concentrate N years of giving into year 1 (directly
 * or via a donor-advised fund), itemize that year, then take the standard
 * deduction in the remaining years.
 *
 * Simplifications (surfaced in the tool's assumptions panel):
 * - Constant marginal rate: tax saved = marginal rate x deductions in excess
 *   of the standard deduction. No bracket-crossing effects.
 * - Standard deduction and other itemizables are held constant across years.
 * - AGI-based charitable limits (60%/30%) are not modeled.
 * - Federal only; state itemization rules are not modeled.
 */

export interface BunchingInputs {
  /** Amount given per year under the yearly strategy (>= 0). */
  annualGiving: number;
  /** Years of giving concentrated into year 1 (also the comparison horizon). */
  bunchYears: number;
  /** Other itemizable deductions per year: capped SALT + mortgage interest. */
  otherItemizable: number;
  /** Standard deduction for the filing status (held constant). */
  standardDeduction: number;
  /** Marginal ordinary income tax rate (decimal, e.g. 0.24). */
  marginalRate: number;
}

export interface BunchingYear {
  /** 1-based year index within the horizon. */
  year: number;
  /** Charitable giving deducted this year. */
  giving: number;
  /** otherItemizable + giving. */
  itemizedTotal: number;
  /** max(itemizedTotal, standardDeduction). */
  deductionTaken: number;
  /** True when itemizing beats the standard deduction. */
  itemized: boolean;
}

export interface BunchingStrategyResult {
  years: BunchingYear[];
  totalDeductions: number;
  /** Deductions above the always-standard baseline over the horizon. */
  extraDeductionsVsStandard: number;
  /** marginalRate x extraDeductionsVsStandard. */
  taxSavingsVsStandard: number;
}

export interface BunchingComparison {
  horizon: number;
  totalGiving: number;
  yearly: BunchingStrategyResult;
  bunched: BunchingStrategyResult;
  /** Additional deductions unlocked by bunching (bunched - yearly). */
  extraDeductions: number;
  /** Additional tax saved by bunching over the horizon. */
  extraTaxSavings: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function buildStrategy(
  givingByYear: number[],
  otherItemizable: number,
  standardDeduction: number,
  marginalRate: number,
): BunchingStrategyResult {
  const years: BunchingYear[] = givingByYear.map((giving, i) => {
    const itemizedTotal = round2(otherItemizable + giving);
    const itemized = itemizedTotal > standardDeduction;
    return {
      year: i + 1,
      giving: round2(giving),
      itemizedTotal,
      deductionTaken: round2(Math.max(itemizedTotal, standardDeduction)),
      itemized,
    };
  });
  const totalDeductions = round2(years.reduce((s, y) => s + y.deductionTaken, 0));
  const extra = round2(totalDeductions - standardDeduction * years.length);
  return {
    years,
    totalDeductions,
    extraDeductionsVsStandard: extra,
    taxSavingsVsStandard: round2(extra * marginalRate),
  };
}

/**
 * Compare giving the same amount every year vs bunching the whole horizon's
 * giving into year 1. Total dollars donated are identical in both
 * strategies — only the deduction timing differs.
 */
export function compareBunching(inputs: BunchingInputs): BunchingComparison {
  const horizon = Math.max(1, Math.floor(inputs.bunchYears));
  const giving = Math.max(0, inputs.annualGiving);
  const other = Math.max(0, inputs.otherItemizable);
  const standard = Math.max(0, inputs.standardDeduction);
  const rate = Math.min(1, Math.max(0, inputs.marginalRate));

  const yearlyGiving = Array.from({ length: horizon }, () => giving);
  const bunchedGiving = Array.from({ length: horizon }, (_, i) =>
    i === 0 ? giving * horizon : 0,
  );

  const yearly = buildStrategy(yearlyGiving, other, standard, rate);
  const bunched = buildStrategy(bunchedGiving, other, standard, rate);

  return {
    horizon,
    totalGiving: round2(giving * horizon),
    yearly,
    bunched,
    extraDeductions: round2(bunched.totalDeductions - yearly.totalDeductions),
    extraTaxSavings: round2(bunched.taxSavingsVsStandard - yearly.taxSavingsVsStandard),
  };
}
