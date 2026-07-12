/**
 * Retirement Drawdown & Roth Conversion Planner — simulation engine.
 *
 * Pure functions, no I/O. Year loop:
 *   1. Compute the year's inflated spending need and Social Security.
 *   2. Force the RMD (SECURE 2.0 start ages, Uniform Lifetime Table) from
 *      the traditional bucket when applicable.
 *   3. Withdraw to cover spending + taxes using the configured sequencing
 *      (default taxable → traditional → Roth → HSA), iterating to a fixed
 *      point because withdrawals create taxable income which creates tax
 *      which requires more withdrawals.
 *   4. Optionally run a bracket-filling Roth conversion (retirement years
 *      before the RMD start age): convert traditional → Roth until ordinary
 *      taxable income reaches the top of the chosen federal bracket.
 *   5. Apply nominal growth per bucket; reinvest excess cash (e.g. RMD
 *      beyond spending) into the taxable bucket.
 *
 * Taxes use the existing engine in src/lib/tax. For years after 2026 the
 * model applies 2026 rules with all brackets/deductions/thresholds inflated
 * by the model's inflation rate — implemented by deflating incomes to 2026
 * dollars, computing tax, and inflating the result back. Taxable-account
 * withdrawals are split into long-term gain (taxableGainsFraction) and
 * untaxed basis. Roth and HSA withdrawals are assumed qualified/tax-free.
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { computeFederalTax, emptyFederalInputs, getYearStatusParams } from '@/lib/tax/federal';
import { computeStateTax } from '@/lib/tax/state';
import type { FederalTaxResult, FilingStatus, TaxYear } from '@/lib/tax/types';
import { computeRmd, rmdStartAge } from './rmd';
import { irmaaTierFor } from './irmaa';
import {
  DEFAULT_SEQUENCING,
  emptyBuckets,
  type Bucket,
  type BucketAmounts,
  type DrawdownComparison,
  type DrawdownInputs,
  type DrawdownResult,
  type DrawdownSummary,
  type DrawdownYearRow,
  type IrmaaFlag,
} from './types';

/** Tax rules are frozen at this year and inflation-indexed beyond it. */
export const BASE_TAX_YEAR: TaxYear = 2026;

/** Age from which IRMAA MAGI matters (two-year lookback before 65). */
const IRMAA_LOOKBACK_AGE = 63;

const round2 = (n: number) => Math.round(n * 100) / 100;

function taxYearFor(year: number): TaxYear {
  if (year <= 2024) return 2024;
  if (year === 2025) return 2025;
  return 2026;
}

/**
 * Headroom to the top of the target ordinary bracket (2026 dollars, in
 * TAXABLE-income space): bracket top minus ordinary taxable income already
 * present. Returns Infinity for the unbounded top bracket and 0 when the
 * bracket rate does not exist or income is already past the top.
 */
export function conversionHeadroom(
  targetBracketRate: number,
  filingStatus: FilingStatus,
  ordinaryTaxableIncome: number,
): number {
  const params = getYearStatusParams(BASE_TAX_YEAR, filingStatus);
  const bracket = params.brackets.find(b => b.rate === targetBracketRate);
  if (!bracket) return 0;
  if (!Number.isFinite(bracket.upTo)) return Number.POSITIVE_INFINITY;
  return Math.max(0, bracket.upTo - Math.max(0, ordinaryTaxableIncome));
}

/* ------------------------------------------------------------------ */
/* Single-year solver                                                  */
/* ------------------------------------------------------------------ */

interface YearContext {
  taxYear: TaxYear;
  /** (1 + inflation)^(year − 2026) for years past 2026, else 1. */
  deflator: number;
  filingStatus: FilingStatus;
  state: string;
  stateFlatRateOverride?: number;
  filersAge65Plus: number;
  gainsFraction: number;
  sequencing: readonly Bucket[];
}

interface YearSolution {
  withdrawals: BucketAmounts;
  shortfall: number;
  /** Federal result in 2026-deflated dollars. */
  federal: FederalTaxResult;
  federalTax: number;
  stateTax: number;
  totalTax: number;
  /** Cash left over (e.g. RMD beyond need) — reinvested in taxable. */
  excess: number;
}

/**
 * Solve one year's withdrawals + taxes to a fixed point for a GIVEN Roth
 * conversion amount. The RMD is always withdrawn first; remaining need is
 * covered in sequencing order. Traditional capacity is reduced by the
 * conversion (converted dollars cannot also be spent).
 */
function solveYear(
  ctx: YearContext,
  start: BucketAmounts,
  spendingNeed: number,
  ssBenefit: number,
  rmdAmount: number,
  conversion: number,
): YearSolution {
  let tax = 0;
  let solution: YearSolution | null = null;

  for (let iter = 0; iter < 40; iter++) {
    const withdrawals = emptyBuckets();
    const tradCapacity = Math.max(0, start.traditional - conversion);
    withdrawals.traditional = Math.min(rmdAmount, tradCapacity);

    const needAfterSs = Math.max(0, spendingNeed + tax - ssBenefit);
    let remaining = Math.max(0, needAfterSs - withdrawals.traditional);
    for (const bucket of ctx.sequencing) {
      if (remaining <= 0) break;
      const capacity = bucket === 'traditional' ? tradCapacity : start[bucket];
      const available = Math.max(0, capacity - withdrawals[bucket]);
      const take = Math.min(available, remaining);
      withdrawals[bucket] += take;
      remaining -= take;
    }
    const shortfall = remaining;

    const d = ctx.deflator;
    const fi = emptyFederalInputs(ctx.taxYear, ctx.filingStatus);
    fi.retirementIncome = (withdrawals.traditional + conversion) / d;
    fi.longTermCapitalGains = (withdrawals.taxable * ctx.gainsFraction) / d;
    fi.socialSecurityBenefits = ssBenefit / d;
    fi.filersAge65Plus = ctx.filersAge65Plus;
    const federal = computeFederalTax(fi);
    const state = computeStateTax(ctx.state, {
      year: ctx.taxYear,
      filingStatus: ctx.filingStatus,
      federalAgi: federal.agi,
      flatRateOverride: ctx.stateFlatRateOverride,
    });
    const federalTax = federal.totalTax * d;
    const stateTax = state.tax * d;
    const newTax = federalTax + stateTax;

    const totalWithdrawn =
      withdrawals.taxable + withdrawals.traditional + withdrawals.roth + withdrawals.hsa;
    const excess = Math.max(0, ssBenefit + totalWithdrawn - spendingNeed - newTax);

    solution = {
      withdrawals,
      shortfall,
      federal,
      federalTax,
      stateTax,
      totalTax: newTax,
      excess,
    };

    if (Math.abs(newTax - tax) < 0.5) break;
    tax = newTax;
  }

  // Loop body always assigns `solution` on the first iteration.
  return solution!;
}

/* ------------------------------------------------------------------ */
/* Main engine                                                         */
/* ------------------------------------------------------------------ */

export function runDrawdown(inputs: DrawdownInputs): DrawdownResult {
  const startYear = inputs.startYear ?? new Date().getFullYear();
  const gainsFraction = Math.min(1, Math.max(0, inputs.taxableGainsFraction ?? 0.5));
  const sequencing = inputs.sequencing ?? DEFAULT_SEQUENCING;
  const conversions = inputs.conversions ?? { enabled: false, targetBracketRate: 0.22 };
  const inflation = inputs.inflationRate;
  const birthYear = startYear - inputs.currentAge;
  const rmdAge = rmdStartAge(birthYear);
  const joint = inputs.filingStatus === 'mfj' || inputs.filingStatus === 'qss';

  let balances: BucketAmounts = { ...inputs.startingBalances };
  const rows: DrawdownYearRow[] = [];

  let lifetimeFederalTax = 0;
  let lifetimeStateTax = 0;
  let totalConversions = 0;
  let totalRmds = 0;
  let depletionAge: number | null = null;
  const irmaaAges: number[] = [];

  for (let age = inputs.currentAge; age <= inputs.endAge; age++) {
    const year = startYear + (age - inputs.currentAge);
    const yearsFromStart = year - startYear;
    const spouseAge = inputs.spouseAge != null ? inputs.spouseAge + yearsFromStart : null;
    const inflationFactor = Math.pow(1 + inflation, yearsFromStart);
    const taxYear = taxYearFor(year);
    const deflator = year > BASE_TAX_YEAR ? Math.pow(1 + inflation, year - BASE_TAX_YEAR) : 1;

    const retired = age >= inputs.retirementAge;
    const spendingNeed = retired ? inputs.annualSpending * inflationFactor : 0;
    const ss = inputs.socialSecurity;
    const ssBenefit =
      ss && ss.annualBenefit > 0 && age >= ss.startAge ? ss.annualBenefit * inflationFactor : 0;

    const rmdAmount = computeRmd(age, birthYear, balances.traditional);

    let filersAge65Plus = age >= 65 ? 1 : 0;
    if (joint && spouseAge !== null && spouseAge >= 65) filersAge65Plus += 1;

    const ctx: YearContext = {
      taxYear,
      deflator,
      filingStatus: inputs.filingStatus,
      state: inputs.state,
      stateFlatRateOverride: inputs.stateFlatRateOverride,
      filersAge65Plus,
      gainsFraction,
      sequencing,
    };

    /* --- Roth conversion: fill to the top of the target bracket --- */
    let conversion = 0;
    let solution = solveYear(ctx, balances, spendingNeed, ssBenefit, rmdAmount, 0);
    const conversionEligible =
      conversions.enabled && retired && age < rmdAge && balances.traditional > 0;
    if (conversionEligible) {
      const params = getYearStatusParams(BASE_TAX_YEAR, inputs.filingStatus);
      const bracket = params.brackets.find(b => b.rate === conversions.targetBracketRate);
      if (bracket) {
        for (let pass = 0; pass < 12; pass++) {
          const tradAvailable = Math.max(
            0,
            balances.traditional - solution.withdrawals.traditional,
          );
          let next: number;
          if (Number.isFinite(bracket.upTo)) {
            // Move toward the fixed point where ordinary taxable income
            // (including the conversion and its Social Security taxability
            // feedback) sits exactly at the bracket top.
            const gap = bracket.upTo - solution.federal.ordinaryTaxableIncome;
            next = conversion + gap * deflator;
          } else {
            next = tradAvailable; // unbounded top bracket: convert everything
          }
          next = Math.min(Math.max(0, next), tradAvailable);
          const converged = Math.abs(next - conversion) < 1;
          conversion = next;
          solution = solveYear(ctx, balances, spendingNeed, ssBenefit, rmdAmount, conversion);
          if (converged) break;
        }
      }
    }

    /* --- Apply growth --- */
    const start: BucketAmounts = { ...balances };
    const w = solution.withdrawals;
    const r = inputs.nominalReturns;
    const end: BucketAmounts = {
      taxable: Math.max(0, (start.taxable - w.taxable + solution.excess) * (1 + r.taxable)),
      traditional: Math.max(0, (start.traditional - w.traditional - conversion) * (1 + r.traditional)),
      roth: Math.max(0, (start.roth - w.roth + conversion) * (1 + r.roth)),
      hsa: Math.max(0, (start.hsa - w.hsa) * (1 + r.hsa)),
    };

    /* --- IRMAA (compare 2026-deflated MAGI to 2026 tiers) --- */
    const magiNominal = solution.federal.agi * deflator;
    let irmaa: IrmaaFlag | null = null;
    if (age >= IRMAA_LOOKBACK_AGE) {
      const flag = irmaaTierFor(solution.federal.agi, inputs.filingStatus);
      if (flag) {
        irmaa = {
          ...flag,
          monthlySurcharge: round2(flag.monthlySurcharge * deflator),
          annualSurcharge: round2(flag.annualSurcharge * deflator),
        };
        irmaaAges.push(age);
      }
    }

    if (depletionAge === null && solution.shortfall > 0.5) depletionAge = age;
    lifetimeFederalTax += solution.federalTax;
    lifetimeStateTax += solution.stateTax;
    totalConversions += conversion;
    totalRmds += Math.min(rmdAmount, start.traditional);

    rows.push({
      year,
      age,
      spouseAge,
      spendingNeed: round2(spendingNeed),
      socialSecurity: round2(ssBenefit),
      rmd: round2(Math.min(rmdAmount, start.traditional)),
      withdrawals: {
        taxable: round2(w.taxable),
        traditional: round2(w.traditional),
        roth: round2(w.roth),
        hsa: round2(w.hsa),
      },
      conversion: round2(conversion),
      agi: round2(magiNominal),
      taxableIncome: round2(solution.federal.taxableIncome * deflator),
      federalTax: round2(solution.federalTax),
      stateTax: round2(solution.stateTax),
      totalTax: round2(solution.totalTax),
      marginalRate: solution.federal.marginalRate,
      irmaa,
      shortfall: round2(solution.shortfall),
      startBalances: {
        taxable: round2(start.taxable),
        traditional: round2(start.traditional),
        roth: round2(start.roth),
        hsa: round2(start.hsa),
      },
      endBalances: {
        taxable: round2(end.taxable),
        traditional: round2(end.traditional),
        roth: round2(end.roth),
        hsa: round2(end.hsa),
      },
      endTotal: round2(end.taxable + end.traditional + end.roth + end.hsa),
    });

    balances = end;
  }

  const last = rows[rows.length - 1];
  const endingBalances = last ? last.endBalances : { ...inputs.startingBalances };
  const summary: DrawdownSummary = {
    lifetimeFederalTax: round2(lifetimeFederalTax),
    lifetimeStateTax: round2(lifetimeStateTax),
    lifetimeTax: round2(lifetimeFederalTax + lifetimeStateTax),
    totalConversions: round2(totalConversions),
    totalRmds: round2(totalRmds),
    endingBalances,
    endingTotal: round2(
      endingBalances.taxable + endingBalances.traditional + endingBalances.roth + endingBalances.hsa,
    ),
    depletionAge,
    irmaaAges,
    irmaaYearCount: irmaaAges.length,
    rmdStartAge: rmdAge,
  };

  return { rows, summary };
}

/* ------------------------------------------------------------------ */
/* Compare mode: conversions on vs off                                 */
/* ------------------------------------------------------------------ */

export function compareConversions(inputs: DrawdownInputs): DrawdownComparison {
  const conversions = inputs.conversions ?? { enabled: true, targetBracketRate: 0.22 };
  const withConversions = runDrawdown({
    ...inputs,
    conversions: { ...conversions, enabled: true },
  });
  const withoutConversions = runDrawdown({
    ...inputs,
    conversions: { ...conversions, enabled: false },
  });

  const on = withConversions.summary;
  const off = withoutConversions.summary;
  return {
    withConversions,
    withoutConversions,
    delta: {
      lifetimeTaxSavings: round2(off.lifetimeTax - on.lifetimeTax),
      endingTotal: round2(on.endingTotal - off.endingTotal),
      endingRoth: round2(on.endingBalances.roth - off.endingBalances.roth),
      endingTraditional: round2(on.endingBalances.traditional - off.endingBalances.traditional),
      endingTaxable: round2(on.endingBalances.taxable - off.endingBalances.taxable),
      irmaaYearCount: on.irmaaYearCount - off.irmaaYearCount,
    },
  };
}
