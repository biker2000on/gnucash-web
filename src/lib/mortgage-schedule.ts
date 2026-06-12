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
