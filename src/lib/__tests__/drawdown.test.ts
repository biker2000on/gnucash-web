/**
 * Retirement Drawdown & Roth Conversion Planner — engine tests.
 *
 * Covers: RMD divisors + SECURE 2.0 start ages, withdrawal sequencing,
 * bracket-filling conversion math, IRMAA tier detection, depletion
 * detection, and a full-scenario smoke test with compare mode.
 */

import { describe, it, expect } from 'vitest';
import {
  UNIFORM_LIFETIME_TABLE,
  computeRmd,
  rmdDivisor,
  rmdStartAge,
} from '@/lib/drawdown/rmd';
import { irmaaTierFor } from '@/lib/drawdown/irmaa';
import { compareConversions, conversionHeadroom, runDrawdown } from '@/lib/drawdown/engine';
import type { Bucket, DrawdownInputs } from '@/lib/drawdown/types';

function baseInputs(overrides: Partial<DrawdownInputs> = {}): DrawdownInputs {
  return {
    currentAge: 60,
    retirementAge: 60,
    endAge: 60,
    startYear: 2026,
    filingStatus: 'single',
    state: 'TX',
    startingBalances: { taxable: 100_000, traditional: 100_000, roth: 100_000, hsa: 0 },
    nominalReturns: { taxable: 0, traditional: 0, roth: 0, hsa: 0 },
    annualSpending: 40_000,
    inflationRate: 0,
    socialSecurity: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* RMDs                                                                */
/* ------------------------------------------------------------------ */

describe('RMD rules (SECURE 2.0 + Uniform Lifetime Table)', () => {
  it('start age is 73 for those born 1951-1959 and 75 for 1960+', () => {
    expect(rmdStartAge(1951)).toBe(73);
    expect(rmdStartAge(1955)).toBe(73);
    expect(rmdStartAge(1959)).toBe(73);
    expect(rmdStartAge(1960)).toBe(75);
    expect(rmdStartAge(1975)).toBe(75);
  });

  it('looks up published Uniform Lifetime Table divisors', () => {
    expect(rmdDivisor(72)).toBe(27.4);
    expect(rmdDivisor(73)).toBe(26.5);
    expect(rmdDivisor(75)).toBe(24.6);
    expect(rmdDivisor(80)).toBe(20.2);
    expect(rmdDivisor(90)).toBe(12.2);
    expect(rmdDivisor(100)).toBe(6.4);
    expect(rmdDivisor(120)).toBe(2.0);
    // Clamped outside the table range
    expect(rmdDivisor(130)).toBe(2.0);
    expect(rmdDivisor(60)).toBe(UNIFORM_LIFETIME_TABLE[72]);
  });

  it('computes the RMD from the prior year-end balance', () => {
    // Born 1955 -> start age 73; 265,000 / 26.5 = 10,000
    expect(computeRmd(73, 1955, 265_000)).toBeCloseTo(10_000, 6);
    // Before the start age: no RMD
    expect(computeRmd(72, 1955, 265_000)).toBe(0);
    expect(computeRmd(74, 1960, 1_000_000)).toBe(0);
    // At 75 for the 1960+ cohort
    expect(computeRmd(75, 1960, 246_000)).toBeCloseTo(10_000, 6);
    expect(computeRmd(80, 1950, 0)).toBe(0);
  });

  it('engine forces the RMD from traditional even when taxable could cover spending', () => {
    // Born 2026 - 75 = 1951 -> RMD start 73, already past it.
    const result = runDrawdown(baseInputs({
      currentAge: 75,
      retirementAge: 75,
      endAge: 75,
      startingBalances: { taxable: 500_000, traditional: 265_000, roth: 0, hsa: 0 },
      annualSpending: 10_000,
    }));
    const row = result.rows[0];
    expect(row.rmd).toBeCloseTo(265_000 / 24.6, 1);
    expect(row.withdrawals.traditional).toBeCloseTo(row.rmd, 1);
    // RMD alone covers spending; nothing drawn from taxable.
    expect(row.withdrawals.taxable).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Withdrawal sequencing                                               */
/* ------------------------------------------------------------------ */

describe('withdrawal sequencing', () => {
  it('drains taxable, then traditional, then Roth by default', () => {
    const result = runDrawdown(baseInputs({
      endAge: 62,
      startingBalances: { taxable: 50_000, traditional: 500_000, roth: 500_000, hsa: 0 },
      annualSpending: 60_000,
    }));
    const [y1, y2] = result.rows;
    // Year 1: all of taxable, remainder from traditional, no Roth.
    expect(y1.withdrawals.taxable).toBeCloseTo(50_000, 2);
    expect(y1.withdrawals.traditional).toBeGreaterThan(9_000);
    expect(y1.withdrawals.roth).toBe(0);
    expect(y1.withdrawals.hsa).toBe(0);
    // Year 2: taxable is empty, traditional covers everything.
    expect(y2.withdrawals.taxable).toBe(0);
    expect(y2.withdrawals.traditional).toBeGreaterThan(60_000 - 1);
    expect(y2.withdrawals.roth).toBe(0);
  });

  it('honors a custom sequencing order', () => {
    const sequencing: Bucket[] = ['roth', 'taxable', 'traditional', 'hsa'];
    const result = runDrawdown(baseInputs({
      startingBalances: { taxable: 500_000, traditional: 500_000, roth: 500_000, hsa: 0 },
      annualSpending: 60_000,
      sequencing,
    }));
    const row = result.rows[0];
    // Roth withdrawals are tax-free, so exactly the spending need is taken.
    expect(row.withdrawals.roth).toBeCloseTo(60_000, 2);
    expect(row.withdrawals.taxable).toBe(0);
    expect(row.withdrawals.traditional).toBe(0);
    expect(row.totalTax).toBe(0);
  });

  it('falls through to HSA last when earlier buckets are exhausted', () => {
    const result = runDrawdown(baseInputs({
      startingBalances: { taxable: 10_000, traditional: 10_000, roth: 10_000, hsa: 100_000 },
      annualSpending: 50_000,
    }));
    const row = result.rows[0];
    expect(row.withdrawals.taxable).toBeCloseTo(10_000, 2);
    expect(row.withdrawals.traditional).toBeCloseTo(10_000, 2);
    expect(row.withdrawals.roth).toBeCloseTo(10_000, 2);
    expect(row.withdrawals.hsa).toBeCloseTo(20_000, 0);
    expect(row.shortfall).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Bracket-filling Roth conversions                                    */
/* ------------------------------------------------------------------ */

describe('bracket-filling Roth conversions', () => {
  it('conversionHeadroom is bracket top minus existing ordinary income', () => {
    // 2026 MFJ 12% bracket tops out at $100,800 of taxable income.
    expect(conversionHeadroom(0.12, 'mfj', 30_000)).toBe(70_800);
    // 2026 single 22% bracket tops out at $105,700.
    expect(conversionHeadroom(0.22, 'single', 0)).toBe(105_700);
    expect(conversionHeadroom(0.22, 'single', 105_700)).toBe(0);
    // Already past the top: clamped at zero.
    expect(conversionHeadroom(0.12, 'single', 60_000)).toBe(0);
    // Unknown bracket rate: nothing to fill.
    expect(conversionHeadroom(0.13, 'single', 0)).toBe(0);
    // Top bracket is unbounded.
    expect(conversionHeadroom(0.37, 'single', 1_000_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it('converts exactly to the bracket top minus other ordinary income', () => {
    // Single, age 60 (no extra 65+ deduction), TX, no SS, spending covered
    // from taxable (LTCG is preferential, not ordinary). The conversion is
    // the only ordinary income, so at the fixed point:
    //   conversion - standard deduction (16,100) = 105,700 (22% top)
    const result = runDrawdown(baseInputs({
      startingBalances: { taxable: 1_000_000, traditional: 1_000_000, roth: 0, hsa: 0 },
      annualSpending: 40_000,
      conversions: { enabled: true, targetBracketRate: 0.22 },
    }));
    const row = result.rows[0];
    expect(Math.abs(row.conversion - (105_700 + 16_100))).toBeLessThanOrEqual(1.5);
    expect(row.marginalRate).toBe(0.22);
    // Converted dollars actually moved traditional -> Roth.
    expect(row.endBalances.roth).toBeCloseTo(row.conversion, 0);
    expect(row.endBalances.traditional).toBeCloseTo(1_000_000 - row.conversion, 0);
  });

  it('reduces the conversion dollar-for-dollar by other ordinary income', () => {
    // Only traditional money exists, so the conversion's own tax bill is
    // paid via an extra traditional withdrawal — which is itself ordinary
    // income. At the fixed point, withdrawal + conversion together land
    // exactly at the 12% bracket top plus the standard deduction:
    //   50,400 + 16,100 = 66,500 of AGI, taxed 1,240 + 4,560 = 5,800.
    const result = runDrawdown(baseInputs({
      startingBalances: { taxable: 0, traditional: 1_000_000, roth: 0, hsa: 0 },
      annualSpending: 0,
      socialSecurity: null,
      conversions: { enabled: true, targetBracketRate: 0.12 },
    }));
    const row = result.rows[0];
    expect(Math.abs(row.totalTax - 5_800)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(row.withdrawals.traditional - row.totalTax)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(row.withdrawals.traditional + row.conversion - 66_500)).toBeLessThanOrEqual(1.5);
  });

  it('does not convert once RMDs have begun or when disabled', () => {
    const result = runDrawdown(baseInputs({
      currentAge: 74,
      retirementAge: 74,
      endAge: 78, // born 1952 -> RMDs from 73: every modeled year is RMD age
      startingBalances: { taxable: 200_000, traditional: 500_000, roth: 0, hsa: 0 },
      conversions: { enabled: true, targetBracketRate: 0.22 },
    }));
    for (const row of result.rows) {
      expect(row.conversion).toBe(0);
      expect(row.rmd).toBeGreaterThan(0);
    }

    const disabled = runDrawdown(baseInputs({
      conversions: { enabled: false, targetBracketRate: 0.22 },
      startingBalances: { taxable: 1_000_000, traditional: 1_000_000, roth: 0, hsa: 0 },
    }));
    expect(disabled.rows[0].conversion).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* IRMAA                                                               */
/* ------------------------------------------------------------------ */

describe('IRMAA tier detection', () => {
  it('maps 2026 MAGI to tiers (single)', () => {
    expect(irmaaTierFor(100_000, 'single')).toBeNull();
    expect(irmaaTierFor(109_000, 'single')).toBeNull(); // at the threshold, not above
    expect(irmaaTierFor(109_001, 'single')?.tier).toBe(1);
    expect(irmaaTierFor(140_000, 'single')?.tier).toBe(2);
    expect(irmaaTierFor(180_000, 'single')?.tier).toBe(3);
    expect(irmaaTierFor(250_000, 'single')?.tier).toBe(4);
    expect(irmaaTierFor(600_000, 'single')?.tier).toBe(5);
  });

  it('maps 2026 MAGI to tiers (MFJ) and estimates the surcharge', () => {
    expect(irmaaTierFor(218_000, 'mfj')).toBeNull();
    const tier1 = irmaaTierFor(250_000, 'mfj');
    expect(tier1?.tier).toBe(1);
    // Tier 1: Part B surcharge 202.90 x 0.4 = 81.16 + Part D 14.50 = 95.66/mo
    expect(tier1?.monthlySurcharge).toBeCloseTo(95.66, 2);
    expect(tier1?.annualSurcharge).toBeCloseTo(95.66 * 12, 1);
    expect(irmaaTierFor(800_000, 'mfj')?.tier).toBe(5);
  });

  it('engine flags IRMAA only from age 63 (two-year lookback)', () => {
    const big = {
      startingBalances: { taxable: 0, traditional: 2_000_000, roth: 0, hsa: 0 },
      annualSpending: 0,
      conversions: { enabled: true, targetBracketRate: 0.24 },
    };
    // Conversion fills to the 24% top (201,775 + 16,100 std ded = 217,875
    // of AGI) — above the single tier-4 threshold of 205,000.
    const at64 = runDrawdown(baseInputs({ ...big, currentAge: 64, retirementAge: 64, endAge: 64 }));
    expect(at64.rows[0].irmaa?.tier).toBe(4);
    expect(at64.summary.irmaaYearCount).toBe(1);
    expect(at64.summary.irmaaAges).toEqual([64]);

    const at55 = runDrawdown(baseInputs({ ...big, currentAge: 55, retirementAge: 55, endAge: 55 }));
    expect(at55.rows[0].agi).toBeGreaterThan(205_000);
    expect(at55.rows[0].irmaa).toBeNull();
    expect(at55.summary.irmaaYearCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Depletion                                                           */
/* ------------------------------------------------------------------ */

describe('depletion detection', () => {
  it('reports the age money first fails to cover spending', () => {
    const result = runDrawdown(baseInputs({
      currentAge: 65,
      retirementAge: 65,
      endAge: 75,
      startingBalances: { taxable: 100_000, traditional: 0, roth: 0, hsa: 0 },
      annualSpending: 60_000,
    }));
    // Year 1 spends 60k (tax-free: gains sit inside the 0% LTCG band);
    // year 2 has only 40k left -> 20k shortfall.
    expect(result.summary.depletionAge).toBe(66);
    const y2 = result.rows[1];
    expect(y2.shortfall).toBeCloseTo(20_000, 0);
    expect(y2.endTotal).toBe(0);
    // Later years remain fully short.
    expect(result.rows[3].shortfall).toBeCloseTo(60_000, 0);
  });

  it('reports null when the plan survives to the end age', () => {
    const result = runDrawdown(baseInputs({
      endAge: 70,
      startingBalances: { taxable: 2_000_000, traditional: 0, roth: 0, hsa: 0 },
    }));
    expect(result.summary.depletionAge).toBeNull();
    expect(result.rows.every(r => r.shortfall === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Full-scenario smoke test + compare mode                             */
/* ------------------------------------------------------------------ */

describe('full scenario smoke test', () => {
  const scenario = baseInputs({
    currentAge: 60,
    spouseAge: 58,
    retirementAge: 62,
    endAge: 90,
    filingStatus: 'mfj',
    state: 'CO',
    startingBalances: { taxable: 400_000, traditional: 1_200_000, roth: 200_000, hsa: 100_000 },
    nominalReturns: { taxable: 0.05, traditional: 0.05, roth: 0.05, hsa: 0.05 },
    annualSpending: 90_000,
    inflationRate: 0.025,
    socialSecurity: { startAge: 67, annualBenefit: 42_000 },
    conversions: { enabled: true, targetBracketRate: 0.22 },
  });

  it('produces a sane year-by-year projection', () => {
    const result = runDrawdown(scenario);
    expect(result.rows).toHaveLength(31); // ages 60..90 inclusive
    expect(result.summary.rmdStartAge).toBe(75); // born 1966

    for (const [i, row] of result.rows.entries()) {
      expect(row.year).toBe(2026 + i);
      expect(row.age).toBe(60 + i);
      expect(row.spouseAge).toBe(58 + i);
      // No NaNs anywhere and everything non-negative.
      const values = [
        row.spendingNeed, row.socialSecurity, row.rmd, row.conversion,
        row.agi, row.federalTax, row.stateTax, row.totalTax, row.shortfall,
        row.withdrawals.taxable, row.withdrawals.traditional,
        row.withdrawals.roth, row.withdrawals.hsa,
        row.endBalances.taxable, row.endBalances.traditional,
        row.endBalances.roth, row.endBalances.hsa, row.endTotal,
      ];
      for (const v of values) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      // Withdrawals + conversions never exceed what the bucket held.
      expect(row.withdrawals.traditional + row.conversion)
        .toBeLessThanOrEqual(row.startBalances.traditional + 0.01);
      expect(row.withdrawals.taxable).toBeLessThanOrEqual(row.startBalances.taxable + 0.01);
      // Pre-retirement years have no spending or withdrawals.
      if (row.age < 62) {
        expect(row.spendingNeed).toBe(0);
        expect(row.withdrawals.taxable + row.withdrawals.traditional).toBe(0);
      }
      // Social Security starts at 67, indexed by inflation.
      if (row.age < 67) expect(row.socialSecurity).toBe(0);
      else expect(row.socialSecurity).toBeCloseTo(42_000 * Math.pow(1.025, row.age - 60), 0);
      // Conversions stop at the RMD start age.
      if (row.age >= 75) expect(row.conversion).toBe(0);
    }

    // Conversions happen in the pre-RMD retirement window.
    const conversionYears = result.rows.filter(r => r.conversion > 0);
    expect(conversionYears.length).toBeGreaterThan(0);
    expect(conversionYears.every(r => r.age >= 62 && r.age < 75)).toBe(true);
    expect(result.summary.totalConversions).toBeGreaterThan(0);
    expect(result.summary.lifetimeTax).toBeGreaterThan(0);
    expect(result.summary.lifetimeTax)
      .toBeCloseTo(result.summary.lifetimeFederalTax + result.summary.lifetimeStateTax, 1);
  });

  it('RMDs kick in at 75 when conversions are off', () => {
    const result = runDrawdown({ ...scenario, conversions: { enabled: false, targetBracketRate: 0.22 } });
    const at74 = result.rows.find(r => r.age === 74)!;
    const at75 = result.rows.find(r => r.age === 75)!;
    expect(at74.rmd).toBe(0);
    expect(at75.rmd).toBeGreaterThan(0);
    expect(at75.rmd).toBeCloseTo(at75.startBalances.traditional / 24.6, 0);
  });

  it('compare mode reports consistent deltas', () => {
    const cmp = compareConversions(scenario);
    const on = cmp.withConversions.summary;
    const off = cmp.withoutConversions.summary;

    expect(on.totalConversions).toBeGreaterThan(0);
    expect(off.totalConversions).toBe(0);
    expect(cmp.delta.lifetimeTaxSavings).toBeCloseTo(off.lifetimeTax - on.lifetimeTax, 1);
    expect(cmp.delta.endingRoth)
      .toBeCloseTo(on.endingBalances.roth - off.endingBalances.roth, 1);
    // Conversions move money into Roth and shrink traditional.
    expect(cmp.delta.endingRoth).toBeGreaterThan(0);
    expect(cmp.delta.endingTraditional).toBeLessThan(0);
    // Neither plan runs out of money in this scenario.
    expect(on.depletionAge).toBeNull();
    expect(off.depletionAge).toBeNull();
  });
});
