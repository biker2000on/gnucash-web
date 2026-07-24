import type { BookTaxData, TaxCategory } from './types';

export interface HouseholdIncomeContext {
  w2Wages: number;
  ordinaryIncome: number;
  seIncome: number;
}

export function taxCategoryTotal(
  data: BookTaxData,
  category: TaxCategory,
  excludeGuids: ReadonlySet<string> = new Set(),
): number {
  const aggregate = data.categories.find((item) => item.category === category);
  if (!aggregate) return 0;
  return aggregate.accounts
    .filter((account) => !excludeGuids.has(account.accountGuid))
    .reduce((sum, account) => sum + account.amount, 0);
}

/**
 * Annualized household income inputs shared by entity analyzers.
 *
 * `excludeGuids` removes a business/farm subtree already modeled separately,
 * preventing it from being counted once as household income and again as the
 * scenario's business income.
 */
export function buildHouseholdIncomeContext(
  data: BookTaxData,
  excludeGuids: ReadonlySet<string> = new Set(),
): HouseholdIncomeContext {
  const elapsed = data.elapsedYearFraction > 0 ? data.elapsedYearFraction : 1;
  const annual = (category: TaxCategory) =>
    taxCategoryTotal(data, category, excludeGuids) / elapsed;
  const round2 = (value: number) => Math.round(value * 100) / 100;

  const w2Wages = round2(annual('w2_wages'));
  const ordinaryIncome = round2(
    w2Wages +
      annual('interest_income') +
      annual('ordinary_dividends') +
      annual('rental_income') +
      annual('retirement_income') +
      annual('other_income'),
  );
  const seIncome = Math.max(
    0,
    round2(annual('self_employment_income') - annual('business_expense')),
  );

  return { w2Wages, ordinaryIncome, seIncome };
}
