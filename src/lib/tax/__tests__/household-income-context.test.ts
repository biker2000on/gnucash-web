import { describe, expect, it } from 'vitest';
import type { BookTaxData, TaxCategory } from '../types';
import { buildHouseholdIncomeContext } from '../household-income-context';

function data(categories: Array<[TaxCategory, Array<[string, number]>]>): BookTaxData {
  return {
    year: 2026,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    asOfDate: '2026-07-01',
    elapsedYearFraction: 0.5,
    categories: categories.map(([category, accounts]) => ({
      category,
      total: accounts.reduce((sum, [, amount]) => sum + amount, 0),
      accounts: accounts.map(([accountGuid, amount]) => ({
        accountGuid,
        accountName: accountGuid,
        accountPath: accountGuid,
        amount,
      })),
    })),
    realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
    contributionsByType: {},
    mappedAccountCount: categories.length,
  };
}

describe('buildHouseholdIncomeContext', () => {
  it('annualizes all shared analyzer inputs and excludes separately modeled accounts', () => {
    const result = buildHouseholdIncomeContext(
      data([
        ['w2_wages', [['wages', 40_000]]],
        ['interest_income', [['interest', 500]]],
        ['self_employment_income', [['farm', 6_000], ['consulting', 10_000]]],
        ['business_expense', [['farm-expense', 2_000], ['consulting-expense', 3_000]]],
      ]),
      new Set(['farm', 'farm-expense']),
    );

    expect(result.w2Wages).toBe(80_000);
    expect(result.ordinaryIncome).toBe(81_000);
    expect(result.seIncome).toBe(14_000);
  });
});
