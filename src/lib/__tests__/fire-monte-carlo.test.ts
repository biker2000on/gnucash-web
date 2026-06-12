import { describe, it, expect } from 'vitest';
import {
  HISTORICAL_RETURNS,
  meanStockReturn,
  meanInflation,
} from '@/lib/fire/historical-returns';
import {
  mulberry32,
  runMonteCarlo,
  computeFiNumber,
  deterministicProjection,
  successRateSensitivity,
  type MonteCarloInputs,
} from '@/lib/fire/monte-carlo';

/* ------------------------------------------------------------------ */
/* Dataset sanity                                                      */
/* ------------------------------------------------------------------ */

describe('historical returns dataset', () => {
  it('covers 1928-2024 contiguously (97 years)', () => {
    expect(HISTORICAL_RETURNS.length).toBe(97);
    expect(HISTORICAL_RETURNS[0].year).toBe(1928);
    expect(HISTORICAL_RETURNS[HISTORICAL_RETURNS.length - 1].year).toBe(2024);
    for (let i = 1; i < HISTORICAL_RETURNS.length; i++) {
      expect(HISTORICAL_RETURNS[i].year).toBe(HISTORICAL_RETURNS[i - 1].year + 1);
    }
  });

  it('mean nominal stock return is between 8% and 13%', () => {
    const m = meanStockReturn();
    expect(m).toBeGreaterThan(0.08);
    expect(m).toBeLessThan(0.13);
  });

  it('mean inflation is plausible (1%-5%)', () => {
    const m = meanInflation();
    expect(m).toBeGreaterThan(0.01);
    expect(m).toBeLessThan(0.05);
  });

  it('1931 stocks were sharply negative, 1933 sharply positive', () => {
    const y1931 = HISTORICAL_RETURNS.find(r => r.year === 1931)!;
    const y1933 = HISTORICAL_RETURNS.find(r => r.year === 1933)!;
    expect(y1931.stocks).toBeLessThan(-0.3);
    expect(y1933.stocks).toBeGreaterThan(0.3);
  });

  it('all values are finite and within sane bounds', () => {
    for (const r of HISTORICAL_RETURNS) {
      expect(Number.isFinite(r.stocks)).toBe(true);
      expect(Number.isFinite(r.bonds)).toBe(true);
      expect(Number.isFinite(r.inflation)).toBe(true);
      expect(r.stocks).toBeGreaterThan(-0.6);
      expect(r.stocks).toBeLessThan(0.6);
      expect(r.bonds).toBeGreaterThan(-0.25);
      expect(r.bonds).toBeLessThan(0.4);
      expect(r.inflation).toBeGreaterThan(-0.15);
      expect(r.inflation).toBeLessThan(0.2);
    }
  });
});

/* ------------------------------------------------------------------ */
/* PRNG                                                                */
/* ------------------------------------------------------------------ */

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('produces values in [0, 1)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

const baseInputs: MonteCarloInputs = {
  currentSavings: 200_000,
  annualContribution: 30_000,
  annualExpenses: 60_000,
  safeWithdrawalRate: 4,
  currentAge: 35,
  retirementAge: 55,
  endAge: 95,
  stockAllocationPct: 80,
  numSimulations: 500,
  seed: 1234,
};

describe('runMonteCarlo', () => {
  it('is deterministic given the same seed', () => {
    const a = runMonteCarlo(baseInputs);
    const b = runMonteCarlo({ ...baseInputs });
    expect(a.successRate).toBe(b.successRate);
    expect(a.medianFiAge).toBe(b.medianFiAge);
    expect(a.years.map(y => y.p50)).toEqual(b.years.map(y => y.p50));
    expect(a.years.map(y => y.probFiByYear)).toEqual(b.years.map(y => y.probFiByYear));
  });

  it('changes results with a different seed', () => {
    const a = runMonteCarlo(baseInputs);
    const b = runMonteCarlo({ ...baseInputs, seed: 9999 });
    expect(a.years.map(y => y.p50)).not.toEqual(b.years.map(y => y.p50));
  });

  it('percentiles are ordered p10 <= p25 <= p50 <= p75 <= p90 every year', () => {
    const res = runMonteCarlo(baseInputs);
    for (const y of res.years) {
      expect(y.p10).toBeLessThanOrEqual(y.p25);
      expect(y.p25).toBeLessThanOrEqual(y.p50);
      expect(y.p50).toBeLessThanOrEqual(y.p75);
      expect(y.p75).toBeLessThanOrEqual(y.p90);
    }
  });

  it('probFiByYear is monotonically non-decreasing', () => {
    const res = runMonteCarlo(baseInputs);
    for (let i = 1; i < res.years.length; i++) {
      expect(res.years[i].probFiByYear).toBeGreaterThanOrEqual(res.years[i - 1].probFiByYear);
    }
  });

  it('zero-volatility degenerate case matches closed-form deterministic growth', () => {
    const inputs: MonteCarloInputs = {
      currentSavings: 100_000,
      annualContribution: 10_000,
      annualExpenses: 40_000,
      safeWithdrawalRate: 4,
      currentAge: 30,
      retirementAge: 60,
      endAge: 60, // accumulation only
      stockAllocationPct: 100,
      returnMode: 'fixed',
      fixedReturnPct: 7,
      inflationMode: 'fixed',
      fixedInflationPct: 0,
      numSimulations: 50,
      seed: 1,
    };
    const res = runMonteCarlo(inputs);
    const expected = deterministicProjection({
      currentSavings: 100_000,
      annualContribution: 10_000,
      realReturnPct: 7,
      years: 30,
    });
    // Also verify against the textbook closed form: P*g^n + C*(g^n - 1)/r
    const r = 0.07;
    for (let n = 0; n < res.years.length; n++) {
      const g = Math.pow(1 + r, n);
      const closedForm = 100_000 * g + 10_000 * ((g - 1) / r);
      expect(res.years[n].p50).toBeCloseTo(closedForm, 4);
      expect(res.years[n].p10).toBeCloseTo(closedForm, 4); // no spread without volatility
      expect(res.years[n].p90).toBeCloseTo(closedForm, 4);
      expect(res.years[n].p50).toBeCloseTo(expected[n], 4);
    }
  });

  it('success rate is 100% with enormous savings', () => {
    const res = runMonteCarlo({
      ...baseInputs,
      currentSavings: 100_000_000,
      annualExpenses: 40_000,
      numSimulations: 300,
    });
    expect(res.successRate).toBe(1);
    expect(res.probFiByRetirementAge).toBe(1);
  });

  it('success rate is 0% with zero savings, zero contributions, and real expenses', () => {
    const res = runMonteCarlo({
      ...baseInputs,
      currentSavings: 0,
      annualContribution: 0,
      annualExpenses: 50_000,
      retirementAge: 35, // retire immediately with nothing
      numSimulations: 300,
    });
    expect(res.successRate).toBe(0);
    expect(res.probNeverFi).toBe(1);
  });

  it('Social Security reduces the failure rate', () => {
    // Borderline plan: modest portfolio retiring immediately.
    const marginal: MonteCarloInputs = {
      currentSavings: 900_000,
      annualContribution: 0,
      annualExpenses: 50_000,
      safeWithdrawalRate: 4,
      currentAge: 60,
      retirementAge: 60,
      endAge: 95,
      stockAllocationPct: 60,
      numSimulations: 1000,
      seed: 777,
    };
    const withoutSS = runMonteCarlo(marginal);
    const withSS = runMonteCarlo({
      ...marginal,
      socialSecurity: { startAge: 67, annualBenefit: 24_000 },
    });
    expect(withoutSS.successRate).toBeLessThan(1); // genuinely borderline
    expect(withSS.successRate).toBeGreaterThan(withoutSS.successRate);
  });

  it('retirement tax rate increases withdrawals and lowers success', () => {
    const marginal: MonteCarloInputs = {
      currentSavings: 1_100_000,
      annualContribution: 0,
      annualExpenses: 45_000,
      safeWithdrawalRate: 4,
      currentAge: 60,
      retirementAge: 60,
      endAge: 95,
      stockAllocationPct: 60,
      numSimulations: 800,
      seed: 31,
    };
    const noTax = runMonteCarlo(marginal);
    const taxed = runMonteCarlo({ ...marginal, retirementTaxRatePct: 25 });
    expect(taxed.successRate).toBeLessThanOrEqual(noTax.successRate);
    expect(taxed.successRate).toBeLessThan(1);
  });

  it('percent-of-portfolio withdrawal never depletes to zero (always survives)', () => {
    const res = runMonteCarlo({
      ...baseInputs,
      currentSavings: 500_000,
      withdrawalStrategy: 'percentOfPortfolio',
      numSimulations: 300,
    });
    expect(res.successRate).toBe(1);
  });

  it('respects endAge horizon and reports ages correctly', () => {
    const res = runMonteCarlo({ ...baseInputs, endAge: 90 });
    expect(res.years[0].age).toBe(35);
    expect(res.years[res.years.length - 1].age).toBe(90);
    expect(res.years.length).toBe(90 - 35 + 1);
  });

  it('computeFiNumber: 4% SWR means 25x expenses', () => {
    expect(computeFiNumber(40_000, 4)).toBe(1_000_000);
    expect(computeFiNumber(60_000, 3)).toBeCloseTo(2_000_000, 6);
  });

  it('fiAgeDistribution counts sum to paths that reached FI', () => {
    const res = runMonteCarlo(baseInputs);
    const total = res.fiAgeDistribution.reduce((a, b) => a + b.count, 0);
    expect(total / res.numSimulations + res.probNeverFi).toBeCloseTo(1, 9);
  });

  it('clamps numSimulations to 5000', () => {
    const res = runMonteCarlo({ ...baseInputs, numSimulations: 99999, endAge: 40 });
    expect(res.numSimulations).toBe(5000);
  });
});

describe('successRateSensitivity', () => {
  it('returns one entry per offset with ordered retirement ages', () => {
    const rows = successRateSensitivity(
      { ...baseInputs, numSimulations: 200 },
      [-2, -1, 0, 1, 2]
    );
    expect(rows.length).toBe(5);
    expect(rows[2].retirementAge).toBe(55);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].retirementAge).toBeGreaterThanOrEqual(rows[i - 1].retirementAge);
    }
    // Retiring later should not generally hurt success
    expect(rows[4].successRate).toBeGreaterThanOrEqual(rows[0].successRate);
    for (const r of rows) {
      expect(r.successRate).toBeGreaterThanOrEqual(0);
      expect(r.successRate).toBeLessThanOrEqual(1);
    }
  });
});
