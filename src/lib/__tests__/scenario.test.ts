/**
 * Scenario Sandbox engine tests — amortization math, delta application,
 * negative-month detection, itemize-vs-standard, FIRE date shift direction,
 * and the net-worth projection with assets + loans. Pure engine, no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  computeLoanSchedule,
  cursorFromIso,
  monthIndexOf,
  monthKeyAt,
  runScenario,
  toTaxYear,
} from '@/lib/scenario/engine';
import type {
  Scenario,
  ScenarioBaseline,
  ScenarioDelta,
} from '@/lib/scenario/types';
import { normalizeScenario } from '@/lib/scenario/types';
import { emptyFederalInputs } from '@/lib/tax/federal';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeBaseline(overrides: Partial<ScenarioBaseline> = {}): ScenarioBaseline {
  const fed = emptyFederalInputs(2026, 'mfj');
  fed.wages = 150_000;
  return {
    asOfDate: '2026-01-15',
    netWorth: 500_000,
    liquidBalance: 20_000,
    investedAssets: 300_000,
    monthlyIncome: 10_000,
    monthlyExpenses: 7_000,
    monthlyNet: 3_000,
    savingsRatePct: 30,
    filingStatus: 'mfj',
    state: 'TX', // no state income tax → federal-only deltas in tests
    stateFlatRatePct: 0,
    currentAge: 40,
    currentTaxYear: 2026,
    nextTaxYear: 2026,
    federalInputsCurrentYear: fed,
    federalInputsNextYear: { ...fed },
    ...overrides,
  };
}

function scenarioOf(...deltas: ScenarioDelta[]): Scenario {
  return { name: 'test', deltas };
}

/* ------------------------------------------------------------------ */
/* Amortization                                                        */
/* ------------------------------------------------------------------ */

describe('computeLoanSchedule', () => {
  it('computes the standard payment for a 30-year loan', () => {
    const s = computeLoanSchedule(300_000, 6, 360);
    expect(s.monthlyPayment).toBeCloseTo(1798.65, 1);
    expect(s.months).toHaveLength(360);
  });

  it('splits interest and principal correctly in month 1', () => {
    const s = computeLoanSchedule(400_000, 6, 360);
    // 400,000 * 0.5%/mo = 2,000 first-month interest
    expect(s.months[0].interest).toBeCloseTo(2000, 2);
    expect(s.months[0].principal).toBeCloseTo(s.monthlyPayment - 2000, 1);
  });

  it('amortizes to exactly zero and sums total interest', () => {
    const s = computeLoanSchedule(300_000, 6, 360);
    expect(s.months[359].balance).toBe(0);
    // Known figure for 300k @ 6% / 360mo
    expect(s.totalInterest).toBeGreaterThan(347_000);
    expect(s.totalInterest).toBeLessThan(348_100);
    const principalSum = s.months.reduce((sum, m) => sum + m.principal, 0);
    expect(principalSum).toBeCloseTo(300_000, 0);
  });

  it('handles zero-rate loans as straight-line principal', () => {
    const s = computeLoanSchedule(12_000, 0, 12);
    expect(s.monthlyPayment).toBeCloseTo(1000, 2);
    expect(s.totalInterest).toBe(0);
    expect(s.months[11].balance).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Month helpers                                                       */
/* ------------------------------------------------------------------ */

describe('month helpers', () => {
  it('maps dates to month indexes relative to the cursor', () => {
    const start = cursorFromIso('2026-01-15');
    expect(monthIndexOf('2026-01-01', start)).toBe(0);
    expect(monthIndexOf('2026-03-31', start)).toBe(2);
    expect(monthIndexOf('2027-01-01', start)).toBe(12);
    expect(monthIndexOf('2025-12-01', start)).toBe(-1);
    expect(monthKeyAt(start, 0)).toBe('2026-01');
    expect(monthKeyAt(start, 13)).toBe('2027-02');
  });

  it('clamps tax rule years to the supported range', () => {
    expect(toTaxYear(2023)).toBe(2024);
    expect(toTaxYear(2025)).toBe(2025);
    expect(toTaxYear(2031)).toBe(2026);
  });
});

/* ------------------------------------------------------------------ */
/* Delta application                                                   */
/* ------------------------------------------------------------------ */

describe('delta application (cash flow)', () => {
  it('applies a one-time outflow only in its month', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'a', kind: 'one_time', label: 'Down payment',
        startDate: '2026-03-01', amount: -5000,
      }),
    );
    const months = result.cashFlow.months;
    const march = months.find(m => m.month === '2026-03')!;
    const feb = months.find(m => m.month === '2026-02')!;
    const april = months.find(m => m.month === '2026-04')!;
    expect(march.scenarioNet).toBeCloseTo(march.baselineNet - 5000, 2);
    expect(feb.scenarioNet).toBeCloseTo(feb.baselineNet, 2);
    expect(april.scenarioNet).toBeCloseTo(april.baselineNet, 2);
  });

  it('ignores one-time deltas dated before the projection start', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'a', kind: 'one_time', label: 'Old windfall',
        startDate: '2025-06-01', amount: 50_000,
      }),
    );
    for (const m of result.cashFlow.months) {
      expect(m.scenarioNet).toBeCloseTo(m.baselineNet, 2);
    }
  });

  it('grows a recurring delta annually and honors its end date', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'r', kind: 'recurring', label: 'New expense',
        startDate: '2026-01-01', monthlyAmount: -100,
        annualGrowthPct: 10, endDate: '2027-06-30', taxTreatment: 'none',
      }),
    );
    const months = result.cashFlow.months;
    const jan26 = months.find(m => m.month === '2026-01')!;
    const jan27 = months.find(m => m.month === '2027-01')!;
    const jun27 = months.find(m => m.month === '2027-06')!;
    const jul27 = months.find(m => m.month === '2027-07')!;
    expect(jan26.scenarioNet).toBeCloseTo(jan26.baselineNet - 100, 2);
    expect(jan27.scenarioNet).toBeCloseTo(jan27.baselineNet - 110, 2); // +10% after 12 months
    expect(jun27.scenarioNet).toBeCloseTo(jun27.baselineNet - 110, 2);
    expect(jul27.scenarioNet).toBeCloseTo(jul27.baselineNet, 2); // ended
  });

  it('applies loan payments for exactly the loan term', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'l', kind: 'loan', label: 'Car loan',
        startDate: '2026-02-01', principal: 24_000, annualRatePct: 0, termMonths: 24,
      }),
    );
    const months = result.cashFlow.months;
    const jan = months.find(m => m.month === '2026-01')!;
    const feb = months.find(m => m.month === '2026-02')!;
    const lastPaid = months.find(m => m.month === '2028-01')!; // month 24 of the loan
    const after = months.find(m => m.month === '2028-02')!;
    expect(jan.scenarioNet).toBeCloseTo(jan.baselineNet, 2);
    expect(feb.scenarioNet).toBeCloseTo(feb.baselineNet - 1000, 2);
    expect(lastPaid.scenarioNet).toBeCloseTo(lastPaid.baselineNet - 1000, 2);
    expect(after.scenarioNet).toBeCloseTo(after.baselineNet, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Negative-month detection                                            */
/* ------------------------------------------------------------------ */

describe('negative-month detection', () => {
  it('flags the months where the scenario liquid balance goes negative', () => {
    const baseline = makeBaseline({
      liquidBalance: 1000,
      monthlyIncome: 7000,
      monthlyExpenses: 7000,
      monthlyNet: 0,
    });
    const result = runScenario(
      baseline,
      scenarioOf({
        id: 'r', kind: 'recurring', label: 'Drain',
        startDate: '2026-01-01', monthlyAmount: -500, taxTreatment: 'none',
      }),
    );
    // Balances: Jan 500, Feb 0, Mar -500, ...
    expect(result.cashFlow.firstNegativeMonth).toBe('2026-03');
    expect(result.cashFlow.negativeMonths).toContain('2026-03');
    expect(result.cashFlow.negativeMonths).not.toContain('2026-02');
    expect(result.cashFlow.baselineGoesNegative).toBe(false);
  });

  it('does not flag anything when the scenario stays positive', () => {
    const result = runScenario(makeBaseline(), scenarioOf());
    expect(result.cashFlow.negativeMonths).toHaveLength(0);
    expect(result.cashFlow.firstNegativeMonth).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Itemize vs standard                                                 */
/* ------------------------------------------------------------------ */

describe('itemize-vs-standard decision', () => {
  it('itemizes when mortgage interest + property tax beat the standard deduction', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf(
        {
          id: 'l', kind: 'loan', label: 'Mortgage',
          startDate: '2026-01-01', principal: 400_000, annualRatePct: 6,
          termMonths: 360, interestDeductible: true,
        },
        {
          id: 'p', kind: 'recurring', label: 'Property tax',
          startDate: '2026-01-01', monthlyAmount: -1000, taxTreatment: 'property_tax',
        },
      ),
    );
    const current = result.tax.currentYear;
    // Baseline (wages only) takes the standard deduction
    expect(current.baseline.usedItemized).toBe(false);
    // ~23.9k first-year interest + 12k property tax > 2026 MFJ standard deduction
    expect(current.scenario.usedItemized).toBe(true);
    expect(current.itemizeDecision.picked).toBe('itemized');
    expect(current.itemizeDecision.itemized).toBeGreaterThan(current.itemizeDecision.standard);
    expect(current.itemizeDecision.advantage).toBeGreaterThan(0);
    // The deductions lower the scenario's tax
    expect(current.delta).toBeLessThan(0);
  });

  it('keeps the standard deduction for small deductible amounts', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'p', kind: 'recurring', label: 'Property tax',
        startDate: '2026-01-01', monthlyAmount: -100, taxTreatment: 'property_tax',
      }),
    );
    const current = result.tax.currentYear;
    expect(current.scenario.usedItemized).toBe(false);
    expect(current.itemizeDecision.picked).toBe('standard');
    // Deduction unchanged → no tax change
    expect(current.delta).toBeCloseTo(0, 2);
  });

  it('reduces taxes for a pre-tax contribution increase', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'c', kind: 'contribution_change', label: 'Max 401k',
        startDate: '2026-01-01', annualAmount: 10_000,
      }),
    );
    expect(result.tax.currentYear.delta).toBeLessThan(0);
    // Take-home cash still drops (deferral > tax savings)
    const feb = result.cashFlow.months.find(m => m.month === '2026-02')!;
    expect(feb.scenarioNet).toBeLessThan(feb.baselineNet);
  });

  it('raises taxes for a salary increase, prorated by months active', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'i', kind: 'income_change', label: 'Raise',
        startDate: '2026-07-01', annualAmount: 24_000,
      }),
    );
    const current = result.tax.currentYear;
    const next = result.tax.nextYear;
    expect(current.delta).toBeGreaterThan(0);
    // Only 6 months land in the current year, so next year owes more
    expect(next.delta).toBeGreaterThan(current.delta);
    expect(next.scenario.agi).toBeCloseTo(next.baseline.agi + 24_000, 0);
  });
});

/* ------------------------------------------------------------------ */
/* FIRE impact                                                         */
/* ------------------------------------------------------------------ */

describe('FIRE impact', () => {
  it('pushes FI later for a persistent new expense', () => {
    const base = runScenario(makeBaseline(), scenarioOf());
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'r', kind: 'recurring', label: 'Lifestyle creep',
        startDate: '2026-01-01', monthlyAmount: -1000, taxTreatment: 'none',
      }),
    );
    expect(base.fire.baselineYearsToFi).not.toBeNull();
    expect(result.fire.scenarioYearsToFi).not.toBeNull();
    // Higher spending raises the FI number AND lowers savings
    expect(result.fire.fiNumberScenario).toBeGreaterThan(result.fire.fiNumberBaseline);
    expect(result.fire.scenarioYearsToFi!).toBeGreaterThan(result.fire.baselineYearsToFi!);
    expect(result.fire.shiftYears!).toBeGreaterThan(0);
    expect(result.fire.method).toBe('deterministic');
  });

  it('pulls FI earlier (or equal) for an income increase', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'i', kind: 'income_change', label: 'Raise',
        startDate: '2026-01-01', annualAmount: 24_000,
      }),
    );
    expect(result.fire.scenarioYearsToFi!).toBeLessThanOrEqual(result.fire.baselineYearsToFi!);
    expect(result.fire.shiftYears!).toBeLessThanOrEqual(0);
    // Spending unchanged → same FI number
    expect(result.fire.fiNumberScenario).toBeCloseTo(result.fire.fiNumberBaseline, 2);
  });

  it('excludes finite-term recurring deltas from retirement spending', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'r', kind: 'recurring', label: 'Temporary expense',
        startDate: '2026-01-01', monthlyAmount: -1000, endDate: '2027-12-31',
        taxTreatment: 'none',
      }),
    );
    expect(result.fire.annualExpensesScenario).toBeCloseTo(
      result.fire.annualExpensesBaseline, 2,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Net worth projection                                                */
/* ------------------------------------------------------------------ */

describe('net worth projection', () => {
  it('adds a purchased asset value on top of the baseline', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'a', kind: 'asset', label: 'House value',
        startDate: '2026-01-01', value: 100_000, annualAppreciationPct: 0,
      }),
    );
    // Asset has no cash effect → scenario − baseline == asset value each year
    for (const p of result.netWorth.points.slice(1)) {
      expect(p.scenario - p.baseline).toBeCloseTo(100_000, 0);
      expect(p.scenarioAssetValue).toBeCloseTo(100_000, 0);
    }
  });

  it('appreciates the asset from the purchase month', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf({
        id: 'a', kind: 'asset', label: 'House value',
        startDate: '2026-01-01', value: 100_000, annualAppreciationPct: 3,
      }),
      { netWorthYears: 30 },
    );
    const last = result.netWorth.points[result.netWorth.points.length - 1];
    expect(last.scenarioAssetValue).toBeCloseTo(100_000 * Math.pow(1.03, 30), -2);
  });

  it('costs exactly the interest for a loan paired with the financed asset', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf(
        {
          id: 'l', kind: 'loan', label: 'Loan',
          startDate: '2026-01-01', principal: 100_000, annualRatePct: 5, termMonths: 120,
        },
        {
          id: 'a', kind: 'asset', label: 'Financed asset',
          startDate: '2026-01-01', value: 100_000, annualAppreciationPct: 0,
        },
      ),
      { netWorthYears: 15, investedReturnPct: 0 },
    );
    const points = result.netWorth.points;
    // Mid-term: loan balance is positive and declining
    const y3 = points.find(p => p.yearIndex === 3)!;
    const y8 = points.find(p => p.yearIndex === 8)!;
    expect(y3.scenarioLoanBalance).toBeGreaterThan(0);
    expect(y8.scenarioLoanBalance).toBeLessThan(y3.scenarioLoanBalance);
    // After the 10-year term: balance is zero
    const y11 = points.find(p => p.yearIndex === 11)!;
    expect(y11.scenarioLoanBalance).toBe(0);
    // With 0% invested return and a non-appreciating financed asset, the
    // total NW cost of the pair equals the total interest paid
    const schedule = computeLoanSchedule(100_000, 5, 120);
    const last = points[points.length - 1];
    expect(last.baseline - last.scenario).toBeCloseTo(schedule.totalInterest, -1);
  });

  it('combines down payment + loan + appreciating asset (buy-a-house shape)', () => {
    const result = runScenario(
      makeBaseline(),
      scenarioOf(
        {
          id: 'd', kind: 'one_time', label: 'Down payment',
          startDate: '2026-02-01', amount: -80_000,
        },
        {
          id: 'l', kind: 'loan', label: 'Mortgage',
          startDate: '2026-02-01', principal: 320_000, annualRatePct: 6,
          termMonths: 360, interestDeductible: true,
        },
        {
          id: 'a', kind: 'asset', label: 'Home value',
          startDate: '2026-02-01', value: 400_000, annualAppreciationPct: 3,
        },
      ),
      { netWorthYears: 30 },
    );
    const points = result.netWorth.points;
    const y1 = points.find(p => p.yearIndex === 1)!;
    // Right after purchase: home ≈ 400k+, loan ≈ 316k → NW roughly baseline
    // −80k (cash) −payments + asset − balance ≈ modest change, not a cliff
    expect(y1.scenarioAssetValue).toBeGreaterThan(400_000);
    expect(y1.scenarioLoanBalance).toBeGreaterThan(310_000);
    expect(y1.scenarioLoanBalance).toBeLessThan(320_000);
    // Loan fully amortized by year 32 → last point (year 30) still has balance
    const last = points[points.length - 1];
    expect(last.scenarioLoanBalance).toBeGreaterThan(0);
    expect(last.scenarioAssetValue).toBeCloseTo(400_000 * Math.pow(1.03, 29 + 11 / 12), -3);
    // Loan summary surfaces payment + interest split
    expect(result.loans).toHaveLength(1);
    expect(result.loans[0].monthlyPayment).toBeCloseTo(1918.56, 1);
    expect(result.loans[0].firstYearInterest).toBeGreaterThan(18_000);
  });
});

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

describe('normalizeScenario', () => {
  it('drops unknown kinds and coerces malformed fields', () => {
    const s = normalizeScenario(
      {
        name: 'My plan',
        deltas: [
          { kind: 'one_time', amount: '5000', startDate: '2026-03-01' },
          { kind: 'bogus', amount: 1 },
          { kind: 'loan', principal: 100000, annualRatePct: 5, termMonths: 9999 },
        ],
      },
      '2026-01-15',
    );
    expect(s.name).toBe('My plan');
    expect(s.deltas).toHaveLength(2);
    expect(s.deltas[0]).toMatchObject({ kind: 'one_time', amount: 5000 });
    // Term clamped; missing startDate falls back to today
    expect(s.deltas[1]).toMatchObject({ kind: 'loan', termMonths: 600, startDate: '2026-01-15' });
  });
});
