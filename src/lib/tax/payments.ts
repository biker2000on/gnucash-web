/**
 * Tax payments summary — pure helper for the estimator page (and tests).
 *
 * Sums federal/state withholding plus estimated tax payments (1040-ES /
 * state vouchers) from book category totals. All four categories are simple
 * annual flows, so a single annualization factor applies uniformly — pass
 * the same factor the page uses for other ANNUALIZABLE categories.
 */

import type { BookTaxData, TaxCategory } from './types';

export interface TaxPaymentsSummary {
  /** Federal income tax withheld (federal_withholding) */
  withholding: number;
  /** Federal 1040-ES estimated payments (estimated_tax_payment) */
  estimatedPayments: number;
  /** State income tax withheld (state_withholding) */
  stateWithholding: number;
  /** State estimated voucher payments (state_estimated_tax_payment) */
  stateEstimatedPayments: number;
  /** withholding + estimatedPayments */
  totalFederalPaid: number;
  /** stateWithholding + stateEstimatedPayments */
  totalStatePaid: number;
  /** totalFederalPaid + totalStatePaid */
  totalPaid: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function categoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

export function summarizeTaxPayments(bookData: BookTaxData, factor = 1): TaxPaymentsSummary {
  const withholding = round2(categoryTotal(bookData, 'federal_withholding') * factor);
  const estimatedPayments = round2(categoryTotal(bookData, 'estimated_tax_payment') * factor);
  const stateWithholding = round2(categoryTotal(bookData, 'state_withholding') * factor);
  const stateEstimatedPayments = round2(
    categoryTotal(bookData, 'state_estimated_tax_payment') * factor,
  );
  const totalFederalPaid = round2(withholding + estimatedPayments);
  const totalStatePaid = round2(stateWithholding + stateEstimatedPayments);
  return {
    withholding,
    estimatedPayments,
    stateWithholding,
    stateEstimatedPayments,
    totalFederalPaid,
    totalStatePaid,
    totalPaid: round2(totalFederalPaid + totalStatePaid),
  };
}
