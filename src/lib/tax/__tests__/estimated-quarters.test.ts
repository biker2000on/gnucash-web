/**
 * Estimated-tax quarter tracking — pure bucketing/progress math tests.
 * Exercises only the exported pure functions (no prisma / no I/O).
 */

import { describe, expect, it } from 'vitest';
import {
  bucketPaymentsByQuarter,
  computeQuarterStatuses,
  quarterForPaymentDate,
  quarterWindows,
} from '../estimated-quarters';

describe('quarterWindows', () => {
  it('produces the four IRS installment due dates, Q4 in January of year+1', () => {
    const windows = quarterWindows(2026);
    expect(windows.map(w => w.dueDate)).toEqual([
      '2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15',
    ]);
    expect(windows.map(w => w.period)).toEqual([
      '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4',
    ]);
    // Windows tile with no gaps: each starts the day after the prior due date.
    expect(windows[1].start).toBe('2026-04-16');
    expect(windows[2].start).toBe('2026-06-16');
    expect(windows[3].start).toBe('2026-09-16');
  });
});

describe('quarterForPaymentDate', () => {
  it('attributes payments by due-date window boundaries', () => {
    expect(quarterForPaymentDate('2026-04-15', 2026)).toBe(1); // on the due date
    expect(quarterForPaymentDate('2026-04-16', 2026)).toBe(2); // day after → Q2
    expect(quarterForPaymentDate('2026-06-15', 2026)).toBe(2);
    expect(quarterForPaymentDate('2026-09-15', 2026)).toBe(3);
    expect(quarterForPaymentDate('2026-12-31', 2026)).toBe(4);
    expect(quarterForPaymentDate('2027-01-15', 2026)).toBe(4); // Q4 due date in year+1
  });

  it('treats January 1–15 payments as the PRIOR year Q4 (excluded)', () => {
    expect(quarterForPaymentDate('2026-01-10', 2026)).toBeNull();
    expect(quarterForPaymentDate('2026-01-15', 2026)).toBeNull();
    expect(quarterForPaymentDate('2026-01-16', 2026)).toBe(1);
  });

  it('counts payments after the Q4 due date as late Q4', () => {
    expect(quarterForPaymentDate('2027-01-20', 2026)).toBe(4);
    expect(quarterForPaymentDate('2027-03-01', 2026)).toBe(4);
  });
});

describe('bucketPaymentsByQuarter', () => {
  it('sums payments into the right buckets and rounds to cents', () => {
    const buckets = bucketPaymentsByQuarter(
      [
        { date: '2026-01-10', amount: 999 },     // prior-year Q4 — dropped
        { date: '2026-03-01', amount: 1000.004 },
        { date: '2026-04-14', amount: 500 },
        { date: '2026-06-01', amount: 2000 },
        { date: '2026-08-15', amount: 1500 },
        { date: '2026-12-20', amount: 750 },
        { date: '2027-01-14', amount: 250 },
      ],
      2026,
    );
    expect(buckets).toEqual([1500, 2000, 1500, 1000]);
  });

  it('returns zeros for no payments', () => {
    expect(bucketPaymentsByQuarter([], 2026)).toEqual([0, 0, 0, 0]);
  });
});

describe('computeQuarterStatuses', () => {
  it('applies the 25/50/75/100% cumulative schedule with even withholding credit', () => {
    const quarters = computeQuarterStatuses({
      year: 2026,
      annualTarget: 8000,
      annualWithholding: 4000,
      payments: [{ date: '2026-04-01', amount: 1000 }],
    });

    expect(quarters.map(q => q.requiredCumulative)).toEqual([2000, 4000, 6000, 8000]);
    expect(quarters.map(q => q.withholdingCreditCumulative)).toEqual([1000, 2000, 3000, 4000]);
    expect(quarters.map(q => q.estimatedPaidCumulative)).toEqual([1000, 1000, 1000, 1000]);

    // Q1: 1000 withholding + 1000 paid = 2000 required → exactly covered.
    expect(quarters[0].shortfall).toBe(0);
    expect(quarters[0].surplus).toBe(0);
    // Q2: 2000 + 1000 = 3000 vs 4000 → short 1000.
    expect(quarters[1].shortfall).toBe(1000);
    // Q4: 4000 + 1000 = 5000 vs 8000 → short 3000.
    expect(quarters[3].shortfall).toBe(3000);
  });

  it('reports surplus when ahead of schedule', () => {
    const quarters = computeQuarterStatuses({
      year: 2026,
      annualTarget: 4000,
      annualWithholding: 0,
      payments: [{ date: '2026-02-01', amount: 4000 }],
    });
    expect(quarters[0].surplus).toBe(3000);
    expect(quarters[3].shortfall).toBe(0);
    expect(quarters[3].surplus).toBe(0);
  });

  it('handles a zero target (under-$1,000 rule) with no shortfalls', () => {
    const quarters = computeQuarterStatuses({
      year: 2026,
      annualTarget: 0,
      annualWithholding: 1200,
      payments: [],
    });
    for (const q of quarters) {
      expect(q.requiredCumulative).toBe(0);
      expect(q.shortfall).toBe(0);
    }
  });

  it('clamps negative inputs and rounds cumulative math to cents', () => {
    const quarters = computeQuarterStatuses({
      year: 2026,
      annualTarget: 1000.01,
      annualWithholding: -50,
      payments: [
        { date: '2026-03-01', amount: 33.34 },
        { date: '2026-05-01', amount: 33.33 },
      ],
    });
    expect(quarters.map(q => q.requiredCumulative)).toEqual([250, 500.01, 750.01, 1000.01]);
    expect(quarters[0].withholdingCreditCumulative).toBe(0);
    expect(quarters[1].estimatedPaidCumulative).toBeCloseTo(66.67, 2);
  });
});
