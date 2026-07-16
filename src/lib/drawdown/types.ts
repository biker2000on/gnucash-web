/**
 * Retirement Drawdown & Roth Conversion Planner — shared types.
 *
 * The engine models the spend-down phase year by year: bucket growth,
 * withdrawal sequencing, RMDs (SECURE 2.0), optional bracket-filling Roth
 * conversions, and federal + state tax via the existing tax engine.
 *
 * ESTIMATES ONLY — not tax or investment advice.
 */

import type { FilingStatus } from '@/lib/tax/types';

/** Asset buckets tracked by the planner. */
export const BUCKETS = ['taxable', 'traditional', 'roth', 'hsa'] as const;
export type Bucket = (typeof BUCKETS)[number];

export type BucketAmounts = Record<Bucket, number>;

export const BUCKET_LABELS: Record<Bucket, string> = {
  taxable: 'Taxable',
  traditional: 'Traditional',
  roth: 'Roth',
  hsa: 'HSA',
};

export function emptyBuckets(): BucketAmounts {
  return { taxable: 0, traditional: 0, roth: 0, hsa: 0 };
}

/** Default withdrawal order: taxable → traditional → Roth → HSA. */
export const DEFAULT_SEQUENCING: readonly Bucket[] = ['taxable', 'traditional', 'roth', 'hsa'];

export interface ConversionSettings {
  enabled: boolean;
  /**
   * Fill ordinary taxable income up to the top of this federal bracket
   * (e.g. 0.12, 0.22, 0.24). Conversions only run in retirement years
   * before the RMD start age.
   */
  targetBracketRate: number;
}

export interface DrawdownInputs {
  /** Primary filer's age at the start of `startYear`. */
  currentAge: number;
  /** Spouse age at the start of `startYear` (null / undefined when none). */
  spouseAge?: number | null;
  /** Age spending withdrawals begin. May equal currentAge (already retired). */
  retirementAge: number;
  /** Last modeled age (inclusive). */
  endAge: number;
  /** First calendar year of the model. Defaults to the current year. */
  startYear?: number;

  filingStatus: FilingStatus;
  /** State code for the state tax module ('TX', 'CA', 'OTHER', ...). */
  state: string;
  /** Flat rate (decimal) used when state === 'OTHER'. */
  stateFlatRateOverride?: number;

  /** Starting balances by bucket (today's dollars = nominal at startYear). */
  startingBalances: BucketAmounts;
  /** Expected NOMINAL annual return per bucket (decimals, e.g. 0.06). */
  nominalReturns: BucketAmounts;

  /** Annual spending need in today's dollars (inflated each year). */
  annualSpending: number;
  /** Annual inflation rate (decimal, e.g. 0.025). */
  inflationRate: number;

  /**
   * Fraction of every taxable-account withdrawal treated as long-term
   * capital gain (the rest is untaxed return of basis). Default 0.5.
   */
  taxableGainsFraction?: number;

  /** Social Security: claim age + annual benefit in today's dollars. */
  socialSecurity?: { startAge: number; annualBenefit: number } | null;

  /**
   * Multiple Social Security income streams (e.g. per-spouse claims from the
   * claiming optimizer). `startAge` is the PRIMARY filer's age when the
   * stream begins; benefits are today's dollars, inflated each year like
   * `socialSecurity`. When non-empty this takes precedence over
   * `socialSecurity`.
   */
  socialSecurityStreams?: Array<{ startAge: number; annualBenefit: number }> | null;

  /** Withdrawal order. Defaults to DEFAULT_SEQUENCING. */
  sequencing?: readonly Bucket[];

  /** Bracket-filling Roth conversion settings. Default: disabled. */
  conversions?: ConversionSettings;
}

export interface IrmaaFlag {
  /** 1-based IRMAA tier the MAGI lands in (1..5). */
  tier: number;
  /** Threshold label, e.g. '> $218,000'. */
  label: string;
  /** Estimated monthly Part B + Part D surcharge per enrollee (nominal $). */
  monthlySurcharge: number;
  /** Estimated annual surcharge per enrollee (nominal $). */
  annualSurcharge: number;
}

export interface DrawdownYearRow {
  year: number;
  age: number;
  spouseAge: number | null;
  /** Inflated spending need for the year (0 before retirement). */
  spendingNeed: number;
  /** Gross Social Security received (nominal). */
  socialSecurity: number;
  /** Required minimum distribution for the year (0 when not applicable). */
  rmd: number;
  /** Withdrawals by bucket (traditional includes the RMD). */
  withdrawals: BucketAmounts;
  /** Roth conversion amount (traditional → Roth). */
  conversion: number;
  /** Federal AGI (nominal). Also used as MAGI for IRMAA. */
  agi: number;
  /** Federal taxable income (nominal). */
  taxableIncome: number;
  federalTax: number;
  stateTax: number;
  totalTax: number;
  /** Marginal ordinary federal bracket rate (e.g. 0.22). */
  marginalRate: number;
  /**
   * IRMAA tier the year's MAGI falls into (null when below tier 1 or the
   * filer is younger than 63 — the two-year lookback makes MAGI from age
   * 63 determine premiums at 65+).
   */
  irmaa: IrmaaFlag | null;
  /** Unmet spending (money ran out this year). */
  shortfall: number;
  /** Balances at the start of the year (= prior year end). */
  startBalances: BucketAmounts;
  /** Balances at the end of the year, after withdrawals + growth. */
  endBalances: BucketAmounts;
  endTotal: number;
}

export interface DrawdownSummary {
  lifetimeFederalTax: number;
  lifetimeStateTax: number;
  lifetimeTax: number;
  totalConversions: number;
  totalRmds: number;
  endingBalances: BucketAmounts;
  endingTotal: number;
  /** Age money first fails to cover spending, or null if it lasts. */
  depletionAge: number | null;
  /** Ages whose MAGI lands in an IRMAA tier (age >= 63). */
  irmaaAges: number[];
  irmaaYearCount: number;
  /** RMD start age under SECURE 2.0 for the primary filer's birth year. */
  rmdStartAge: number;
}

export interface DrawdownResult {
  rows: DrawdownYearRow[];
  summary: DrawdownSummary;
}

export interface DrawdownComparison {
  withConversions: DrawdownResult;
  withoutConversions: DrawdownResult;
  delta: {
    /** Positive = conversions SAVE lifetime tax. */
    lifetimeTaxSavings: number;
    /** with − without */
    endingTotal: number;
    endingRoth: number;
    endingTraditional: number;
    endingTaxable: number;
    irmaaYearCount: number;
  };
}
