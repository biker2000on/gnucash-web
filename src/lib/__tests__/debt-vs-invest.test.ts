import { describe, expect, it } from 'vitest';
import { compareDebtInvestment, STRATEGIES, validateDebtInvestmentInputs, type DebtInvestmentInputs } from '../debt-vs-invest';

const base: DebtInvestmentInputs = { balance: 1200, debtRate: 0, monthlyPayment: 100, lumpSum: 0, extraMonthly: 100, annualReturn: 0, years: 1, splitPercent: 50 };

describe('debt versus investment comparison', () => {
  it('conserves the same budget with zero rates and invests freed payments', () => {
    const { plans } = compareDebtInvestment(base);
    expect(plans.payoff.payoffMonth).toBe(6);
    expect(plans.invest.payoffMonth).toBe(12);
    expect(plans.split.payoffMonth).toBe(8);
    for (const strategy of STRATEGIES) {
      expect(plans[strategy].final.netWorth).toBe(1200);
      expect(plans[strategy].final.interest).toBe(0);
    }
  });

  it('invests excess lump sums immediately and keeps initial net worth equal', () => {
    const { plans } = compareDebtInvestment({ ...base, lumpSum: 2000 });
    expect(plans.payoff.payoffMonth).toBe(0);
    expect(plans.payoff.points[0].investments).toBe(800);
    for (const s of STRATEGIES) {
      expect(plans[s].points[0].netWorth).toBe(800);
      expect(plans[s].final.netWorth).toBe(3200);
    }
  });

  it('invests unused cash in the final payment month', () => {
    const { plans } = compareDebtInvestment({ ...base, balance: 250 });
    expect(plans.payoff.points[2]).toMatchObject({ debt: 0, investments: 150 });
    expect(plans.invest.points[3]).toMatchObject({ debt: 0, investments: 350 });
  });

  it('matches a hand-calculated monthly interest and contribution example', () => {
    const { plans } = compareDebtInvestment({ ...base, balance: 1000, debtRate: 12, monthlyPayment: 100, extraMonthly: 50, lumpSum: 200, annualReturn: (1.01 ** 12 - 1) * 100 });
    expect(plans.invest.points[1].debt).toBeCloseTo(910);
    expect(plans.invest.points[1].investments).toBeCloseTo(252);
    expect(plans.payoff.points[1].debt).toBeCloseTo(658);
    expect(plans.payoff.points[1].investments).toBeCloseTo(0);
    expect(plans.payoff.points[1].netWorth).toBeCloseTo(plans.invest.points[1].netWorth);
  });

  it('ties all strategies at the effective annual break-even rate over time', () => {
    const input = { ...base, balance: 250000, debtRate: 6, monthlyPayment: 1600, lumpSum: 30000, extraMonthly: 500, years: 30 };
    const rate = compareDebtInvestment(input).breakEvenReturn!;
    expect(rate).toBeCloseTo(6.1677811864);
    const { plans } = compareDebtInvestment({ ...input, annualReturn: rate });
    for (let month = 0; month <= 360; month++) {
      expect(plans.payoff.points[month].netWorth).toBeCloseTo(plans.invest.points[month].netWorth, 5);
      expect(plans.split.points[month].netWorth).toBeCloseTo(plans.invest.points[month].netWorth, 5);
    }
  });

  it('reverses the preferred outcome above/below break-even, including losses', () => {
    const input = { ...base, debtRate: 6, lumpSum: 500 };
    for (const annualReturn of [-50, 0, 4]) {
      const { plans } = compareDebtInvestment({ ...input, annualReturn });
      expect(plans.payoff.final.netWorth).toBeGreaterThan(plans.invest.final.netWorth);
      expect(plans.payoff.final.investments).toBeGreaterThanOrEqual(0);
    }
    const { plans } = compareDebtInvestment({ ...input, annualReturn: 10 });
    expect(plans.invest.final.netWorth).toBeGreaterThan(plans.payoff.final.netWorth);
  });

  it('matches pure strategies at the split endpoints', () => {
    for (const splitPercent of [0, 100]) {
      const { plans } = compareDebtInvestment({ ...base, debtRate: 5, annualReturn: 8, lumpSum: 400, splitPercent });
      expect(plans.split.points).toEqual(plans[splitPercent === 0 ? 'invest' : 'payoff'].points);
    }
  });

  it('reports no break-even when there is no allocation decision', () => {
    for (const input of [{ ...base, balance: 0 }, { ...base, lumpSum: 0, extraMonthly: 0 }, { ...base, balance: 50 }]) {
      const { plans, breakEvenReturn } = compareDebtInvestment(input);
      expect(breakEvenReturn).toBeNull();
      expect(plans.payoff.points).toEqual(plans.invest.points);
    }
  });

  it('retains remaining debt when payoff is beyond the horizon', () => {
    const { plans } = compareDebtInvestment({ ...base, balance: 100000, debtRate: 6, monthlyPayment: 600 });
    expect(plans.invest.payoffMonth).toBeNull();
    expect(plans.invest.final.debt).toBeGreaterThan(98000);
    expect(plans.invest.final.netWorth).toBe(plans.invest.final.investments - plans.invest.final.debt);
  });

  it.each([
    { balance: -1 }, { debtRate: Infinity }, { annualReturn: -100 }, { years: 0 },
    { years: 1.5 }, { years: 51 }, { splitPercent: 101 }, { lumpSum: NaN },
    { extraMonthly: -10 }, { balance: 1000, debtRate: 12, monthlyPayment: 10 },
    { monthlyPayment: 0 },
  ])('rejects invalid or non-amortizing inputs: %j', patch => {
    expect(validateDebtInvestmentInputs({ ...base, ...patch })).not.toBeNull();
    expect(() => compareDebtInvestment({ ...base, ...patch })).toThrow();
  });
});
