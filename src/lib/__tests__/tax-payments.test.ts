/**
 * summarizeTaxPayments — the pure payment-summing helper used by the
 * tax estimator page's buildInputs (withholding + estimated payments,
 * federal and state, with uniform annualization).
 */

import { describe, it, expect } from 'vitest';
import { resolveContributionActuals, summarizeTaxPayments } from '@/lib/tax/payments';
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

describe('resolveContributionActuals', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    categories: [
      { category: 'trad_ira_contribution', total: 4994.42, accounts: [] },
      { category: 'trad_401k_contribution', total: 15000, accounts: [] },
    ],
    contributionsByType: { traditional_ira: 3500 },
    flaggedRetirementTypes: ['traditional_ira'],
    ...over,
  }) as never;

  it('classifier is authoritative when the type is flagged (internal dividends do not inflate)', () => {
    const a = resolveContributionActuals(base());
    // Category total 4994.42 includes dividends received inside the IRA;
    // flagged type -> classifier value 3500 wins.
    expect(a.tradIra).toBe(3500);
  });

  it('falls back to the category total when the type is not flagged', () => {
    const a = resolveContributionActuals(base({ flaggedRetirementTypes: [] }));
    expect(a.tradIra).toBe(4994.42);
    expect(a.trad401k).toBe(15000);
  });

  it('sums plan-family keys and treats missing maps safely', () => {
    const a = resolveContributionActuals({
      categories: [],
      contributionsByType: { '401k': 10000, '403b': 2000, hsa: 1000, hsa_family: 500 },
      flaggedRetirementTypes: ['401k', '403b', 'hsa', 'hsa_family'],
    } as never);
    expect(a.trad401k).toBe(12000);
    expect(a.hsa).toBe(1500);
    expect(a.sepIra).toBe(0);
  });
});
