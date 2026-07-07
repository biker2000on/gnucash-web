/**
 * summarizeTaxPayments — the pure payment-summing helper used by the
 * tax estimator page's buildInputs (withholding + estimated payments,
 * federal and state, with uniform annualization).
 */

import { describe, it, expect } from 'vitest';
import { summarizeTaxPayments } from '@/lib/tax/payments';
import type { BookTaxData, TaxCategory } from '@/lib/tax/types';

function bookData(totals: Partial<Record<TaxCategory, number>>): BookTaxData {
  return {
    year: 2025,
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    asOfDate: '2025-07-01',
    elapsedYearFraction: 0.5,
    categories: Object.entries(totals).map(([category, total]) => ({
      category: category as TaxCategory,
      total: total as number,
      accounts: [],
    })),
    realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
    contributionsByType: {},
    mappedAccountCount: Object.keys(totals).length,
  };
}

describe('summarizeTaxPayments', () => {
  it('sums withholding and estimated payments per jurisdiction', () => {
    const p = summarizeTaxPayments(bookData({
      federal_withholding: 12_000,
      estimated_tax_payment: 4_000,
      state_withholding: 3_000,
      state_estimated_tax_payment: 1_200,
    }));
    expect(p.withholding).toBe(12_000);
    expect(p.estimatedPayments).toBe(4_000);
    expect(p.stateWithholding).toBe(3_000);
    expect(p.stateEstimatedPayments).toBe(1_200);
    expect(p.totalFederalPaid).toBe(16_000);
    expect(p.totalStatePaid).toBe(4_200);
    expect(p.totalPaid).toBe(20_200);
  });

  it('defaults missing categories to zero', () => {
    const p = summarizeTaxPayments(bookData({ federal_withholding: 5_000 }));
    expect(p.estimatedPayments).toBe(0);
    expect(p.stateWithholding).toBe(0);
    expect(p.stateEstimatedPayments).toBe(0);
    expect(p.totalPaid).toBe(5_000);
  });

  it('applies the annualization factor uniformly (mirrors withholding)', () => {
    const p = summarizeTaxPayments(
      bookData({
        federal_withholding: 6_000,
        estimated_tax_payment: 2_000,
        state_withholding: 1_500,
        state_estimated_tax_payment: 600,
      }),
      2, // half the year elapsed → double YTD
    );
    expect(p.withholding).toBe(12_000);
    expect(p.estimatedPayments).toBe(4_000);
    expect(p.stateWithholding).toBe(3_000);
    expect(p.stateEstimatedPayments).toBe(1_200);
    expect(p.totalPaid).toBe(20_200);
  });

  it('rounds to cents', () => {
    const p = summarizeTaxPayments(bookData({ estimated_tax_payment: 1000.005 }));
    expect(p.estimatedPayments).toBe(1000.01);
  });
});
