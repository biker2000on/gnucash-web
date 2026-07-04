/**
 * Tests for mortgage amortization schedule builders,
 * especially the hybrid schedule's extra-principal attribution
 * for actual (historical) payments.
 */

import { describe, it, expect } from 'vitest';
import {
  calcMonthlyPayment,
  buildAmortizationSchedule,
  buildHybridSchedule,
  buildScheduleForStrategy,
  totalInterestFromSchedule,
} from '../mortgage-schedule';
import type { ActualPayment } from '@/components/mortgage/MortgageAutoDetect';

const ORIGINAL = 232000;
const ANNUAL_RATE = 2.75;
const MONTHLY_RATE = ANNUAL_RATE / 100 / 12;
const TERM = 360;

function makePayment(date: string, principal: number, interest: number): ActualPayment {
  return { date, principal, interest, total: principal + interest };
}

describe('calcMonthlyPayment', () => {
  it('computes the standard P&I payment', () => {
    // 232000 at 2.75% / 360 months => ~947.12
    expect(calcMonthlyPayment(ORIGINAL, MONTHLY_RATE, TERM)).toBeCloseTo(947.12, 1);
  });
});

describe('buildHybridSchedule - extra principal on actual payments', () => {
  it('shows nonzero extra when actual principal exceeds scheduled principal', () => {
    // Scheduled principal for month 1: 947.12 - 232000*rate(531.67) = 415.45
    // Actual payments mirror the real Lenoir/PNC data: extra principal paid.
    const payments = [
      makePayment('2020-11-30', 415.45, 531.67), // exactly scheduled => extra 0
      makePayment('2021-01-01', 483.52, 530.71), // ~67 extra
      makePayment('2021-02-01', 484.62, 529.61), // ~67 extra
    ];

    const rows = buildHybridSchedule(payments, ORIGINAL, MONTHLY_RATE, TERM, 0, null);
    const actualRows = rows.filter(r => r.actual);
    expect(actualRows).toHaveLength(3);

    // First payment matches schedule: no extra
    expect(actualRows[0].extra).toBeCloseTo(0, 1);
    expect(actualRows[0].principal).toBeCloseTo(415.45, 2);

    // Second/third payments carry extra principal
    expect(actualRows[1].extra).toBeGreaterThan(60);
    expect(actualRows[1].extra).toBeLessThan(75);
    // principal + extra = actual principal paid
    expect(actualRows[1].principal + actualRows[1].extra).toBeCloseTo(483.52, 2);
    expect(actualRows[2].extra).toBeGreaterThan(60);

    // Payment column shows the actual total paid
    expect(actualRows[1].payment).toBeCloseTo(483.52 + 530.71, 2);
  });

  it('balance column follows actual principal payments', () => {
    const payments = [
      makePayment('2020-11-30', 415.45, 531.67),
      makePayment('2021-01-01', 483.52, 530.71),
    ];

    const rows = buildHybridSchedule(payments, ORIGINAL, MONTHLY_RATE, TERM, 0, null);
    expect(rows[0].balance).toBeCloseTo(ORIGINAL - 415.45, 2);
    expect(rows[1].balance).toBeCloseTo(ORIGINAL - 415.45 - 483.52, 2);
  });

  it('treats a second payment in the same month entirely as extra', () => {
    const payments = [
      makePayment('2026-01-02', 619.85, 446.27), // regular monthly payment
      makePayment('2026-01-02', 119.0, 0),       // PAYMENT TO PRINCIPAL same day
    ];

    const rows = buildHybridSchedule(payments, ORIGINAL, MONTHLY_RATE, TERM, 0, null);
    // Second same-month payment: no scheduled baseline consumed => all extra
    expect(rows[1].extra).toBeCloseTo(119.0, 2);
    expect(rows[1].principal).toBeCloseTo(0, 2);
  });

  it('handles negative principal (escrow disbursement) without fake extra', () => {
    const payments = [
      makePayment('2026-03-02', 1381.0, 0),
      makePayment('2026-04-02', -2107.0, 0), // HOMEOWNERS INSURANCE DISBURSEMENT
    ];

    const rows = buildHybridSchedule(payments, ORIGINAL, MONTHLY_RATE, TERM, 0, null);
    expect(rows[1].extra).toBe(0);
    // Disbursement increases the balance
    expect(rows[1].balance).toBeGreaterThan(rows[0].balance);
  });

  it('projection resumes from the provided current balance', () => {
    const payments = [
      makePayment('2025-11-04', 729.14, 446.27),
      makePayment('2025-12-02', 619.85, 446.27),
    ];
    const currentBalance = -184372.64; // signed, as GnuCash liability balance

    const rows = buildHybridSchedule(payments, ORIGINAL, MONTHLY_RATE, TERM, 0, currentBalance);
    const firstProjected = rows.find(r => r.actual === false);
    expect(firstProjected).toBeDefined();
    // First projected interest computed on |currentBalance|
    expect(firstProjected!.interest).toBeCloseTo(184372.64 * MONTHLY_RATE, 1);
    // Projected balance is below the current balance
    expect(firstProjected!.balance).toBeLessThan(184372.64);
  });

  it('projection rows carry dates after the last actual payment', () => {
    const payments = [makePayment('2025-12-02', 619.85, 446.27)];
    const rows = buildHybridSchedule(payments, ORIGINAL, MONTHLY_RATE, TERM, 0, 180000);
    const firstProjected = rows.find(r => r.actual === false);
    expect(firstProjected!.date! > '2025-12-02').toBe(true);
  });
});

describe('buildAmortizationSchedule', () => {
  it('pays off faster with extra payments', () => {
    const base = buildAmortizationSchedule(ORIGINAL, MONTHLY_RATE, TERM, 0);
    const extra = buildAmortizationSchedule(ORIGINAL, MONTHLY_RATE, TERM, 500);
    expect(base).toHaveLength(360);
    expect(extra.length).toBeLessThan(base.length);
    expect(extra.every(r => r.extra >= 0)).toBe(true);
  });
});

describe('buildScheduleForStrategy', () => {
  const P = 300000;
  const R = 6.5 / 100 / 12;
  const TERM_30 = 360;

  it('none matches the plain no-extra schedule length', () => {
    const none = buildScheduleForStrategy(P, R, TERM_30, { type: 'none' });
    const plain = buildAmortizationSchedule(P, R, TERM_30, 0);
    expect(none.length).toBe(plain.length);
    expect(none.length).toBe(360);
  });

  it('fixed_monthly shortens the term and never over-pays the balance', () => {
    const s = buildScheduleForStrategy(P, R, TERM_30, { type: 'fixed_monthly', fixedMonthly: 500 });
    expect(s.length).toBeLessThan(360);
    expect(s[s.length - 1].balance).toBe(0);
    // Extra never draws the balance negative; final row extra is capped
    expect(s.every(r => r.extra >= 0 && r.balance >= 0)).toBe(true);
  });

  it('extra_annual with 1/year ("13 payments") beats regular and saves interest', () => {
    const none = buildScheduleForStrategy(P, R, TERM_30, { type: 'none' });
    const s = buildScheduleForStrategy(P, R, TERM_30, { type: 'extra_annual', extraPaymentsPerYear: 1 });
    expect(s.length).toBeLessThan(none.length);
    expect(totalInterestFromSchedule(s)).toBeLessThan(totalInterestFromSchedule(none));
    // ~1 extra payment/year on a 30yr 6.5% loan removes roughly 4-5 years
    const yearsSaved = (none.length - s.length) / 12;
    expect(yearsSaved).toBeGreaterThan(3);
    expect(yearsSaved).toBeLessThan(7);
  });

  it('extra_annual with 4/year applies an extra payment every 3 months', () => {
    const s = buildScheduleForStrategy(P, R, TERM_30, { type: 'extra_annual', extraPaymentsPerYear: 4 });
    // Months 3,6,9,12 (before payoff) carry a big extra
    expect(s[2].extra).toBeGreaterThan(0);
    expect(s[5].extra).toBeGreaterThan(0);
    expect(s[0].extra).toBe(0);
    expect(s[1].extra).toBe(0);
  });

  it('roundup adds the rounding difference each month', () => {
    const base = calcMonthlyPayment(P, R, TERM_30); // ~1896.20
    const s = buildScheduleForStrategy(P, R, TERM_30, { type: 'roundup', roundUpTo: 100 });
    const expectedExtra = Math.ceil(base / 100) * 100 - base; // ~3.80
    expect(s[0].extra).toBeCloseTo(expectedExtra, 2);
    expect(s.length).toBeLessThanOrEqual(360);
  });

  it('lump_sum applies once at the chosen month', () => {
    const s = buildScheduleForStrategy(P, R, TERM_30, { type: 'lump_sum', lumpSum: 20000, lumpSumMonth: 12 });
    expect(s[11].extra).toBeCloseTo(20000, 0);
    expect(s.filter(r => r.extra > 0)).toHaveLength(1);
    expect(s.length).toBeLessThan(360);
  });

  it('biweekly pays off faster than regular monthly and stays monthly-aggregated', () => {
    const none = buildScheduleForStrategy(P, R, TERM_30, { type: 'none' });
    const s = buildScheduleForStrategy(P, R, TERM_30, { type: 'biweekly' }, new Date('2026-01-01'));
    expect(s.length).toBeLessThan(none.length);
    expect(s[s.length - 1].balance).toBeLessThanOrEqual(0.01);
    // Roughly one extra payment per year → ~4-6 years off a 30yr loan
    const yearsSaved = (none.length - s.length) / 12;
    expect(yearsSaved).toBeGreaterThan(3);
  });
});
