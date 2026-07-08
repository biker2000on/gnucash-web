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

export interface ContributionActuals {
  trad401k: number;
  tradIra: number;
  hsa: number;
  sepIra: number;
  simpleIra: number;
}

/**
 * Resolve employee contribution actuals per plan family.
 *
 * When any account of a plan family is FLAGGED as retirement in the book,
 * the classifier-based contributionsByType is authoritative: it excludes
 * internal transfers, employer match, and dividends/interest received inside
 * the account. The raw tax-category sum is only a fallback for books that
 * haven't flagged retirement accounts — taking Math.max of both would let a
 * mapped IRA's internal dividends inflate its "contributions".
 */
export function resolveContributionActuals(bookData: BookTaxData): ContributionActuals {
  const c = bookData.contributionsByType ?? {};
  const flagged = new Set(bookData.flaggedRetirementTypes ?? []);

  const actual = (typeKeys: string[], category: TaxCategory): number => {
    const fromTypes = typeKeys.reduce((sum, key) => sum + (c[key] ?? 0), 0);
    if (typeKeys.some(key => flagged.has(key))) {
      return round2(fromTypes);
    }
    return round2(Math.max(fromTypes, categoryTotal(bookData, category)));
  };

  return {
    trad401k: actual(['401k', '403b', '457'], 'trad_401k_contribution'),
    tradIra: actual(['traditional_ira'], 'trad_ira_contribution'),
    hsa: actual(['hsa', 'hsa_family'], 'hsa_contribution'),
    sepIra: actual(['sep_ira'], 'sep_ira_contribution'),
    simpleIra: actual(['simple_ira'], 'simple_ira_contribution'),
  };
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
