/**
 * Debt Payoff Planner Engine
 *
 * Pure amortization engine for comparing debt payoff strategies:
 * - snowball: direct extra payments at the smallest-balance debt first
 * - avalanche: direct extra payments at the highest-APR debt first
 * - minimum: baseline of minimum payments only (no extra, no rollover)
 *
 * Monthly simulation model:
 * 1. Accrue interest on every open debt (APR / 12 on current balance).
 * 2. Pay the minimum on every open debt (capped at its balance).
 * 3. For snowball/avalanche, the remaining monthly budget — the extra payment
 *    plus every freed-up minimum from already-paid-off debts plus any unused
 *    portion of a final payment — cascades to the current target debt, then
 *    the next target if the first is wiped out mid-month (debt rollover).
 *
 * The total monthly budget is constant: sum of all starting minimum payments
 * plus the extra payment. Simulation is capped at 100 years (1200 months) so
 * underwater plans (payments below interest) cannot loop forever.
 *
 * All balances are positive numbers (amount owed). Callers are responsible
 * for normalizing GnuCash liability sign conventions (liabilities are stored
 * as negative/credit balances) before invoking the engine.
 */

export type DebtStrategy = 'snowball' | 'avalanche' | 'minimum';

export interface DebtInput {
  guid: string;
  name: string;
  /** Amount owed, positive */
  balance: number;
  /** Annual percentage rate, e.g. 19.99 for 19.99% */
  apr: number;
  /** Monthly minimum payment */
  minPayment: number;
}

export interface DebtPlanDebt {
  guid: string;
  name: string;
  startingBalance: number;
  /**
   * 1-based month index when the debt reaches zero.
   * 0 = already paid off at start; null = never pays off within the cap.
   */
  payoffMonth: number | null;
  interestPaid: number;
  /** Balance still owed when the simulation ended (only nonzero when capped) */
  remainingBalance: number;
  /** Minimum payment does not cover the first month's interest — balance grows */
  minPaymentBelowInterest: boolean;
}

export interface TimelinePoint {
  month: number;
  totalBalance: number;
}

export interface DebtPlan {
  strategy: DebtStrategy;
  /** Total months to debt-free, or null if not paid off within the cap */
  months: number | null;
  totalInterest: number;
  totalPaid: number;
  /** Per-debt results, in input order */
  debts: DebtPlanDebt[];
  /** GUIDs in the order the debts were paid off */
  payoffOrder: string[];
  /** Total remaining balance by month (month 0 = starting total) */
  timeline: TimelinePoint[];
  warnings: string[];
  /** True when the 100-year simulation cap was hit with balances remaining */
  capped: boolean;
}

export interface StrategyDelta {
  /** Positive = the first strategy saves this much interest; null if either plan never completes */
  interestSaved: number | null;
  /** Positive = the first strategy finishes this many months sooner; null if either plan never completes */
  monthsSaved: number | null;
}

export interface DebtComparison {
  avalancheVsSnowball: StrategyDelta;
  snowballVsMinimum: StrategyDelta;
  avalancheVsMinimum: StrategyDelta;
}

export interface DebtPayoffResult {
  snowball: DebtPlan;
  avalanche: DebtPlan;
  minimum: DebtPlan;
  comparison: DebtComparison;
}

/** Simulation cap: 100 years of monthly payments */
export const MAX_MONTHS = 1200;

/** Balances below half a cent are considered paid off */
const EPS = 0.005;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface DebtState {
  guid: string;
  name: string;
  apr: number;
  minPayment: number;
  balance: number;
  startingBalance: number;
  interestPaid: number;
  payoffMonth: number | null;
  minPaymentBelowInterest: boolean;
}

function targetComparator(strategy: DebtStrategy) {
  if (strategy === 'snowball') {
    // Smallest current balance first; tie-break by higher APR, then name
    return (a: DebtState, b: DebtState) =>
      a.balance - b.balance || b.apr - a.apr || a.name.localeCompare(b.name);
  }
  // Avalanche: highest APR first; tie-break by smaller balance, then name
  return (a: DebtState, b: DebtState) =>
    b.apr - a.apr || a.balance - b.balance || a.name.localeCompare(b.name);
}

/**
 * Simulate a single payoff plan.
 *
 * @param debts        Debts with positive balances (amount owed)
 * @param extraMonthly Extra monthly payment beyond the minimums
 *                     (ignored for the 'minimum' strategy)
 * @param strategy     Payoff strategy
 */
export function simulatePlan(
  debts: DebtInput[],
  extraMonthly: number,
  strategy: DebtStrategy
): DebtPlan {
  const state: DebtState[] = debts.map((d) => {
    const balance = d.balance > EPS ? d.balance : 0;
    return {
      guid: d.guid,
      name: d.name,
      apr: Math.max(0, d.apr),
      minPayment: Math.max(0, d.minPayment),
      balance,
      startingBalance: balance,
      interestPaid: 0,
      payoffMonth: balance > EPS ? null : 0,
      minPaymentBelowInterest: false,
    };
  });

  const warnings: string[] = [];
  const active = state.filter((s) => s.balance > EPS);

  // Flag debts whose minimum payment cannot cover the first month's interest.
  for (const s of active) {
    const monthlyInterest = (s.balance * s.apr) / 100 / 12;
    if (s.apr > 0 && s.minPayment <= monthlyInterest + EPS) {
      s.minPaymentBelowInterest = true;
      warnings.push(
        `${s.name}: minimum payment ($${s.minPayment.toFixed(2)}) does not cover monthly interest ` +
          `($${round2(monthlyInterest).toFixed(2)}) — balance grows under minimum payments alone`
      );
    }
  }

  // Constant monthly budget: all starting minimums + extra. When a debt is
  // paid off, its minimum stays in the budget and rolls to the target debt.
  const extra = strategy === 'minimum' ? 0 : Math.max(0, extraMonthly);
  const budget = active.reduce((sum, s) => sum + s.minPayment, 0) + extra;

  const timeline: TimelinePoint[] = [
    { month: 0, totalBalance: round2(active.reduce((sum, s) => sum + s.balance, 0)) },
  ];
  const payoffOrder: string[] = [];
  const compare = targetComparator(strategy);

  let totalPaid = 0;
  let month = 0;
  let capped = false;

  while (state.some((s) => s.balance > EPS)) {
    if (month >= MAX_MONTHS) {
      capped = true;
      break;
    }
    month++;

    // 1. Accrue interest
    for (const s of state) {
      if (s.balance <= EPS) continue;
      const interest = (s.balance * s.apr) / 100 / 12;
      s.balance += interest;
      s.interestPaid += interest;
    }

    // 2. Apply payments
    if (strategy === 'minimum') {
      for (const s of state) {
        if (s.balance <= EPS) continue;
        const p = Math.min(s.minPayment, s.balance);
        s.balance -= p;
        totalPaid += p;
      }
    } else {
      let remaining = budget;

      // Minimum payments on every open debt
      for (const s of state) {
        if (s.balance <= EPS) continue;
        const p = Math.min(s.minPayment, s.balance, remaining);
        s.balance -= p;
        remaining -= p;
        totalPaid += p;
      }

      // 3. Cascade the leftover budget (extra + freed minimums) to targets
      while (remaining > EPS) {
        const openDebts = state.filter((s) => s.balance > EPS);
        if (openDebts.length === 0) break;
        openDebts.sort(compare);
        const target = openDebts[0];
        const p = Math.min(remaining, target.balance);
        target.balance -= p;
        remaining -= p;
        totalPaid += p;
      }
    }

    // Record payoffs
    for (const s of state) {
      if (s.payoffMonth === null && s.balance <= EPS) {
        s.balance = 0;
        s.payoffMonth = month;
        payoffOrder.push(s.guid);
      }
    }

    timeline.push({
      month,
      totalBalance: round2(state.reduce((sum, s) => sum + s.balance, 0)),
    });
  }

  if (capped) {
    warnings.push(
      'Payment too low — balances are not paid off within 100 years. Increase payments.'
    );
  }

  return {
    strategy,
    months: capped ? null : month,
    totalInterest: round2(state.reduce((sum, s) => sum + s.interestPaid, 0)),
    totalPaid: round2(totalPaid),
    debts: state.map((s) => ({
      guid: s.guid,
      name: s.name,
      startingBalance: round2(s.startingBalance),
      payoffMonth: s.payoffMonth,
      interestPaid: round2(s.interestPaid),
      remainingBalance: round2(s.balance),
      minPaymentBelowInterest: s.minPaymentBelowInterest,
    })),
    payoffOrder,
    timeline,
    warnings,
    capped,
  };
}

function delta(a: DebtPlan, b: DebtPlan): StrategyDelta {
  const complete =
    !a.capped && !b.capped && a.months !== null && b.months !== null;
  return {
    interestSaved: complete ? round2(b.totalInterest - a.totalInterest) : null,
    monthsSaved: complete ? (b.months as number) - (a.months as number) : null,
  };
}

/**
 * Run all three plans (snowball, avalanche, minimum-only baseline) and
 * compute the comparison summary.
 */
export function compareStrategies(
  debts: DebtInput[],
  extraMonthly: number
): DebtPayoffResult {
  const snowball = simulatePlan(debts, extraMonthly, 'snowball');
  const avalanche = simulatePlan(debts, extraMonthly, 'avalanche');
  const minimum = simulatePlan(debts, 0, 'minimum');

  return {
    snowball,
    avalanche,
    minimum,
    comparison: {
      avalancheVsSnowball: delta(avalanche, snowball),
      snowballVsMinimum: delta(snowball, minimum),
      avalancheVsMinimum: delta(avalanche, minimum),
    },
  };
}
