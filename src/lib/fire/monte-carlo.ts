/**
 * Monte Carlo FIRE simulation engine.
 *
 * Pure, deterministic functions: given the same inputs (including `seed`),
 * the simulation always produces the same outputs. Randomness comes from a
 * small seeded PRNG (mulberry32) — Math.random is never used.
 *
 * Method: bootstrap sampling of historical years. Each simulated year draws
 * a (stockReturn, bondReturn, inflation) triple from the same historical year
 * (1928-2024, NYU Stern / Damodaran data) to preserve the correlation between
 * asset classes and inflation.
 *
 * Conventions:
 *  - All dollar inputs are in today's (real) dollars.
 *  - The portfolio is simulated in nominal dollars; outputs are deflated by
 *    each path's cumulative inflation so all reported values are REAL.
 *  - Contributions are applied at end of year (after growth), matching the
 *    closed-form FV formula P*g^n + C*(g^n - 1)/r.
 *  - Withdrawals are taken at the start of each retirement year, before growth.
 */

import { HISTORICAL_RETURNS } from './historical-returns';

/* ------------------------------------------------------------------ */
/* Seeded PRNG                                                         */
/* ------------------------------------------------------------------ */

/** mulberry32 — tiny, fast, seedable 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ReturnMode = 'historical' | 'fixed';
export type InflationMode = 'historical' | 'fixed';
export type WithdrawalStrategy = 'fixedReal' | 'percentOfPortfolio';

export interface SocialSecurityInput {
  /** Age at which benefits begin */
  startAge: number;
  /** Annual benefit in today's dollars */
  annualBenefit: number;
}

export interface MonteCarloInputs {
  /** Portfolio value today (real $) */
  currentSavings: number;
  /** Annual contribution during accumulation (real $, year 1) */
  annualContribution: number;
  /** Annual growth of the contribution amount, percent (e.g. 2 = +2%/yr) */
  contributionGrowthPct?: number;
  /** Annual living expenses in retirement, today's dollars */
  annualExpenses: number;
  /** Safe withdrawal rate, percent (FI number = expenses / SWR) */
  safeWithdrawalRate: number;
  currentAge: number;
  /** Age at which contributions stop and withdrawals begin */
  retirementAge: number;
  /** Simulation horizon (default 95) */
  endAge?: number;
  /** Percent of portfolio in stocks during accumulation, 0-100 */
  stockAllocationPct: number;
  /**
   * Optional glide path: stock allocation linearly shifts from
   * `stockAllocationPct` today to this value at retirement (constant after).
   */
  glidePathRetirementStockPct?: number | null;
  returnMode?: ReturnMode;
  /** Fixed nominal annual return, percent — used when returnMode === 'fixed' */
  fixedReturnPct?: number;
  inflationMode?: InflationMode;
  /** Fixed annual inflation, percent — used when inflationMode === 'fixed' */
  fixedInflationPct?: number;
  /** Number of Monte Carlo paths (default 1000, clamp 1-5000) */
  numSimulations?: number;
  /** PRNG seed for reproducibility */
  seed?: number;
  withdrawalStrategy?: WithdrawalStrategy;
  /** Effective tax rate on retirement withdrawals, percent (gross-up) */
  retirementTaxRatePct?: number;
  socialSecurity?: SocialSecurityInput | null;
  /** Extra annual healthcare cost (real $) each retirement year before age 65 */
  healthcarePre65Annual?: number;
}

export interface YearBand {
  /** Years from now (0 = today) */
  yearIndex: number;
  age: number;
  /** Real (inflation-adjusted) portfolio value percentiles */
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Fraction of paths that have reached the FI number by this year */
  probFiByYear: number;
}

export interface FiAgeBucket {
  age: number;
  count: number;
}

export interface MonteCarloResult {
  /** FI number in today's dollars (expenses / SWR) */
  fiNumber: number;
  /** Per-year percentile bands of real portfolio value */
  years: YearBand[];
  /** Fraction of paths whose portfolio survives to endAge (0-1) */
  successRate: number;
  /** Median age at which FI is reached (null if <50% of paths reach FI) */
  medianFiAge: number | null;
  /** 10th percentile (earliest decile) FI age */
  fiAgeP10: number | null;
  /** 90th percentile FI age */
  fiAgeP90: number | null;
  /** Distribution of the age FI is first reached, for histogram display */
  fiAgeDistribution: FiAgeBucket[];
  /** Fraction of paths that reach FI by the chosen retirement age */
  probFiByRetirementAge: number;
  /** Fraction of paths that never reach FI within the horizon */
  probNeverFi: number;
  numSimulations: number;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

interface ResolvedInputs extends Required<Omit<MonteCarloInputs, 'glidePathRetirementStockPct' | 'socialSecurity'>> {
  glidePathRetirementStockPct: number | null;
  socialSecurity: SocialSecurityInput | null;
}

function resolveInputs(inputs: MonteCarloInputs): ResolvedInputs {
  return {
    currentSavings: Math.max(0, inputs.currentSavings),
    annualContribution: Math.max(0, inputs.annualContribution),
    contributionGrowthPct: inputs.contributionGrowthPct ?? 0,
    annualExpenses: Math.max(0, inputs.annualExpenses),
    safeWithdrawalRate: inputs.safeWithdrawalRate > 0 ? inputs.safeWithdrawalRate : 4,
    currentAge: inputs.currentAge,
    retirementAge: Math.max(inputs.retirementAge, inputs.currentAge),
    endAge: inputs.endAge ?? 95,
    stockAllocationPct: Math.min(100, Math.max(0, inputs.stockAllocationPct)),
    glidePathRetirementStockPct:
      inputs.glidePathRetirementStockPct === undefined || inputs.glidePathRetirementStockPct === null
        ? null
        : Math.min(100, Math.max(0, inputs.glidePathRetirementStockPct)),
    returnMode: inputs.returnMode ?? 'historical',
    fixedReturnPct: inputs.fixedReturnPct ?? 7,
    inflationMode: inputs.inflationMode ?? 'historical',
    fixedInflationPct: inputs.fixedInflationPct ?? 3,
    numSimulations: Math.min(5000, Math.max(1, Math.round(inputs.numSimulations ?? 1000))),
    seed: inputs.seed ?? 12345,
    withdrawalStrategy: inputs.withdrawalStrategy ?? 'fixedReal',
    retirementTaxRatePct: Math.min(99, Math.max(0, inputs.retirementTaxRatePct ?? 0)),
    socialSecurity: inputs.socialSecurity ?? null,
    healthcarePre65Annual: Math.max(0, inputs.healthcarePre65Annual ?? 0),
  };
}

/** Stock weight (0-1) for a given age, honoring the optional glide path. */
function stockWeightAtAge(r: ResolvedInputs, age: number): number {
  const start = r.stockAllocationPct / 100;
  if (r.glidePathRetirementStockPct === null) return start;
  const end = r.glidePathRetirementStockPct / 100;
  if (age >= r.retirementAge) return end;
  const span = r.retirementAge - r.currentAge;
  if (span <= 0) return end;
  const t = (age - r.currentAge) / span;
  return start + (end - start) * t;
}

interface SimPathResult {
  /** Real portfolio value at the END of each simulated year (length = horizon) */
  realValues: number[];
  /** Year index (1-based, end of year) when FI was first reached, or null */
  fiYearIndex: number | null;
  /** True if portfolio stayed above zero through endAge */
  survived: boolean;
}

/**
 * Simulate one path. `sampleYear` returns an index into HISTORICAL_RETURNS
 * or -1 to use fixed assumptions for that draw.
 */
function simulatePath(r: ResolvedInputs, rand: () => number, fiNumber: number): SimPathResult {
  const horizon = r.endAge - r.currentAge;
  const n = HISTORICAL_RETURNS.length;

  let nominal = r.currentSavings;
  let cumInflation = 1;
  let contribution = r.annualContribution;
  const realValues: number[] = new Array(Math.max(horizon, 0));
  let fiYearIndex: number | null = nominal >= fiNumber ? 0 : null;
  let failed = false;

  for (let y = 0; y < horizon; y++) {
    const age = r.currentAge + y; // age during this year
    const idx = Math.floor(rand() * n) % n;
    const row = HISTORICAL_RETURNS[idx];

    const inflation = r.inflationMode === 'historical' ? row.inflation : r.fixedInflationPct / 100;

    let portfolioReturn: number;
    if (r.returnMode === 'historical') {
      const w = stockWeightAtAge(r, age);
      portfolioReturn = w * row.stocks + (1 - w) * row.bonds;
    } else {
      portfolioReturn = r.fixedReturnPct / 100;
    }

    const inRetirement = age >= r.retirementAge;

    if (inRetirement && !failed) {
      // Withdrawal at start of year (nominal)
      let withdrawalNominal: number;
      if (r.withdrawalStrategy === 'percentOfPortfolio') {
        withdrawalNominal = nominal * (r.safeWithdrawalRate / 100);
      } else {
        // Fixed real spending in today's dollars
        let expensesReal = r.annualExpenses;
        if (age < 65) expensesReal += r.healthcarePre65Annual;
        if (r.socialSecurity && age >= r.socialSecurity.startAge) {
          expensesReal = Math.max(0, expensesReal - r.socialSecurity.annualBenefit);
        }
        // Gross-up for taxes on withdrawals
        const grossReal = expensesReal / (1 - r.retirementTaxRatePct / 100);
        withdrawalNominal = grossReal * cumInflation;
      }
      nominal -= withdrawalNominal;
      if (nominal <= 0) {
        nominal = 0;
        if (r.withdrawalStrategy === 'fixedReal') failed = true;
      }
    }

    // Growth over the year
    nominal *= 1 + portfolioReturn;
    if (nominal < 0) nominal = 0;

    // Contribution at end of year during accumulation
    if (!inRetirement) {
      nominal += contribution;
      contribution *= 1 + r.contributionGrowthPct / 100;
    }

    cumInflation *= 1 + inflation;
    if (cumInflation <= 0) cumInflation = 1e-9;

    const real = nominal / cumInflation;
    realValues[y] = real;

    if (fiYearIndex === null && real >= fiNumber && fiNumber > 0) {
      fiYearIndex = y + 1;
    }
  }

  const survived = !failed && (horizon === 0 ? nominal > 0 || r.annualExpenses === 0 : realValues[horizon - 1] > 0 || r.annualExpenses === 0);
  return { realValues, fiYearIndex, survived };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** FI number in today's dollars. */
export function computeFiNumber(annualExpenses: number, safeWithdrawalRate: number): number {
  if (safeWithdrawalRate <= 0) return Infinity;
  return annualExpenses / (safeWithdrawalRate / 100);
}

/**
 * Run the full Monte Carlo simulation. Deterministic given identical inputs.
 */
export function runMonteCarlo(inputs: MonteCarloInputs): MonteCarloResult {
  const r = resolveInputs(inputs);
  const fiNumber = computeFiNumber(r.annualExpenses, r.safeWithdrawalRate);
  const horizon = Math.max(0, r.endAge - r.currentAge);
  const sims = r.numSimulations;

  const paths: SimPathResult[] = new Array(sims);
  for (let s = 0; s < sims; s++) {
    // Independent stream per path, derived from the master seed.
    const rand = mulberry32((r.seed + s * 0x9e3779b9) >>> 0);
    paths[s] = simulatePath(r, rand, fiNumber);
  }

  // Percentile bands per year + cumulative FI probability
  const years: YearBand[] = [];
  // Year 0 = today
  const fiAtStart = r.currentSavings >= fiNumber && fiNumber > 0 ? 1 : 0;
  years.push({
    yearIndex: 0,
    age: r.currentAge,
    p10: r.currentSavings,
    p25: r.currentSavings,
    p50: r.currentSavings,
    p75: r.currentSavings,
    p90: r.currentSavings,
    probFiByYear: fiAtStart,
  });

  const buf = new Array<number>(sims);
  for (let y = 0; y < horizon; y++) {
    for (let s = 0; s < sims; s++) buf[s] = paths[s].realValues[y];
    const sorted = [...buf].sort((a, b) => a - b);
    let fiCount = 0;
    for (let s = 0; s < sims; s++) {
      const fy = paths[s].fiYearIndex;
      if (fy !== null && fy <= y + 1) fiCount++;
    }
    years.push({
      yearIndex: y + 1,
      age: r.currentAge + y + 1,
      p10: percentile(sorted, 0.1),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.9),
      probFiByYear: fiCount / sims,
    });
  }

  // Success rate: portfolio survives to endAge
  const successRate = paths.filter(p => p.survived).length / sims;

  // FI age distribution
  const fiAges: number[] = [];
  const bucketMap = new Map<number, number>();
  let neverFi = 0;
  for (const p of paths) {
    if (p.fiYearIndex === null) {
      neverFi++;
      continue;
    }
    const age = r.currentAge + p.fiYearIndex;
    fiAges.push(age);
    bucketMap.set(age, (bucketMap.get(age) ?? 0) + 1);
  }
  fiAges.sort((a, b) => a - b);

  const fiAgeDistribution: FiAgeBucket[] = [...bucketMap.entries()]
    .map(([age, count]) => ({ age, count }))
    .sort((a, b) => a.age - b.age);

  // Quantiles of FI age across ALL paths, treating paths that never reach FI
  // as +infinity: the q-th quantile exists only if at least q of the paths
  // reached FI, and equals the floor(q*sims)-th smallest recorded FI age.
  const reachedFraction = fiAges.length / sims;
  let medianFiAge: number | null = null;
  if (reachedFraction >= 0.5 && fiAges.length > 0) {
    medianFiAge = fiAges[Math.min(fiAges.length - 1, Math.floor(0.5 * sims))];
  }

  let fiAgeP10: number | null = null;
  let fiAgeP90: number | null = null;
  if (reachedFraction >= 0.1 && fiAges.length > 0) {
    fiAgeP10 = fiAges[Math.min(fiAges.length - 1, Math.floor(0.1 * sims))];
  }
  if (reachedFraction >= 0.9 && fiAges.length > 0) {
    fiAgeP90 = fiAges[Math.min(fiAges.length - 1, Math.floor(0.9 * sims))];
  }

  // Probability of FI by retirement age
  const retYearIndex = r.retirementAge - r.currentAge;
  let probFiByRetirementAge = 0;
  if (retYearIndex <= 0) {
    probFiByRetirementAge = fiAtStart;
  } else if (retYearIndex < years.length) {
    probFiByRetirementAge = years[retYearIndex].probFiByYear;
  } else if (years.length > 0) {
    probFiByRetirementAge = years[years.length - 1].probFiByYear;
  }

  return {
    fiNumber,
    years,
    successRate,
    medianFiAge,
    fiAgeP10,
    fiAgeP90,
    fiAgeDistribution,
    probFiByRetirementAge,
    probNeverFi: neverFi / sims,
    numSimulations: sims,
  };
}

/**
 * Success-rate sensitivity to retirement age (sequence-of-returns risk).
 * Re-runs the simulation with the same seed for each candidate age.
 */
export function successRateSensitivity(
  inputs: MonteCarloInputs,
  offsets: number[] = [-2, -1, 0, 1, 2]
): { retirementAge: number; successRate: number }[] {
  const base = resolveInputs(inputs);
  return offsets.map(off => {
    const retirementAge = Math.min(base.endAge, Math.max(base.currentAge, base.retirementAge + off));
    const res = runMonteCarlo({ ...inputs, retirementAge });
    return { retirementAge, successRate: res.successRate };
  });
}

/**
 * Deterministic closed-form accumulation projection (real terms), used for
 * the optional deterministic overlay. Contributions at end of year.
 */
export function deterministicProjection(opts: {
  currentSavings: number;
  annualContribution: number;
  contributionGrowthPct?: number;
  realReturnPct: number;
  years: number;
}): number[] {
  const { currentSavings, annualContribution, realReturnPct, years } = opts;
  const g = (opts.contributionGrowthPct ?? 0) / 100;
  const r = realReturnPct / 100;
  const out: number[] = [currentSavings];
  let v = currentSavings;
  let c = annualContribution;
  for (let y = 0; y < years; y++) {
    v = v * (1 + r) + c;
    c *= 1 + g;
    out.push(v);
  }
  return out;
}
