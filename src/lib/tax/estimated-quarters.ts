/**
 * Estimated-tax quarter tracking — pure helpers for the tracker API/page.
 *
 * Buckets actual 1040-ES payments into the four IRS installment windows and
 * measures cumulative progress against the safe-harbor annual target:
 *
 *   Q1  due Apr 15   window Jan 16 (year)   – Apr 15 (year)
 *   Q2  due Jun 15   window Apr 16          – Jun 15
 *   Q3  due Sep 15   window Jun 16          – Sep 15
 *   Q4  due Jan 15   window Sep 16          – Jan 15 (year + 1)
 *
 * Windows are PAYMENT-date windows anchored to the due dates: a voucher paid
 * on or before the prior year's (rolled) Q4 due date is the PRIOR year's Q4
 * payment and is excluded from this year's buckets; anything after the Q4
 * due date still counts as (late) Q4. Withholding is treated as paid evenly
 * across the four installments — the IRS default treatment on Form 2210.
 *
 * Due dates falling on a weekend or legal holiday roll forward to the next
 * business day per IRC §7503 (same helper as the compliance calendar), and
 * each window extends through its rolled due date.
 *
 * Required cumulative amounts follow the even 25/50/75/100% schedule unless
 * the caller passes `requiredCumulativeByQuarter` — the Form 2210 Schedule AI
 * annualized-installment amounts computed by
 * src/lib/tax/annualized-installments.ts.
 */

import { adjustDueDate } from '@/lib/compliance';

export interface EstimatedPayment {
  /** ISO YYYY-MM-DD payment (post) date. */
  date: string;
  amount: number;
}

export interface QuarterWindow {
  quarter: 1 | 2 | 3 | 4;
  /** Status-tracking period, e.g. '2026-Q1'. */
  period: string;
  /** Inclusive payment-window bounds (ISO dates). */
  start: string;
  end: string;
  /** IRS installment due date (same as `end`). */
  dueDate: string;
}

export interface QuarterStatus extends QuarterWindow {
  /**
   * Cumulative required by this due date: annualTarget × quarter/4, or the
   * Schedule AI amount when the annualized method is in effect.
   */
  requiredCumulative: number;
  /** Estimated payments landing in this quarter's window. */
  estimatedPaid: number;
  estimatedPaidCumulative: number;
  /** Cumulative withholding credit: annualWithholding × quarter/4. */
  withholdingCreditCumulative: number;
  /** estimatedPaidCumulative + withholdingCreditCumulative */
  totalCreditedCumulative: number;
  /** max(0, requiredCumulative − totalCreditedCumulative) */
  shortfall: number;
  /** max(0, totalCreditedCumulative − requiredCumulative) */
  surplus: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Day after an ISO date (UTC-safe). */
function dayAfter(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The four IRS installment windows for tax year `year`, §7503-rolled. */
export function quarterWindows(year: number): QuarterWindow[] {
  const roll = (iso: string) => adjustDueDate(iso).dueDate;
  // Each window runs from the day after the previous (rolled) due date
  // through this quarter's rolled due date. Q1 opens the day after the
  // PRIOR year's Q4 due date (Jan 15 of `year`, rolled).
  const prevQ4Due = roll(`${year}-01-15`);
  const q1Due = roll(`${year}-04-15`);
  const q2Due = roll(`${year}-06-15`);
  const q3Due = roll(`${year}-09-15`);
  const q4Due = roll(`${year + 1}-01-15`);
  return [
    { quarter: 1, period: `${year}-Q1`, start: dayAfter(prevQ4Due), end: q1Due, dueDate: q1Due },
    { quarter: 2, period: `${year}-Q2`, start: dayAfter(q1Due), end: q2Due, dueDate: q2Due },
    { quarter: 3, period: `${year}-Q3`, start: dayAfter(q2Due), end: q3Due, dueDate: q3Due },
    { quarter: 4, period: `${year}-Q4`, start: dayAfter(q3Due), end: q4Due, dueDate: q4Due },
  ];
}

/**
 * Which quarter (1–4) a payment date belongs to for tax year `year`, or
 * null when the payment predates the Q1 window (i.e. it was the prior
 * year's Q4 voucher). Payments after the Q4 due date count as late Q4.
 */
export function quarterForPaymentDate(date: string, year: number): 1 | 2 | 3 | 4 | null {
  const windows = quarterWindows(year);
  const day = date.slice(0, 10);
  if (day < windows[0].start) return null;
  for (const w of windows) {
    if (day <= w.end) return w.quarter;
  }
  return 4; // paid after Jan 15 of year+1 — late Q4
}

/** Sum payments into the four quarter buckets (index 0 = Q1). */
export function bucketPaymentsByQuarter(
  payments: EstimatedPayment[],
  year: number,
): [number, number, number, number] {
  const buckets: [number, number, number, number] = [0, 0, 0, 0];
  for (const p of payments) {
    const q = quarterForPaymentDate(p.date, year);
    if (q === null) continue;
    buckets[q - 1] += p.amount;
  }
  return buckets.map(round2) as [number, number, number, number];
}

/**
 * Total estimated payments ATTRIBUTED to tax year `year` — the sum of the
 * four quarter buckets.
 *
 * This is the number every "paid so far" display must use. It is NOT the
 * calendar-year category total: a voucher paid Jan 1–15 of `year` belongs to
 * the PRIOR year's Q4 and is excluded, while a voucher paid Jan 1–15 of
 * `year + 1` is this year's Q4 and IS included. Summing the raw calendar
 * year instead makes the headline figure disagree with the quarter table.
 */
export function sumPaymentsForTaxYear(payments: EstimatedPayment[], year: number): number {
  return round2(
    bucketPaymentsByQuarter(payments, year).reduce((sum, amount) => sum + amount, 0),
  );
}

export interface ComputeQuarterStatusesInput {
  year: number;
  /** Safe-harbor required annual payment (withholding + estimates). */
  annualTarget: number;
  /** Expected full-year withholding, credited evenly across quarters. */
  annualWithholding: number;
  payments: EstimatedPayment[];
  /**
   * Optional Form 2210 Schedule AI override: cumulative required amounts per
   * quarter from the annualized-installment method (already the lesser of the
   * regular and annualized schedules per column). When present it replaces
   * the even annualTarget x 25/50/75/100% amounts.
   */
  requiredCumulativeByQuarter?: [number, number, number, number];
}

/**
 * Per-quarter cumulative progress against the annual safe-harbor target
 * using the standard 25/50/75/100% installment schedule, or the Schedule AI
 * amounts when `requiredCumulativeByQuarter` is supplied.
 */
export function computeQuarterStatuses(input: ComputeQuarterStatusesInput): QuarterStatus[] {
  const { year, payments } = input;
  const annualTarget = Math.max(0, input.annualTarget);
  const annualWithholding = Math.max(0, input.annualWithholding);
  const buckets = bucketPaymentsByQuarter(payments, year);

  let paidCumulative = 0;
  return quarterWindows(year).map((w, i) => {
    paidCumulative = round2(paidCumulative + buckets[i]);
    const fraction = (i + 1) / 4;
    const requiredCumulative = input.requiredCumulativeByQuarter
      ? round2(Math.max(0, input.requiredCumulativeByQuarter[i]))
      : round2(annualTarget * fraction);
    const withholdingCreditCumulative = round2(annualWithholding * fraction);
    const totalCreditedCumulative = round2(paidCumulative + withholdingCreditCumulative);
    return {
      ...w,
      requiredCumulative,
      estimatedPaid: buckets[i],
      estimatedPaidCumulative: paidCumulative,
      withholdingCreditCumulative,
      totalCreditedCumulative,
      shortfall: round2(Math.max(0, requiredCumulative - totalCreditedCumulative)),
      surplus: round2(Math.max(0, totalCreditedCumulative - requiredCumulative)),
    };
  });
}
