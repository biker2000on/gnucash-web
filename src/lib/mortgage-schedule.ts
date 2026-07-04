/**
 * Mortgage amortization schedule builders.
 *
 * Pure functions shared by the mortgage tool page. Extracted from the page
 * component so they can be unit tested.
 */

import type { AmortizationRow } from '@/components/mortgage/AmortizationTable';
import type { ActualPayment } from '@/components/mortgage/MortgageAutoDetect';

export function calcMonthlyPayment(principal: number, monthlyRate: number, totalMonths: number): number {
  if (principal <= 0 || totalMonths <= 0) return 0;
  if (monthlyRate === 0) return principal / totalMonths;
  return principal * (monthlyRate * Math.pow(1 + monthlyRate, totalMonths)) / (Math.pow(1 + monthlyRate, totalMonths) - 1);
}

export function buildAmortizationSchedule(
  principal: number,
  monthlyRate: number,
  totalMonths: number,
  extraPayment: number,
): AmortizationRow[] {
  const basePayment = calcMonthlyPayment(principal, monthlyRate, totalMonths);
  if (basePayment <= 0 || principal <= 0) return [];

  const rows: AmortizationRow[] = [];
  let balance = principal;

  for (let month = 1; balance > 0; month++) {
    const interest = balance * monthlyRate;
    let principalPortion = basePayment - interest + extraPayment;

    // Final month adjustment
    if (principalPortion > balance) {
      principalPortion = balance;
    }

    const actualExtra = Math.min(extraPayment, Math.max(0, balance - (basePayment - interest)));
    const actualPrincipal = principalPortion - actualExtra;

    balance = Math.max(0, balance - principalPortion);

    rows.push({
      month,
      payment: actualPrincipal + interest + actualExtra,
      principal: actualPrincipal,
      interest,
      extra: actualExtra,
      balance,
    });

    // Safety: prevent runaway loops
    if (month > 1200) break;
  }

  return rows;
}

export function totalInterestFromSchedule(schedule: AmortizationRow[]): number {
  return schedule.reduce((sum, r) => sum + r.interest, 0);
}

/* ------------------------------------------------------------------ */
/* Payoff strategies                                                   */
/* ------------------------------------------------------------------ */

export type PayoffStrategyType =
  | 'none'
  | 'fixed_monthly'
  | 'extra_annual'
  | 'biweekly'
  | 'roundup'
  | 'lump_sum';

export interface PayoffStrategy {
  type: PayoffStrategyType;
  /** fixed_monthly: flat extra principal applied every month */
  fixedMonthly?: number;
  /** extra_annual: number of extra full monthly payments made each year (1 = "13 payments/year", 4 = quarterly) */
  extraPaymentsPerYear?: number;
  /** roundup: round the monthly payment up to the next multiple of this (e.g. 100) */
  roundUpTo?: number;
  /** lump_sum: one-time extra principal amount */
  lumpSum?: number;
  /** lump_sum: 1-based month index at which the lump sum is applied */
  lumpSumMonth?: number;
}

export interface StrategyLabelInfo {
  label: string;
  /** Short human description of how the extra principal is applied */
  description: string;
}

export function describeStrategy(strategy: PayoffStrategy, basePayment: number): StrategyLabelInfo {
  switch (strategy.type) {
    case 'fixed_monthly':
      return {
        label: 'Fixed extra per month',
        description: `An extra $${(strategy.fixedMonthly ?? 0).toLocaleString()} of principal every month.`,
      };
    case 'extra_annual': {
      const n = Math.max(1, Math.round(strategy.extraPaymentsPerYear ?? 1));
      return {
        label: n === 1 ? '1 extra payment / year (13 payments)' : `${n} extra payments / year`,
        description: `${n} additional full monthly payment${n === 1 ? '' : 's'} (~$${basePayment.toFixed(0)} each) spread across the year.`,
      };
    }
    case 'biweekly':
      return {
        label: 'Accelerated bi-weekly',
        description: 'Half the monthly payment every two weeks — 26 half-payments a year equal 13 full payments, paying down principal faster.',
      };
    case 'roundup':
      return {
        label: 'Round up payment',
        description: `Round each payment up to the next $${(strategy.roundUpTo ?? 100).toLocaleString()}; the difference goes to principal.`,
      };
    case 'lump_sum':
      return {
        label: 'One-time lump sum',
        description: `A single $${(strategy.lumpSum ?? 0).toLocaleString()} extra principal payment at month ${strategy.lumpSumMonth ?? 1}.`,
      };
    default:
      return { label: 'No extra payments', description: 'Regular scheduled monthly payments only.' };
  }
}

/**
 * Build a monthly amortization schedule where the extra principal in each
 * month is determined by a function. Generalizes the flat-extra builder to
 * support round-up, annual lump payments, one-time lump sums, etc.
 */
export function buildScheduleWithExtraFn(
  principal: number,
  monthlyRate: number,
  totalMonths: number,
  basePayment: number,
  extraForMonth: (month: number, balance: number) => number,
): AmortizationRow[] {
  if (basePayment <= 0 || principal <= 0) return [];

  const rows: AmortizationRow[] = [];
  let balance = principal;

  for (let month = 1; balance > 0; month++) {
    const interest = balance * monthlyRate;
    const scheduledPrincipal = Math.max(0, basePayment - interest);
    const requestedExtra = Math.max(0, extraForMonth(month, balance));

    // Scheduled principal is capped at the remaining balance; extra principal
    // then draws down whatever balance is left.
    const actualPrincipal = Math.min(scheduledPrincipal, balance);
    const actualExtra = Math.min(requestedExtra, balance - actualPrincipal);

    balance = Math.max(0, balance - actualPrincipal - actualExtra);

    rows.push({
      month,
      payment: actualPrincipal + interest + actualExtra,
      principal: actualPrincipal,
      interest,
      extra: actualExtra,
      balance,
    });

    if (month > 1200) break;
  }

  return rows;
}

/**
 * True accelerated bi-weekly schedule: half the monthly payment every 14 days,
 * with interest accruing per 14-day period. Rows are aggregated into calendar
 * months (balance = end of month) so the table and charts stay monthly and
 * comparable with the other strategies.
 */
export function buildBiweeklySchedule(
  principal: number,
  annualRate: number,
  totalMonths: number,
  startDate?: Date,
): AmortizationRow[] {
  const monthlyRate = annualRate / 100 / 12;
  const basePayment = calcMonthlyPayment(principal, monthlyRate, totalMonths);
  if (basePayment <= 0 || principal <= 0) return [];

  const biweeklyPayment = basePayment / 2;
  const periodRate = annualRate / 100 / 26; // 26 bi-weekly periods per year
  const start = startDate ? new Date(startDate) : new Date();

  const rows: AmortizationRow[] = [];
  let balance = principal;
  let period = 0;
  // Accumulators for the current calendar month
  let curKey = '';
  let curMonthIndex = 0;
  let accPrincipal = 0;
  let accInterest = 0;
  let accExtra = 0;

  const baselineMonthlyPrincipalAt = (bal: number) => Math.max(0, basePayment - bal * monthlyRate);

  const flush = (endBalance: number) => {
    if (curKey === '') return;
    rows.push({
      month: curMonthIndex,
      payment: accPrincipal + accInterest + accExtra,
      principal: accPrincipal,
      interest: accInterest,
      extra: accExtra,
      balance: endBalance,
    });
    accPrincipal = 0;
    accInterest = 0;
    accExtra = 0;
  };

  while (balance > 0 && period < 26 * 100) {
    const d = new Date(start);
    d.setDate(d.getDate() + period * 14);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key !== curKey) {
      if (curKey !== '') flush(balance);
      curKey = key;
      curMonthIndex++;
    }

    const interest = balance * periodRate;
    let principalPortion = Math.min(biweeklyPayment - interest, balance);
    if (principalPortion < 0) principalPortion = 0;
    // Split into "scheduled" vs "extra" against a monthly-baseline for display:
    // roughly half of the equivalent monthly scheduled principal per period.
    const schedHalf = baselineMonthlyPrincipalAt(balance) / 2;
    const extraPortion = Math.max(0, principalPortion - schedHalf);

    balance = Math.max(0, balance - principalPortion);
    accPrincipal += principalPortion - extraPortion;
    accInterest += interest;
    accExtra += extraPortion;
    period++;
  }
  flush(balance);

  return rows;
}

/**
 * Dispatch: build the schedule for a given payoff strategy. All strategies
 * except bi-weekly run on the standard monthly loop; bi-weekly uses a true
 * 14-day cadence aggregated to months.
 */
export function buildScheduleForStrategy(
  principal: number,
  monthlyRate: number,
  totalMonths: number,
  strategy: PayoffStrategy,
  startDate?: Date,
): AmortizationRow[] {
  const basePayment = calcMonthlyPayment(principal, monthlyRate, totalMonths);
  if (basePayment <= 0) return [];

  switch (strategy.type) {
    case 'biweekly':
      return buildBiweeklySchedule(principal, monthlyRate * 12 * 100, totalMonths, startDate);

    case 'fixed_monthly': {
      const extra = Math.max(0, strategy.fixedMonthly ?? 0);
      return buildScheduleWithExtraFn(principal, monthlyRate, totalMonths, basePayment, () => extra);
    }

    case 'extra_annual': {
      const n = Math.max(1, Math.round(strategy.extraPaymentsPerYear ?? 1));
      const interval = Math.max(1, Math.round(12 / n));
      // One extra full payment every `interval` months (e.g. n=4 → months 3,6,9,12)
      return buildScheduleWithExtraFn(principal, monthlyRate, totalMonths, basePayment,
        (month) => (month % interval === 0 ? basePayment : 0));
    }

    case 'roundup': {
      const step = Math.max(1, strategy.roundUpTo ?? 100);
      const roundedPayment = Math.ceil(basePayment / step) * step;
      const extra = Math.max(0, roundedPayment - basePayment);
      return buildScheduleWithExtraFn(principal, monthlyRate, totalMonths, basePayment, () => extra);
    }

    case 'lump_sum': {
      const amount = Math.max(0, strategy.lumpSum ?? 0);
      const at = Math.max(1, Math.round(strategy.lumpSumMonth ?? 1));
      return buildScheduleWithExtraFn(principal, monthlyRate, totalMonths, basePayment,
        (month) => (month === at ? amount : 0));
    }

    default:
      return buildAmortizationSchedule(principal, monthlyRate, totalMonths, 0);
  }
}

/**
 * Build a hybrid amortization schedule:
 * - Actual payments from GnuCash history (marked actual=true, with dates).
 *   Each actual payment is split into scheduled principal vs extra principal
 *   by tracking the as-scheduled (no-extra) amortization in parallel.
 * - Projected future payments from the current balance forward (actual=false).
 */
export function buildHybridSchedule(
  actualPayments: ActualPayment[],
  originalAmount: number,
  monthlyRate: number,
  totalMonths: number,
  extraPayment: number,
  currentBalance: number | null,
): AmortizationRow[] {
  const rows: AmortizationRow[] = [];

  // Phase 1: Actual payments from history.
  const baselinePayment = calcMonthlyPayment(originalAmount, monthlyRate, totalMonths);
  let balance = originalAmount;
  let schedBalance = originalAmount;
  let lastMonthKey = '';
  let monthsElapsed = 0;

  for (let i = 0; i < actualPayments.length; i++) {
    const p = actualPayments[i];
    const date = new Date(p.date);
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;

    // Advance the scheduled baseline once per calendar month; additional
    // payments within the same month count entirely as extra principal.
    let schedPrincipal = 0;
    if (monthKey !== lastMonthKey) {
      const schedInterest = schedBalance * monthlyRate;
      schedPrincipal = Math.min(Math.max(baselinePayment - schedInterest, 0), schedBalance);
      schedBalance = Math.max(0, schedBalance - schedPrincipal);
      lastMonthKey = monthKey;
      monthsElapsed++;
    }

    // Extra = actual principal paid beyond the scheduled principal (never negative).
    // p.principal is signed: negative values (escrow disbursements charged to the
    // loan) increase the balance and carry no extra.
    const extraPaid = Math.max(0, p.principal - schedPrincipal);
    balance = Math.max(0, balance - p.principal);

    rows.push({
      month: i + 1,
      date: date.toISOString().slice(0, 10),
      payment: p.total,
      principal: p.principal - extraPaid,
      interest: p.interest,
      extra: extraPaid,
      balance,
      actual: true,
    });
  }

  // Phase 2: Project future payments from current balance
  // Use the actual current balance if available (more accurate than computed)
  const projectionBalance = currentBalance != null ? Math.abs(currentBalance) : balance;
  if (projectionBalance <= 0 || monthlyRate <= 0) return rows;

  const remainingMonths = totalMonths - monthsElapsed;
  if (remainingMonths <= 0) return rows;

  const basePayment = calcMonthlyPayment(projectionBalance, monthlyRate, remainingMonths);
  if (basePayment <= 0) return rows;

  let bal = projectionBalance;
  const lastActualDate = actualPayments.length > 0
    ? new Date(actualPayments[actualPayments.length - 1].date)
    : new Date();

  for (let m = 1; bal > 0; m++) {
    const interest = bal * monthlyRate;
    let principalPortion = basePayment - interest + extraPayment;
    if (principalPortion > bal) principalPortion = bal;

    const actualExtra = Math.min(extraPayment, Math.max(0, bal - (basePayment - interest)));
    const actualPrincipal = principalPortion - actualExtra;
    bal = Math.max(0, bal - principalPortion);

    const projDate = new Date(lastActualDate);
    projDate.setMonth(projDate.getMonth() + m);

    rows.push({
      month: actualPayments.length + m,
      date: projDate.toISOString().slice(0, 10),
      payment: actualPrincipal + interest + actualExtra,
      principal: actualPrincipal,
      interest,
      extra: actualExtra,
      balance: bal,
      actual: false,
    });

    if (m > 1200) break;
  }

  return rows;
}
