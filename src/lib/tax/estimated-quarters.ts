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
 * January 1–15 of `year` is the PRIOR year's Q4 payment and is excluded from
 * this year's buckets; anything after the Q4 due date still counts as (late)
 * Q4. Withholding is treated as paid evenly across the four installments —
 * the IRS default treatment on Form 2210.
 */

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
  /** Cumulative required by this due date: annualTarget × quarter/4. */
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

/** The four IRS installment windows for tax year `year`. */
export function quarterWindows(year: number): QuarterWindow[] {
  return [
    { quarter: 1, period: `${year}-Q1`, start: `${year}-01-16`, end: `${year}-04-15`, dueDate: `${year}-04-15` },
    { quarter: 2, period: `${year}-Q2`, start: `${year}-04-16`, end: `${year}-06-15`, dueDate: `${year}-06-15` },
    { quarter: 3, period: `${year}-Q3`, start: `${year}-06-16`, end: `${year}-09-15`, dueDate: `${year}-09-15` },
    { quarter: 4, period: `${year}-Q4`, start: `${year}-09-16`, end: `${year + 1}-01-15`, dueDate: `${year + 1}-01-15` },
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

export interface ComputeQuarterStatusesInput {
  year: number;
  /** Safe-harbor required annual payment (withholding + estimates). */
  annualTarget: number;
  /** Expected full-year withholding, credited evenly across quarters. */
  annualWithholding: number;
  payments: EstimatedPayment[];
}

/**
 * Per-quarter cumulative progress against the annual safe-harbor target
 * using the standard 25/50/75/100% installment schedule.
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
    const requiredCumulative = round2(annualTarget * fraction);
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
