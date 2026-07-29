/**
 * Farm formalization analyzer — pure scenario math tests.
 * Exercises only the exported pure functions (no prisma / no I/O).
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeFarmScenarios,
  type FarmAnalysisInput,
} from '../farm-analysis';
import {
  NC_LLC_ANNUAL_REPORT_FEE,
  NC_LLC_FORMATION_FEE,
} from '../nc-farm-rules';

/** Baseline: NC MFJ household, $12k honey income, $5k expenses, W-2 day job. */
function baseInput(overrides: Partial<FarmAnalysisInput> = {}): FarmAnalysisInput {
  return {
    year: 2025,
    filingStatus: 'mfj',
    taxState: 'NC',
    grossFarmIncome: 12_000,
    farmExpenses: 5_000,
    plannedEquipmentPurchases: 0,
    annualTaxableFarmPurchases: 3_000,
    combinedSalesTaxRate: 0.07,
    priorYearFarmIncome: 11_000,
    acreage: null,
    isFirstLlcYear: true,
    otherHouseholdOrdinaryIncome: 90_000,
    otherHouseholdW2Wages: 90_000,
    ...overrides,
  };
}

describe('analyzeFarmScenarios — scenario math', () => {
  it('Schedule F beats hobby when real expenses exist', () => {
    const result = analyzeFarmScenarios(baseInput());
    const { hobby, schedule_f } = result.scenarios;
    // Hobby taxes the full $12k with no deductions; Schedule F taxes $7k
    // net (minus QBI) plus SE tax, and adds sales-tax savings.
    expect(schedule_f.totalCost).toBeLessThan(hobby.totalCost);
    expect(result.scheduleFVsHobby).toBeGreaterThan(0);
    expect(result.best).toBe('schedule_f');
  });

  it('hobby can win with near-zero expenses and no exempt purchases (SE tax > deduction value)', () => {
    const result = analyzeFarmScenarios(
      baseInput({
        farmExpenses: 0,
        annualTaxableFarmPurchases: 0,
        priorYearFarmIncome: 0, // no sales-tax savings either
      }),
    );
    const { hobby, schedule_f } = result.scenarios;
    // Same taxable income base, but Schedule F adds ~14.1% SE tax.
    expect(hobby.totalCost).toBeLessThan(schedule_f.totalCost);
    expect(result.best).toBe('hobby');
  });

  it('LLC vs sole prop delta is exactly the NC fees (disregarded entity invariant)', () => {
    const first = analyzeFarmScenarios(baseInput({ isFirstLlcYear: true }));
    expect(first.llcVsSoleProp).toBeCloseTo(
      NC_LLC_ANNUAL_REPORT_FEE + NC_LLC_FORMATION_FEE,
      2,
    );
    const later = analyzeFarmScenarios(baseInput({ isFirstLlcYear: false }));
    expect(later.llcVsSoleProp).toBeCloseTo(NC_LLC_ANNUAL_REPORT_FEE, 2);
    // Tax lines are identical between the two Schedule F scenarios.
    const { schedule_f, schedule_f_llc } = first.scenarios;
    expect(schedule_f_llc.incomeTax).toBe(schedule_f.incomeTax);
    expect(schedule_f_llc.seTax).toBe(schedule_f.seTax);
    expect(schedule_f_llc.stateTax).toBe(schedule_f.stateTax);
    expect(schedule_f_llc.salesTaxSavings).toBe(schedule_f.salesTaxSavings);
  });

  it('unreported_cash is zero-cost but never recommended', () => {
    const result = analyzeFarmScenarios(baseInput());
    const cash = result.scenarios.unreported_cash;
    expect(cash.totalCost).toBe(0);
    expect(cash.compliant).toBe(false);
    expect(result.best).not.toBe('unreported_cash');
    expect(result.costOfCompliance).toBeGreaterThan(0);
    expect(
      result.warnings.some((w) => w.includes('legally required to be reported')),
    ).toBe(true);
  });

  it('gates sales-tax savings on the prior-year $10k threshold', () => {
    const qualified = analyzeFarmScenarios(baseInput({ priorYearFarmIncome: 11_000 }));
    expect(qualified.qualifiesForSalesTaxExemption).toBe(true);
    expect(qualified.salesTaxSavingsBasis).toBe('qualifying');
    expect(qualified.scenarios.schedule_f.salesTaxSavings).toBeCloseTo(3_000 * 0.07, 2);

    // Current year clears $10k but prior year doesn't → conditional path.
    const conditional = analyzeFarmScenarios(baseInput({ priorYearFarmIncome: 4_000 }));
    expect(conditional.qualifiesForSalesTaxExemption).toBe(false);
    expect(conditional.conditionalFarmerPath).toBe(true);
    expect(conditional.salesTaxSavingsBasis).toBe('conditional');
    expect(conditional.scenarios.schedule_f.salesTaxSavings).toBeGreaterThan(0);
    expect(conditional.warnings.some((w) => w.includes('E-595CF'))).toBe(true);

    // Below-threshold current income still gets the conditional (intent-
    // based) path, with a stronger clawback warning.
    const smallFarm = analyzeFarmScenarios(
      baseInput({ grossFarmIncome: 6_000, priorYearFarmIncome: 4_000 }),
    );
    expect(smallFarm.salesTaxSavingsBasis).toBe('conditional');
    expect(smallFarm.warnings.some((w) => w.includes('clawback risk is real'))).toBe(true);

    // No farming income at all → no savings.
    const none = analyzeFarmScenarios(
      baseInput({ grossFarmIncome: 0, priorYearFarmIncome: 0 }),
    );
    expect(none.salesTaxSavingsBasis).toBe('none');
    expect(none.scenarios.schedule_f.salesTaxSavings).toBe(0);
  });

  it('qualifies through the three-preceding-year average when the latest year is below $10k', () => {
    const result = analyzeFarmScenarios(baseInput({
      priorYearFarmIncome: 8_000,
      priorThreeYearFarmIncome: [8_000, 11_000, 13_000],
    }));

    expect(result.priorThreeYearAverage).toBeCloseTo(10_666.67, 2);
    expect(result.qualifiesForSalesTaxExemption).toBe(true);
    expect(result.salesTaxSavingsBasis).toBe('qualifying');
    expect(result.warnings.some((warning) => warning.includes('average test qualifies'))).toBe(true);
  });

  it('clamps §179 to total business income (farm + wages) and flags it', () => {
    // With no wages or other SE income, the limit is farm profit ($7k).
    const clamped = analyzeFarmScenarios(
      baseInput({
        plannedEquipmentPurchases: 20_000,
        otherHouseholdOrdinaryIncome: 0,
        otherHouseholdW2Wages: 0,
      }),
    );
    expect(clamped.section179Clamped).toBe(true);
    expect(clamped.scenarios.schedule_f.section179Deduction).toBeCloseTo(7_000, 2);
    expect(clamped.warnings.some((w) => w.includes('§179'))).toBe(true);

    // W-2 wages count toward the §179 business-income limit (Form 4562), so
    // the same purchase is fully deductible for a wage-earning household —
    // creating a farm loss that offsets wages.
    const withWages = analyzeFarmScenarios(
      baseInput({ plannedEquipmentPurchases: 20_000 }),
    );
    expect(withWages.section179Clamped).toBe(false);
    expect(withWages.scenarios.schedule_f.section179Deduction).toBeCloseTo(20_000, 2);

    const unclamped = analyzeFarmScenarios(
      baseInput({ plannedEquipmentPurchases: 2_000 }),
    );
    expect(unclamped.section179Clamped).toBe(false);
    expect(unclamped.scenarios.schedule_f.section179Deduction).toBeCloseTo(2_000, 2);
  });

  it('warns about hobby-loss risk when the farm shows no net profit', () => {
    const losing = analyzeFarmScenarios(baseInput({ farmExpenses: 15_000 }));
    expect(losing.warnings.some((w) => w.includes('§183'))).toBe(true);

    const profitable = analyzeFarmScenarios(baseInput());
    expect(profitable.warnings.some((w) => w.includes('§183'))).toBe(false);
  });

  it('emits a PUV hint keyed on acreage, null when acreage unknown', () => {
    expect(analyzeFarmScenarios(baseInput()).puvHint).toBeNull();

    const eligible = analyzeFarmScenarios(baseInput({ acreage: 12 }));
    expect(eligible.puvHint?.eligible).toBe(true);

    const small = analyzeFarmScenarios(baseInput({ acreage: 2 }));
    expect(small.puvHint?.eligible).toBe(false);
  });

  it('best minimizes totalCost among compliant scenarios', () => {
    const result = analyzeFarmScenarios(baseInput());
    const { hobby, schedule_f, schedule_f_llc } = result.scenarios;
    const min = Math.min(hobby.totalCost, schedule_f.totalCost, schedule_f_llc.totalCost);
    expect(result.scenarios[result.best].totalCost).toBe(min);
  });

  it('NC state tax is higher for hobby than Schedule F (deduction loss hits the flat rate)', () => {
    const result = analyzeFarmScenarios(baseInput());
    // Hobby AGI includes the gross $12k; Schedule F only nets $7k.
    expect(result.scenarios.hobby.stateTax).toBeGreaterThan(
      result.scenarios.schedule_f.stateTax,
    );
  });

  it('flags the March 1 farmer rule when farming dominates household income', () => {
    const farmer = analyzeFarmScenarios(
      baseInput({ otherHouseholdOrdinaryIncome: 3_000, otherHouseholdW2Wages: 3_000 }),
    );
    expect(farmer.warnings.some((w) => w.includes('March 1'))).toBe(true);

    const sideline = analyzeFarmScenarios(baseInput());
    expect(sideline.warnings.some((w) => w.includes('March 1'))).toBe(false);
  });
});
