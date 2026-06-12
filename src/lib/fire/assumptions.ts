/**
 * FIRE calculator assumption set: the user-tunable model parameters that sit
 * on top of the data-driven inputs (savings, contributions, expenses).
 * Persisted inside saved tool configs (toolType 'fire-calculator') under the
 * `assumptions` key — additive and backward-compatible with older configs.
 */

import type { InflationMode, ReturnMode, WithdrawalStrategy } from './monte-carlo';

export interface FireAssumptions {
  /** 'historical' = Monte Carlo bootstrap of 1928-2024; 'fixed' = flat rate */
  returnMode: ReturnMode;
  /** Stock allocation during accumulation, percent 0-100 */
  stockAllocationPct: number;
  /** Whether allocation glides toward a retirement allocation */
  glidePathEnabled: boolean;
  /** Stock allocation at retirement when glide path is enabled */
  glidePathRetirementStockPct: number;
  inflationMode: InflationMode;
  /** Fixed annual inflation percent, used when inflationMode === 'fixed' */
  fixedInflationPct: number;
  withdrawalStrategy: WithdrawalStrategy;
  /** Effective tax rate on retirement withdrawals, percent */
  retirementTaxRatePct: number;
  socialSecurityEnabled: boolean;
  /** Age Social Security benefits begin */
  socialSecurityStartAge: number;
  /** Monthly benefit in today's dollars */
  socialSecurityMonthlyBenefit: number;
  /** Extra annual healthcare cost (today's $) each retirement year before 65 */
  healthcarePre65Annual: number;
  /** Annual growth of contributions, percent */
  contributionGrowthPct: number;
  /** Simulation horizon age */
  endAge: number;
  /** Number of Monte Carlo paths */
  numSimulations: number;
}

export const DEFAULT_ASSUMPTIONS: FireAssumptions = {
  returnMode: 'historical',
  stockAllocationPct: 80,
  glidePathEnabled: false,
  glidePathRetirementStockPct: 60,
  inflationMode: 'historical',
  fixedInflationPct: 3,
  withdrawalStrategy: 'fixedReal',
  retirementTaxRatePct: 0,
  socialSecurityEnabled: false,
  socialSecurityStartAge: 67,
  socialSecurityMonthlyBenefit: 2000,
  healthcarePre65Annual: 0,
  contributionGrowthPct: 0,
  endAge: 95,
  numSimulations: 1000,
};

/** Merge a possibly-partial persisted assumption object with defaults. */
export function mergeAssumptions(partial: Partial<FireAssumptions> | undefined | null): FireAssumptions {
  if (!partial) return { ...DEFAULT_ASSUMPTIONS };
  const merged = { ...DEFAULT_ASSUMPTIONS, ...partial };
  // Clamp to sane ranges in case of hand-edited configs
  merged.stockAllocationPct = clamp(merged.stockAllocationPct, 0, 100);
  merged.glidePathRetirementStockPct = clamp(merged.glidePathRetirementStockPct, 0, 100);
  merged.fixedInflationPct = clamp(merged.fixedInflationPct, -5, 20);
  merged.retirementTaxRatePct = clamp(merged.retirementTaxRatePct, 0, 60);
  merged.socialSecurityStartAge = clamp(merged.socialSecurityStartAge, 50, 75);
  merged.socialSecurityMonthlyBenefit = Math.max(0, merged.socialSecurityMonthlyBenefit);
  merged.healthcarePre65Annual = Math.max(0, merged.healthcarePre65Annual);
  merged.contributionGrowthPct = clamp(merged.contributionGrowthPct, -10, 20);
  merged.endAge = clamp(merged.endAge, 60, 110);
  merged.numSimulations = clamp(Math.round(merged.numSimulations), 100, 5000);
  return merged;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
