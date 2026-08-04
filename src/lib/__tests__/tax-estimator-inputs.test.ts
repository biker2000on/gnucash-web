/**
 * Shared estimator input assembly — parity between the tax estimator page
 * and the withholding checkup.
 *
 * The 2026-08-04 audit found the checkup rebuilt the page's buildInputs but
 * skipped the Child Tax Credit and the §219(g) traditional-IRA deduction
 * phase-out cap. Both now flow through buildFederalInputsFromBookData +
 * applyHouseholdTaxDetails; these tests pin the shared behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  ANNUALIZABLE_CATEGORIES,
  applyHouseholdTaxDetails,
  buildFederalInputsFromBookData,
  type HouseholdTaxContext,
} from '@/lib/tax/estimator-inputs';
import { buildFederalInputsFromBook, computeWithholdingCheckup } from '@/lib/withholding';
import { computeFederalTax } from '@/lib/tax/federal';
import type { BookTaxData, TaxCategory } from '@/lib/tax/types';

function bookData(
  totals: Partial<Record<TaxCategory, number>>,
  over: Partial<BookTaxData> = {},
): BookTaxData {
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
    realizedGains: { shortTerm: 500, longTerm: 1_500, accounts: [] },
    contributionsByType: {},
    mappedAccountCount: Object.keys(totals).length,
    ...over,
  };
}

const TOTALS: Partial<Record<TaxCategory, number>> = {
  w2_wages: 80_000,
  interest_income: 400,
  ordinary_dividends: 1_000,
  qualified_dividends: 600,
  trad_ira_contribution: 3_500,
  federal_withholding: 9_000,
  state_withholding: 2_000,
  property_tax: 1_800,
  charitable_donation: 1_200,
};

describe('buildFederalInputsFromBookData', () => {
  it('maps categories to engine inputs (factor 1)', () => {
    const inputs = buildFederalInputsFromBookData(bookData(TOTALS), 2025, 'single', 0, 1);
    expect(inputs.wages).toBe(80_000);
    expect(inputs.interest).toBe(400);
    // ordinary dividends INCLUDE qualified
    expect(inputs.ordinaryDividends).toBe(1_600);
    expect(inputs.qualifiedDividends).toBe(600);
    expect(inputs.shortTermCapitalGains).toBe(500);
    expect(inputs.longTermCapitalGains).toBe(1_500);
    expect(inputs.traditionalIraContributions).toBe(3_500);
    // SALT = state withholding + property tax (+ estimates + local)
    expect(inputs.stateLocalTaxesPaid).toBe(3_800);
    expect(inputs.charitableDonations).toBe(1_200);
  });

  it('annualizes flows but never gains or contributions', () => {
    const inputs = buildFederalInputsFromBookData(bookData(TOTALS), 2025, 'single', 0, 2);
    expect(inputs.wages).toBe(160_000);
    expect(inputs.stateLocalTaxesPaid).toBe(7_600);
    // point-in-time / limit-bound values are never annualized
    expect(inputs.shortTermCapitalGains).toBe(500);
    expect(inputs.longTermCapitalGains).toBe(1_500);
    expect(inputs.traditionalIraContributions).toBe(3_500);
  });

  it('the withholding checkup builder is the shared builder at factor 1', () => {
    const data = bookData(TOTALS);
    expect(buildFederalInputsFromBook(data, 2025, 'single', 1)).toEqual(
      buildFederalInputsFromBookData(data, 2025, 'single', 1, 1),
    );
  });

  it('ANNUALIZABLE_CATEGORIES excludes contributions and includes flows', () => {
    expect(ANNUALIZABLE_CATEGORIES).toContain('w2_wages');
    expect(ANNUALIZABLE_CATEGORIES).toContain('federal_withholding');
    expect(ANNUALIZABLE_CATEGORIES).not.toContain('trad_ira_contribution');
    expect(ANNUALIZABLE_CATEGORIES).not.toContain('hsa_contribution');
  });
});

describe('applyHouseholdTaxDetails', () => {
  const household = (over: Partial<HouseholdTaxContext> = {}): HouseholdTaxContext => ({
    qualifyingChildrenUnder17: 2,
    coveredByEmployerPlan: true,
    spouseCoveredByEmployerPlan: false,
    selfIraLimit: 7_000,
    spouseIraLimit: null,
    ...over,
  });

  it('sets the Child Tax Credit count and the credit lands in the engine', () => {
    const base = buildFederalInputsFromBookData(bookData({ w2_wages: 90_000 }, {
      realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
    }), 2025, 'mfj', 0, 1);
    const { inputs } = applyHouseholdTaxDetails(base, household({
      coveredByEmployerPlan: false,
    }));
    expect(inputs.qualifyingChildrenUnder17).toBe(2);
    const federal = computeFederalTax(inputs);
    expect(federal.credits).toBe(4_400); // 2 × $2,200 (2025 OBBBA)
  });

  it('caps the traditional IRA deduction for a covered filer above the MAGI range', () => {
    // Single, covered, MAGI without IRA = 139,000 > 89,000 → nothing deductible
    const base = buildFederalInputsFromBookData(
      bookData({ w2_wages: 139_000, trad_ira_contribution: 7_000 }, {
        realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
      }),
      2025, 'single', 0, 1,
    );
    const { inputs, phaseOuts } = applyHouseholdTaxDetails(base, household({
      qualifyingChildrenUnder17: 0,
    }));
    expect(inputs.traditionalIraContributions).toBe(0);
    expect(phaseOuts.nonDeductibleIra).toBe(7_000);
    expect(phaseOuts.self.deduction?.status).toBe('none');
  });

  it('leaves contributions deductible when neither spouse is covered', () => {
    const base = buildFederalInputsFromBookData(
      bookData({ w2_wages: 139_000, trad_ira_contribution: 7_000 }, {
        realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
      }),
      2025, 'single', 0, 1,
    );
    const { inputs, phaseOuts } = applyHouseholdTaxDetails(base, household({
      qualifyingChildrenUnder17: 0,
      coveredByEmployerPlan: false,
    }));
    expect(inputs.traditionalIraContributions).toBe(7_000);
    expect(phaseOuts.nonDeductibleIra).toBe(0);
  });

  it('splits joint contributions per spouse for the phase-out', () => {
    const base = buildFederalInputsFromBookData(
      bookData({ w2_wages: 100_000 }, {
        realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
        contributionsByType: { traditional_ira: 10_000 },
        flaggedRetirementTypes: ['traditional_ira'],
        contributionsByTypeAndOwner: { traditional_ira: { self: 6_000, spouse: 4_000 } },
      }),
      2025, 'mfj', 0, 1,
    );
    const { phaseOuts } = applyHouseholdTaxDetails(base, household({
      coveredByEmployerPlan: false,
      spouseIraLimit: 8_000,
      contributionsByTypeAndOwner: { traditional_ira: { self: 6_000, spouse: 4_000 } },
    }));
    expect(phaseOuts.self.tradContrib).toBe(6_000);
    expect(phaseOuts.spouse?.tradContrib).toBe(4_000);
  });
});

describe('withholding checkup parity with the estimator page', () => {
  it('applies CTC and the IRA cap to the projected year exactly like the page', () => {
    const data = bookData({
      w2_wages: 69_500, // ×2 annualized = 139,000 → above the covered range
      trad_ira_contribution: 7_000,
      federal_withholding: 8_000,
    }, { realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] } });

    const ytdInputs = buildFederalInputsFromBook(data, 2025, 'single', 0);
    const householdCtx: HouseholdTaxContext = {
      qualifyingChildrenUnder17: 1,
      coveredByEmployerPlan: true,
      spouseCoveredByEmployerPlan: false,
      selfIraLimit: 7_000,
      spouseIraLimit: null,
    };

    const checkup = computeWithholdingCheckup({
      year: 2025,
      filingStatus: 'single',
      elapsedYearFraction: 0.5,
      annualize: true,
      ytdInputs,
      ytdWithholding: 8_000,
      ytdEstimatedPayments: 0,
      priorYearTax: null,
      priorYearAgi: null,
      remainingPayPeriods: 13,
      asOfDate: '2025-07-01',
      household: householdCtx,
    });

    // Page pipeline on the same annualized inputs must agree exactly.
    const pageInputs = buildFederalInputsFromBookData(data, 2025, 'single', 0, 2);
    const page = applyHouseholdTaxDetails(pageInputs, householdCtx);
    const pageFederal = computeFederalTax(page.inputs);

    expect(checkup.projectedInputs.traditionalIraContributions).toBe(0); // §219(g) capped
    expect(checkup.projectedInputs.qualifyingChildrenUnder17).toBe(1);
    expect(checkup.federal.credits).toBe(pageFederal.credits);
    expect(checkup.federal.credits).toBeGreaterThan(0); // CTC applied
    expect(checkup.projectedLiability).toBe(pageFederal.totalTax);
    expect(checkup.phaseOuts?.nonDeductibleIra).toBe(7_000);
  });

  it('without household context the checkup behaves as before (no CTC, full IRA)', () => {
    const data = bookData({
      w2_wages: 69_500,
      trad_ira_contribution: 7_000,
    }, { realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] } });
    const ytdInputs = buildFederalInputsFromBook(data, 2025, 'single', 0);
    const checkup = computeWithholdingCheckup({
      year: 2025,
      filingStatus: 'single',
      elapsedYearFraction: 0.5,
      annualize: true,
      ytdInputs,
      ytdWithholding: 0,
      ytdEstimatedPayments: 0,
      priorYearTax: null,
      priorYearAgi: null,
      remainingPayPeriods: null,
      asOfDate: '2025-07-01',
    });
    expect(checkup.projectedInputs.traditionalIraContributions).toBe(7_000);
    expect(checkup.federal.credits).toBe(0);
    expect(checkup.phaseOuts).toBeNull();
  });
});
