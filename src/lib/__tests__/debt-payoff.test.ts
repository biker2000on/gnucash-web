import { describe, it, expect } from 'vitest';
import {
  simulatePlan,
  compareStrategies,
  MAX_MONTHS,
  type DebtInput,
} from '@/lib/debt-payoff';

function debt(overrides: Partial<DebtInput> & { guid: string }): DebtInput {
  return {
    name: overrides.guid,
    balance: 1000,
    apr: 0,
    minPayment: 100,
    ...overrides,
  };
}

describe('debt-payoff engine', () => {
  describe('single debt amortization (hand-computed)', () => {
    // $1,000 at 12% APR (1%/month), $100/month minimum:
    // m1: interest 10.00 -> 1010.00, pay 100 -> 910.00
    // m2: interest  9.10 ->  919.10, pay 100 -> 819.10
    // m3: interest  8.191 -> 827.291, pay 100 -> 727.291
    // ...
    // m11: interest 0.5840 -> 58.9849, final payment 58.98 -> 0
    // Total interest = 58.98 (hand-summed), total paid = 1058.98
    const debts = [debt({ guid: 'a'.repeat(32), balance: 1000, apr: 12, minPayment: 100 })];

    it('amortizes to known values', () => {
      const plan = simulatePlan(debts, 0, 'avalanche');
      expect(plan.months).toBe(11);
      expect(plan.capped).toBe(false);
      expect(plan.totalInterest).toBeCloseTo(58.98, 2);
      expect(plan.totalPaid).toBeCloseTo(1058.98, 2);
      expect(plan.debts[0].payoffMonth).toBe(11);
      expect(plan.debts[0].interestPaid).toBeCloseTo(58.98, 2);
      expect(plan.debts[0].remainingBalance).toBe(0);
    });

    it('tracks the monthly balance timeline', () => {
      const plan = simulatePlan(debts, 0, 'avalanche');
      expect(plan.timeline[0]).toEqual({ month: 0, totalBalance: 1000 });
      expect(plan.timeline[1].totalBalance).toBeCloseTo(910.0, 2);
      expect(plan.timeline[2].totalBalance).toBeCloseTo(819.1, 2);
      expect(plan.timeline[3].totalBalance).toBeCloseTo(727.29, 2);
      expect(plan.timeline[11].totalBalance).toBe(0);
      expect(plan.timeline).toHaveLength(12); // month 0 + 11 months
    });

    it('minimum strategy matches for a single debt with no extra', () => {
      const min = simulatePlan(debts, 0, 'minimum');
      expect(min.months).toBe(11);
      expect(min.totalInterest).toBeCloseTo(58.98, 2);
    });
  });

  describe('zero APR', () => {
    it('pays off with no interest in exactly balance/payment months', () => {
      const plan = simulatePlan(
        [debt({ guid: 'z'.repeat(32), balance: 1200, apr: 0, minPayment: 100 })],
        0,
        'snowball'
      );
      expect(plan.months).toBe(12);
      expect(plan.totalInterest).toBe(0);
      expect(plan.totalPaid).toBeCloseTo(1200, 2);
      expect(plan.warnings).toHaveLength(0);
    });
  });

  describe('rollover of freed minimums', () => {
    // A: $500 @ 0%, min $50 -> paid off month 10
    // B: $2000 @ 0%, min $50
    // Snowball budget = $100/mo. After A is done (month 10), B receives
    // $100/mo: B has 2000 - 10*50 = 1500 left -> 15 more months -> month 25.
    // Minimum-only baseline: B takes 2000/50 = 40 months, no rollover.
    const debts = [
      debt({ guid: 'a'.repeat(32), name: 'A', balance: 500, apr: 0, minPayment: 50 }),
      debt({ guid: 'b'.repeat(32), name: 'B', balance: 2000, apr: 0, minPayment: 50 }),
    ];

    it('rolls freed minimums into the target debt', () => {
      const plan = simulatePlan(debts, 0, 'snowball');
      const a = plan.debts.find((d) => d.name === 'A')!;
      const b = plan.debts.find((d) => d.name === 'B')!;
      expect(a.payoffMonth).toBe(10);
      expect(b.payoffMonth).toBe(25);
      expect(plan.months).toBe(25);
      expect(plan.payoffOrder).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    });

    it('minimum baseline has no rollover', () => {
      const plan = simulatePlan(debts, 0, 'minimum');
      const b = plan.debts.find((d) => d.name === 'B')!;
      expect(b.payoffMonth).toBe(40);
      expect(plan.months).toBe(40);
    });
  });

  describe('snowball vs avalanche ordering', () => {
    // Small: $1,000 @ 1% APR, min $20. Big: $1,200 @ 30% APR, min $30.
    // With $500/mo extra, snowball targets Small (smaller balance) while
    // avalanche targets Big (higher APR) — first payoff differs.
    const small = debt({ guid: 's'.repeat(32), name: 'Small', balance: 1000, apr: 1, minPayment: 20 });
    const big = debt({ guid: 'b'.repeat(32), name: 'Big', balance: 1200, apr: 30, minPayment: 30 });

    it('snowball pays smallest balance first', () => {
      const plan = simulatePlan([small, big], 500, 'snowball');
      expect(plan.payoffOrder[0]).toBe(small.guid);
    });

    it('avalanche pays highest APR first', () => {
      const plan = simulatePlan([small, big], 500, 'avalanche');
      expect(plan.payoffOrder[0]).toBe(big.guid);
    });

    it('avalanche never pays more interest than snowball', () => {
      const result = compareStrategies([small, big], 500);
      expect(result.avalanche.totalInterest).toBeLessThanOrEqual(
        result.snowball.totalInterest
      );
      expect(result.comparison.avalancheVsSnowball.interestSaved).not.toBeNull();
      expect(result.comparison.avalancheVsSnowball.interestSaved!).toBeGreaterThanOrEqual(0);
    });
  });

  describe('payment too low', () => {
    // $10,000 @ 24% APR = $200/month interest, min payment $50: balance grows.
    const underwater = debt({
      guid: 'u'.repeat(32),
      name: 'Underwater',
      balance: 10000,
      apr: 24,
      minPayment: 50,
    });

    it('flags the debt and caps the minimum-only simulation at 100 years', () => {
      const plan = simulatePlan([underwater], 0, 'minimum');
      expect(plan.debts[0].minPaymentBelowInterest).toBe(true);
      expect(plan.capped).toBe(true);
      expect(plan.months).toBeNull();
      expect(plan.debts[0].payoffMonth).toBeNull();
      expect(plan.debts[0].remainingBalance).toBeGreaterThan(10000); // balance grew
      expect(plan.timeline.length).toBe(MAX_MONTHS + 1);
      expect(plan.warnings.some((w) => w.includes('does not cover monthly interest'))).toBe(true);
      expect(plan.warnings.some((w) => w.includes('Payment too low'))).toBe(true);
    });

    it('still pays off when extra payments push the budget above interest', () => {
      const plan = simulatePlan([underwater], 300, 'avalanche');
      expect(plan.capped).toBe(false);
      expect(plan.months).not.toBeNull();
      expect(plan.debts[0].minPaymentBelowInterest).toBe(true); // warning persists
    });

    it('returns null comparison deltas when a plan never completes', () => {
      const result = compareStrategies([underwater], 300);
      expect(result.minimum.capped).toBe(true);
      expect(result.comparison.avalancheVsMinimum.interestSaved).toBeNull();
      expect(result.comparison.avalancheVsMinimum.monthsSaved).toBeNull();
      // snowball vs avalanche both complete, so that delta exists
      expect(result.comparison.avalancheVsSnowball.interestSaved).not.toBeNull();
    });
  });

  describe('extra payments shorten the schedule', () => {
    const debts = [debt({ guid: 'e'.repeat(32), balance: 5000, apr: 18, minPayment: 150 })];

    it('reduces months and interest', () => {
      const without = simulatePlan(debts, 0, 'avalanche');
      const withExtra = simulatePlan(debts, 100, 'avalanche');
      expect(withExtra.months!).toBeLessThan(without.months!);
      expect(withExtra.totalInterest).toBeLessThan(without.totalInterest);
    });
  });

  describe('baseline comparison sanity', () => {
    const debts = [
      debt({ guid: 'a'.repeat(32), name: 'Card', balance: 3000, apr: 22, minPayment: 90 }),
      debt({ guid: 'b'.repeat(32), name: 'Loan', balance: 8000, apr: 7, minPayment: 160 }),
      debt({ guid: 'c'.repeat(32), name: 'Store', balance: 600, apr: 27, minPayment: 25 }),
    ];

    it('both strategies beat minimum-only on months and interest', () => {
      const result = compareStrategies(debts, 200);
      expect(result.snowball.months!).toBeLessThan(result.minimum.months!);
      expect(result.avalanche.months!).toBeLessThan(result.minimum.months!);
      expect(result.snowball.totalInterest).toBeLessThan(result.minimum.totalInterest);
      expect(result.avalanche.totalInterest).toBeLessThan(result.minimum.totalInterest);
      expect(result.comparison.snowballVsMinimum.interestSaved!).toBeGreaterThan(0);
      expect(result.comparison.snowballVsMinimum.monthsSaved!).toBeGreaterThan(0);
      expect(result.comparison.avalancheVsMinimum.interestSaved!).toBeGreaterThan(0);
      expect(result.comparison.avalancheVsMinimum.monthsSaved!).toBeGreaterThan(0);
    });

    it('total paid equals principal plus interest for completed plans', () => {
      const result = compareStrategies(debts, 200);
      const principal = debts.reduce((s, d) => s + d.balance, 0);
      expect(result.snowball.totalPaid).toBeCloseTo(
        principal + result.snowball.totalInterest,
        1
      );
      expect(result.avalanche.totalPaid).toBeCloseTo(
        principal + result.avalanche.totalInterest,
        1
      );
    });
  });

  describe('edge cases', () => {
    it('handles debts already at zero balance', () => {
      const plan = simulatePlan(
        [
          debt({ guid: 'a'.repeat(32), name: 'Paid', balance: 0, apr: 20, minPayment: 50 }),
          debt({ guid: 'b'.repeat(32), name: 'Open', balance: 500, apr: 0, minPayment: 100 }),
        ],
        0,
        'snowball'
      );
      const paid = plan.debts.find((d) => d.name === 'Paid')!;
      expect(paid.payoffMonth).toBe(0);
      expect(paid.interestPaid).toBe(0);
      // Zero-balance debt contributes nothing to the budget
      expect(plan.months).toBe(5); // 500 / 100
    });

    it('handles an empty debt list', () => {
      const plan = simulatePlan([], 100, 'avalanche');
      expect(plan.months).toBe(0);
      expect(plan.totalInterest).toBe(0);
      expect(plan.timeline).toEqual([{ month: 0, totalBalance: 0 }]);
    });

    it('applies a final payment smaller than the minimum and rolls the rest', () => {
      // A: $30 @ 0%, min $100 -> A takes $30 in month 1, remaining $70 + no
      // other minimums... B: $500 @ 0%, min $50. Budget = 150.
      // Month 1: A pays 30 (done), B pays 50, leftover 70 -> B: 500-120=380
      const plan = simulatePlan(
        [
          debt({ guid: 'a'.repeat(32), name: 'Tiny', balance: 30, apr: 0, minPayment: 100 }),
          debt({ guid: 'b'.repeat(32), name: 'B', balance: 500, apr: 0, minPayment: 50 }),
        ],
        0,
        'snowball'
      );
      expect(plan.debts.find((d) => d.name === 'Tiny')!.payoffMonth).toBe(1);
      expect(plan.timeline[1].totalBalance).toBeCloseTo(380, 2);
      // B then gets the full $150 budget: 380 -> 230 -> 80 -> 0 (month 4)
      expect(plan.months).toBe(4);
    });
  });
});
