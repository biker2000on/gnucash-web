import { describe, expect, it } from 'vitest';
import { comparePlanner, defaultPlanner, newPlannerDebt, PlannerSchema, projectPlanner, simulatePlanner } from '../debt-investment-planner';
import { compareDebtInvestment, STRATEGIES } from '../debt-vs-invest';

const base = () => ({ ...defaultPlanner(), debts: [{ ...newPlannerDebt(), balance: 1200, rate: 0, payment: 100 }], lumpSum: 0, extraMonthly: 100, annualReturn: 0, years: 1 });
describe('debt investment planner', () => {
  it('conserves equal budgets and reinvests released payments', () => {
    const result = comparePlanner(base());
    for (const k of STRATEGIES) expect(result.plans[k].final.netWorth).toBeCloseTo(1200);
    expect(result.plans.payoff.payoffMonth).toBe(6);
    expect(result.plans.split.payoffMonth).toBe(8);
    expect(result.plans.invest.payoffMonth).toBe(12);
  });
  it('matches the original fixed-rate calculator at every month', () => {
    const input = { balance: 250000, debtRate: 5, monthlyPayment: 1500, lumpSum: 25000, extraMonthly: 500, annualReturn: 7, years: 20, splitPercent: 50 };
    const old = compareDebtInvestment(input);
    for (const k of STRATEGIES) {
      const plan = projectPlanner(defaultPlanner(), k);
      plan.points.forEach((point, index) => expect(point.netWorth).toBeCloseTo(old.plans[k].points[index].netWorth, 6));
    }
  });
  it('protects reserves without counting them twice', () => {
    const p = projectPlanner({ ...base(), lumpSum: 2000, reserve: 1000 }, 'payoff');
    expect(p.points[0]).toMatchObject({ debt: 200, investments: 0, netWorth: 800 });
    expect(p.final.netWorth).toBeCloseTo(3200);
  });
  it('uses incremental itemization rather than deducting all interest', () => {
    const s = { ...base(), debts: [{ ...base().debts[0], balance: 10000, rate: 12, payment: 500, eligibleInterestPercent: 50 }], marginalTax: 25 };
    const all = projectPlanner(s, 'invest');
    expect(all.final.taxBenefit).toBeCloseTo(all.final.interest * 0.5 * 0.25);
    const threshold = projectPlanner({ ...s, standardDeduction: 1000, otherItemized: 900 }, 'invest');
    expect(threshold.final.taxBenefit).toBeCloseTo((threshold.final.interest * 0.5 - 100) * 0.25);
    expect(projectPlanner({ ...s, standardDeduction: 20000 }, 'invest').final.taxBenefit).toBe(0);
  });
  it('liquidates only the spent share and grosses up protected cash taxes', () => {
    const p = projectPlanner({ ...base(), lumpSum: 2000, reserve: 900, lumpAlreadyInvested: true, lumpGainPercent: 50, capitalGainsTax: 20 }, 'payoff');
    expect(p.points[0]).toMatchObject({ debt: 300, investments: 0, taxes: 200, netWorth: 600 });
    expect(() => projectPlanner({ ...base(), lumpSum: 1000, reserve: 1000, lumpAlreadyInvested: true, lumpGainPercent: 50, capitalGainsTax: 20 }, 'payoff')).toThrow(/reserve/);
  });
  it('charges unrealized gain tax but no loss credit', () => {
    const s = { ...base(), debts: [{ ...base().debts[0], balance: 0, payment: 0 }], extraMonthly: 0, existingInvestments: 1000, annualReturn: 10, capitalGainsTax: 20 };
    expect(projectPlanner(s, 'invest').final.afterTaxInvestments).toBeCloseTo(1080);
    expect(projectPlanner({ ...s, annualReturn: -10 }, 'invest').final.afterTaxInvestments).toBeCloseTo(900);
  });
  it('taxes dividends and adds reinvestment to basis without adding returns twice', () => {
    const p = projectPlanner({ ...base(), debts: [{ ...base().debts[0], balance: 0, payment: 0 }], extraMonthly: 0, existingInvestments: 1200, annualReturn: 0, dividendYield: 12, dividendTax: 20, capitalGainsTax: 20 }, 'invest');
    expect(p.points[1].investments).toBeCloseTo(1197.6);
    expect(p.points[1].taxes).toBeCloseTo(2.4);
    expect(p.points[1].afterTaxInvestments).toBeCloseTo(1197.6);
  });
  it('distinguishes deferred, after-tax basis and qualified tax-free assets', () => {
    const s = { ...base(), existingInvestments: 1000, accountType: 'deferred', existingBasisPercent: 0, withdrawalTax: 20, earlyPenalty: 10, currentAge: 59, accessAge: 59.5 };
    const p = projectPlanner(s, 'invest');
    expect(p.points[0].afterTaxInvestments).toBeCloseTo(700);
    expect(p.points[6].afterTaxInvestments).toBeCloseTo(p.points[6].investments - 200);
    expect(projectPlanner({ ...s, accountType: 'taxFree' }, 'invest').points[0].afterTaxInvestments).toBe(1000);
    const gross = projectPlanner({ ...s, deductibleContributions: true, marginalTax: 20 }, 'invest');
    expect(gross.points[1].investments).toBeCloseTo(1125);
    expect(gross.points[1].afterTaxInvestments).toBeCloseTo(787.5);
  });
  it('uses lender insurance cancellation, penalties, and annual extra caps', () => {
    const s = { ...base(), lumpSum: 600, debts: [{ ...base().debts[0], insurance: 50, cancelInsuranceBalance: 600, penaltyPercent: 10, penaltyThroughMonth: 0, annualExtraLimit: 500 }] };
    const p = projectPlanner(s, 'payoff');
    expect(p.points[0]).toMatchObject({ debt: 700, investments: 50, fees: 50 });
    expect(p.points[1].insurance).toBe(50);
    expect(p.points[2].insurance).toBe(50);
    expect(p.points[1].debt).toBe(600);
    const twoYears = projectPlanner({ ...base(), years: 2, lumpSum: 500, debts: [{ ...base().debts[0], balance: 10000, annualExtraLimit: 500 }] }, 'payoff');
    expect(twoYears.points[13].debt).toBe(8100);
  });
  it('honors explicit insurance cancellation month', () => {
    const p = projectPlanner({ ...base(), debts: [{ ...base().debts[0], insurance: 50, cancelInsuranceMonth: 2 }] }, 'invest');
    expect(p.final.insurance).toBe(50);
  });
  it('orders multiple debts by rate, balance, or listed preference', () => {
    const s = { ...base(), lumpSum: 400, debts: [{ ...newPlannerDebt('low'), balance: 500, rate: 0, payment: 10 }, { ...newPlannerDebt('high'), balance: 1000, rate: 12, payment: 20 }] };
    expect(projectPlanner(s, 'payoff').debts.find(d => d.id === 'high')!.interest).toBeLessThan(projectPlanner({ ...s, priority: 'snowball' }, 'payoff').debts.find(d => d.id === 'high')!.interest);
    expect(projectPlanner({ ...s, priority: 'listed' }, 'payoff').points).toEqual(projectPlanner({ ...s, priority: 'snowball' }, 'payoff').points);
  });
  it('applies rate changes and flags cash shortfalls', () => {
    const p = projectPlanner({ ...base(), debts: [{ ...base().debts[0], rateChanges: [{ month: 1, rate: 12, payment: 300 }] }] }, 'invest');
    expect(p.points[1].interest).toBeCloseTo(12);
    expect(p.points[1].shortfall).toBeCloseTo(100);
  });
  it('recasts the remaining principal and pays the fee from the monthly budget', () => {
    const p = projectPlanner({ ...base(), lumpSum: 600, debts: [{ ...base().debts[0], recast: { month: 1, remainingMonths: 12, fee: 20 } }] }, 'payoff');
    expect(p.points[1]).toMatchObject({ debt: 420, fees: 20, requiredPayment: 50 });
  });
  it('refinances principal including financed costs and penalties', () => {
    const p = projectPlanner({ ...base(), debts: [{ ...base().debts[0], penaltyPercent: 10, penaltyThroughMonth: 3, refinance: { month: 1, rate: 0, termMonths: 12, cost: 120, financeCost: true } }] }, 'invest');
    expect(p.points[1]).toMatchObject({ debt: 1320, fees: 240, requiredPayment: 120, investments: 80 });
    const cash = projectPlanner({ ...base(), debts: [{ ...base().debts[0], refinance: { month: 1, rate: 0, termMonths: 12, cost: 500, financeCost: false } }] }, 'invest');
    expect(cash.points[1].shortfall).toBe(400);
  });
  it('reduces assets with fees and reports a debt-aware independence threshold', () => {
    const s = { ...base(), existingInvestments: 100000, annualSpending: 4000, inflation: 0 };
    expect(projectPlanner(s, 'payoff').financialIndependenceMonth).toBe(6);
    expect(projectPlanner(s, 'invest').financialIndependenceMonth).toBe(12);
    expect(projectPlanner({ ...s, feePercent: 2 }, 'invest').final.investments).toBeLessThan(projectPlanner(s, 'invest').final.investments);
  });
  it('finds the effective annual break-even rate', () => {
    const result = comparePlanner(defaultPlanner());
    expect(result.breakEvenRates[0]).toBeCloseTo(((1 + 0.05 / 12) ** 12 - 1) * 100, 5);
  });
  it('uses repeatable paired historical paths and ordered percentile bands', () => {
    const s = { ...base(), simulations: 50, splitPercent: 0, lumpSum: 500 };
    const result = simulatePlanner(s);
    expect(result).toEqual(simulatePlanner(s));
    expect(result.summaries.find(p => p.strategy === 'split')).toMatchObject({ aheadPercent: 0, tiePercent: 100 });
    for (const row of result.bands) for (const k of STRATEGIES) { expect(row[`${k}Low`]).toBeLessThanOrEqual(row[k]); expect(row[k]).toBeLessThanOrEqual(row[`${k}High`]); }
    expect(simulatePlanner({ ...s, seed: 43 }).summaries).not.toEqual(result.summaries);
  });
  it('reports simulations with unfunded obligations', () => {
    expect(simulatePlanner({ ...base(), simulations: 50, debts: [{ ...base().debts[0], rateChanges: [{ month: 1, rate: 12, payment: 300 }] }] }).invalidRuns).toBe(50);
  });
  it('rejects invalid ranges, duplicate debts and ambiguous lender events', () => {
    for (const patch of [{ annualReturn: NaN }, { years: 1.5 }, { simulations: 1001 }, { reserve: 1 }, { debts: [newPlannerDebt(), newPlannerDebt()] }, { debts: [{ ...base().debts[0], payment: 0 }] }, { debts: [{ ...base().debts[0], recast: { month: 1, fee: 0, remainingMonths: 12 }, refinance: { month: 1, rate: 0, termMonths: 12, cost: 0, financeCost: false } }] }]) expect(PlannerSchema.safeParse({ ...base(), ...patch }).success).toBe(false);
  });
});
