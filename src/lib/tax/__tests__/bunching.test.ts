import { describe, it, expect } from 'vitest';
import { compareBunching } from '@/lib/tax/bunching';

describe('compareBunching', () => {
  // Canonical MFJ-ish scenario: $10k SALT+mortgage, $30k standard deduction,
  // $10k/yr giving, 24% marginal, bunch 3 years.
  const base = {
    annualGiving: 10_000,
    bunchYears: 3,
    otherItemizable: 10_000,
    standardDeduction: 30_000,
    marginalRate: 0.24,
  };

  it('yearly strategy never itemizes when itemized total stays under standard', () => {
    const c = compareBunching(base);
    // 10k other + 10k gift = 20k < 30k standard every year
    expect(c.yearly.years.every(y => !y.itemized)).toBe(true);
    expect(c.yearly.totalDeductions).toBe(90_000); // 3 x 30k standard
    expect(c.yearly.extraDeductionsVsStandard).toBe(0);
    expect(c.yearly.taxSavingsVsStandard).toBe(0);
  });

  it('bunched strategy itemizes year 1 and takes standard afterward', () => {
    const c = compareBunching(base);
    // Year 1: 10k other + 30k bunched gifts = 40k itemized > 30k standard
    expect(c.bunched.years[0].itemized).toBe(true);
    expect(c.bunched.years[0].deductionTaken).toBe(40_000);
    expect(c.bunched.years[1].itemized).toBe(false);
    expect(c.bunched.years[1].deductionTaken).toBe(30_000);
    expect(c.bunched.years[2].deductionTaken).toBe(30_000);
    expect(c.bunched.totalDeductions).toBe(100_000);
  });

  it('computes extra deductions and tax savings from bunching', () => {
    const c = compareBunching(base);
    expect(c.extraDeductions).toBe(10_000); // 100k - 90k
    expect(c.extraTaxSavings).toBe(2_400);  // 10k x 24%
    expect(c.totalGiving).toBe(30_000);     // same dollars donated either way
  });

  it('shows no advantage when yearly giving already clears the standard deduction', () => {
    // Big giver: itemizes every year either way; bunching just shifts timing.
    const c = compareBunching({
      annualGiving: 40_000,
      bunchYears: 2,
      otherItemizable: 10_000,
      standardDeduction: 30_000,
      marginalRate: 0.32,
    });
    // Yearly: (10k + 40k) x 2 = 100k. Bunched: (10k + 80k) + 30k = 120k.
    // Bunching still wins here because year 2 falls back to the standard
    // deduction (30k > 10k itemized) — the "free" standard deduction year.
    expect(c.yearly.totalDeductions).toBe(100_000);
    expect(c.bunched.totalDeductions).toBe(120_000);
    expect(c.extraDeductions).toBe(20_000);
    expect(c.extraTaxSavings).toBe(6_400);
  });

  it('shows zero advantage with no other itemizables and enormous standard deduction', () => {
    const c = compareBunching({
      annualGiving: 1_000,
      bunchYears: 3,
      otherItemizable: 0,
      standardDeduction: 100_000,
      marginalRate: 0.22,
    });
    expect(c.extraDeductions).toBe(0);
    expect(c.extraTaxSavings).toBe(0);
  });

  it('clamps bad inputs: negative giving, rate over 1, fractional horizon', () => {
    const c = compareBunching({
      annualGiving: -5,
      bunchYears: 2.9,
      otherItemizable: -1,
      standardDeduction: 30_000,
      marginalRate: 1.5,
    });
    expect(c.horizon).toBe(2);
    expect(c.totalGiving).toBe(0);
    expect(c.yearly.totalDeductions).toBe(60_000);
    expect(c.extraTaxSavings).toBe(0);
  });

  it('total dollars donated match between strategies', () => {
    const c = compareBunching({ ...base, annualGiving: 7_333.33 });
    const yearlySum = c.yearly.years.reduce((s, y) => s + y.giving, 0);
    const bunchedSum = c.bunched.years.reduce((s, y) => s + y.giving, 0);
    expect(Math.round(yearlySum * 100)).toBe(Math.round(bunchedSum * 100));
  });
});
