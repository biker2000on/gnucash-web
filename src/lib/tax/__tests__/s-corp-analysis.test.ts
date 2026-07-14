/**
 * S-corp election analyzer — pure scenario math tests.
 * Exercises only the exported pure functions (no prisma / no I/O).
 */

import { describe, expect, it } from 'vitest';
import {
  compareScenarios,
  soloEmployerCapacity,
  SWEEP_SALARY_FLOOR,
  type CompareScenariosInput,
} from '../s-corp-analysis';
import { getYearStatusParams, taxFromBrackets } from '../federal';

/** Baseline input: 100%-owned MFJ pass-through with default S-corp costs. */
function baseInput(overrides: Partial<CompareScenariosInput> = {}): CompareScenariosInput {
  return {
    year: 2025,
    filingStatus: 'mfj',
    annualProfit: 150_000,
    ownershipPercent: 100,
    reasonableSalary: 60_000,
    payrollServiceCost: 600,
    taxPrepCost: 800,
    stateFranchiseTax: 200,
    otherHouseholdOrdinaryIncome: 0,
    ...overrides,
  };
}

describe('compareScenarios — scenario math', () => {
  it('produces positive savings at high profit ($150k, MFJ) with default costs', () => {
    const result = compareScenarios(baseInput());
    expect(result.savings).toBeGreaterThan(0);
    // Sanity: both scenarios carry real employment tax and income tax.
    expect(result.llc.seTaxOrFica).toBeGreaterThan(15_000);
    expect(result.scorp.seTaxOrFica).toBeGreaterThan(5_000);
    expect(result.scorp.seTaxOrFica).toBeLessThan(result.llc.seTaxOrFica);
    // Savings identity: llc.totalCost − scorp.totalCost.
    expect(result.savings).toBeCloseTo(result.llc.totalCost - result.scorp.totalCost, 2);
  });

  it('produces negative savings at low profit (~$20k) with default costs', () => {
    // At $20k profit the salary is clamped to the full profit, so the S-corp
    // pays the same employment tax base PLUS payroll/prep/franchise costs.
    const result = compareScenarios(
      baseInput({ annualProfit: 20_000, reasonableSalary: 20_000 }),
    );
    expect(result.savings).toBeLessThan(0);
  });

  it('lower salary → more S-corp savings (holding everything else constant)', () => {
    const high = compareScenarios(baseInput({ reasonableSalary: 90_000 }));
    const mid = compareScenarios(baseInput({ reasonableSalary: 60_000 }));
    const low = compareScenarios(baseInput({ reasonableSalary: 40_000 }));
    expect(low.savings).toBeGreaterThan(mid.savings);
    expect(mid.savings).toBeGreaterThan(high.savings);
  });

  it('clamps salary at profit and flags it', () => {
    const result = compareScenarios(
      baseInput({ annualProfit: 50_000, reasonableSalary: 100_000 }),
    );
    expect(result.salaryClamped).toBe(true);
    expect(result.scorp.salaryUsed).toBe(50_000);
    // No distributable profit remains beyond the (negative) cost drag.
    expect(result.scorp.k1Income).toBeLessThanOrEqual(0);

    const unclamped = compareScenarios(
      baseInput({ annualProfit: 50_000, reasonableSalary: 30_000 }),
    );
    expect(unclamped.salaryClamped).toBe(false);
    expect(unclamped.scorp.salaryUsed).toBe(30_000);
  });

  it('QBI reduces income tax in both scenarios', () => {
    const input = baseInput();
    const result = compareScenarios(input);
    const p = getYearStatusParams(input.year, input.filingStatus);

    // Both scenarios claim a QBI deduction (LLC on profit − ½SE, S-corp on
    // the K-1 share only — salary is not QBI).
    expect(result.llc.qbiDeduction).toBeGreaterThan(0);
    expect(result.scorp.qbiDeduction).toBeGreaterThan(0);
    // The LLC's QBI base (whole profit) exceeds the S-corp's (K-1 only).
    expect(result.llc.qbiDeduction).toBeGreaterThan(result.scorp.qbiDeduction);

    // Removing the QBI deduction from taxable income yields strictly more
    // bracket tax than the reported income tax in each scenario.
    for (const s of [result.llc, result.scorp]) {
      const taxWithoutQbi = taxFromBrackets(s.taxableIncome + s.qbiDeduction, p.brackets);
      expect(s.incomeTax).toBeLessThan(taxWithoutQbi);
    }
  });

  it('breakeven curve sweeps 10k → max(200k, 2×profit) in 5k steps and crosses once', () => {
    const result = compareScenarios(baseInput({ annualProfit: 150_000 }));
    const curve = result.breakevenCurve;

    expect(curve[0].profit).toBe(10_000);
    expect(curve[curve.length - 1].profit).toBeGreaterThanOrEqual(200_000);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].profit - curve[i - 1].profit).toBe(5_000);
    }

    // Negative at the low end, positive at the high end, and once savings
    // turn positive they stay positive (monotonic-ish single crossing).
    expect(curve[0].savings).toBeLessThan(0);
    expect(curve[curve.length - 1].savings).toBeGreaterThan(0);
    const firstPositive = curve.findIndex(pt => pt.savings > 0);
    expect(firstPositive).toBeGreaterThan(0);
    for (let i = firstPositive; i < curve.length; i++) {
      expect(curve[i].savings).toBeGreaterThan(0);
    }

    // breakevenProfit is the first sweep point where savings > 0.
    expect(result.breakevenProfit).toBe(curve[firstPositive].profit);
  });

  it('reports null breakeven when the S-corp never wins', () => {
    // Enormous fixed costs swamp any employment-tax savings on the swept range.
    const result = compareScenarios(
      baseInput({
        payrollServiceCost: 50_000,
        taxPrepCost: 50_000,
        stateFranchiseTax: 50_000,
      }),
    );
    expect(result.breakevenProfit).toBeNull();
    expect(result.breakevenCurve.every(pt => pt.savings <= 0)).toBe(true);
  });

  it('sweep applies the salary ratio with the $30k floor and profit cap', () => {
    // ratio = 60k/150k = 0.4 → at 10k profit the floored salary (30k) is
    // capped at profit (10k): salary == profit, so k1 is only the cost drag
    // and the point must be a loss.
    const result = compareScenarios(baseInput());
    expect(SWEEP_SALARY_FLOOR).toBe(30_000);
    expect(result.breakevenCurve[0].savings).toBeLessThan(0);
  });

  it('household W-2 wages consume the SS wage base and shrink LLC SE tax', () => {
    const withoutWages = compareScenarios(baseInput());
    const withWages = compareScenarios(
      baseInput({
        otherHouseholdOrdinaryIncome: 180_000,
        otherHouseholdW2Wages: 180_000, // above the 2025 base of $176,100
      }),
    );
    // With the SS base fully consumed by W-2 wages, the LLC only pays the
    // Medicare portion of SE tax — dramatically less than the full 15.3%.
    expect(withWages.llc.seTaxOrFica).toBeLessThan(withoutWages.llc.seTaxOrFica / 2);
  });

  it('ownership percent scales the owner profit share', () => {
    const full = compareScenarios(baseInput());
    const half = compareScenarios(baseInput({ ownershipPercent: 50 }));
    expect(half.llc.grossOwnerIncome).toBeCloseTo(full.llc.grossOwnerIncome / 2, 2);
    expect(half.llc.seTaxOrFica).toBeLessThan(full.llc.seTaxOrFica);
  });
});

describe('soloEmployerCapacity', () => {
  it('S-corp capacity is 25% of salary', () => {
    expect(soloEmployerCapacity(2025, 's_corp', 60_000)).toBeCloseTo(15_000, 2);
    expect(soloEmployerCapacity(2025, 's_corp', 0)).toBe(0);
  });

  it('pass-through capacity is 20% of (profit − ½ SE tax)', () => {
    // 2024, $100k profit: net earnings 92,350; SE tax 15.3% = 14,129.55;
    // half = 7,064.78 → 20% × (100,000 − 7,064.78) = 18,587.04.
    expect(soloEmployerCapacity(2024, 'pass_through', 100_000)).toBeCloseTo(18_587.04, 1);
    expect(soloEmployerCapacity(2024, 'pass_through', 0)).toBe(0);
  });
});
