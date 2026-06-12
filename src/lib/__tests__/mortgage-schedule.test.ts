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
