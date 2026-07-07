import { describe, it, expect } from 'vitest';
import { suggestTaxCategory, suggestTaxMappings, type SuggestableAccount } from '@/lib/tax/suggest';

function acct(overrides: Partial<SuggestableAccount>): SuggestableAccount {
  return {
    guid: 'a'.repeat(32),
    name: 'Test',
    fullname: 'Test',
    accountType: 'EXPENSE',
    retirementAccountType: null,
    ...overrides,
  };
}

describe('suggestTaxCategory', () => {
  it('INCOME salary account → w2_wages', () => {
    const s = suggestTaxCategory(acct({ accountType: 'INCOME', name: 'Salary', fullname: 'Income:Salary' }));
    expect(s?.category).toBe('w2_wages');
  });

  it('matches paycheck/wages keywords in parent path', () => {
    const s = suggestTaxCategory(acct({ accountType: 'INCOME', name: 'Acme Corp', fullname: 'Income:Paycheck:Acme Corp' }));
    expect(s?.category).toBe('w2_wages');
  });

  it('EXPENSE federal tax → federal_withholding', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Taxes:Federal Income Tax' }))?.category).toBe('federal_withholding');
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Taxes:Fed Withholding' }))?.category).toBe('federal_withholding');
  });

  it('EXPENSE social security / medicare → FICA categories', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Taxes:Social Security' }))?.category).toBe('fica_social_security');
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Taxes:Medicare' }))?.category).toBe('fica_medicare');
  });

  it('EXPENSE state tax → state_withholding', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Taxes:State Income Tax' }))?.category).toBe('state_withholding');
  });

  it('property tax beats generic state/local', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Home:Property Tax' }))?.category).toBe('property_tax');
  });

  it('INCOME dividend/interest accounts', () => {
    expect(suggestTaxCategory(acct({ accountType: 'INCOME', fullname: 'Income:Dividends:VTSAX' }))?.category).toBe('ordinary_dividends');
    expect(suggestTaxCategory(acct({ accountType: 'INCOME', fullname: 'Income:Interest:Savings' }))?.category).toBe('interest_income');
    expect(suggestTaxCategory(acct({ accountType: 'INCOME', fullname: 'Income:Qualified Dividends' }))?.category).toBe('qualified_dividends');
  });

  it('charitable giving keywords', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Charity:Red Cross' }))?.category).toBe('charitable_donation');
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Donations' }))?.category).toBe('charitable_donation');
  });

  it('mortgage interest requires both words', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Mortgage Interest' }))?.category).toBe('mortgage_interest');
    // plain "Interest" expense should not match mortgage interest or interest income
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Credit Card Interest' }))).toBeNull();
  });

  it('retirement preference seeds contribution categories', () => {
    expect(
      suggestTaxCategory(acct({ accountType: 'ASSET', fullname: 'Assets:Retirement:401k', retirementAccountType: '401k' }))?.category,
    ).toBe('trad_401k_contribution');
    expect(
      suggestTaxCategory(acct({ accountType: 'ASSET', fullname: 'Assets:Retirement:Roth 401k', retirementAccountType: '401k' }))?.category,
    ).toBe('roth_401k_contribution');
    expect(
      suggestTaxCategory(acct({ accountType: 'ASSET', fullname: 'Assets:Retirement:Roth IRA', retirementAccountType: 'roth_ira' }))?.category,
    ).toBe('roth_ira_contribution');
    expect(
      suggestTaxCategory(acct({ accountType: 'BANK', fullname: 'Assets:HSA', retirementAccountType: 'hsa' }))?.category,
    ).toBe('hsa_contribution');
  });

  it('returns null for unmatchable accounts', () => {
    expect(suggestTaxCategory(acct({ fullname: 'Expenses:Groceries' }))).toBeNull();
    expect(suggestTaxCategory(acct({ accountType: 'BANK', fullname: 'Assets:Checking' }))).toBeNull();
  });

  it('income rules do not fire on expense accounts', () => {
    expect(suggestTaxCategory(acct({ accountType: 'EXPENSE', fullname: 'Expenses:Rent' }))).toBeNull();
  });
});

describe('suggestTaxMappings', () => {
  it('skips already-mapped accounts', () => {
    const accounts = [
      acct({ guid: '1'.repeat(32), accountType: 'INCOME', fullname: 'Income:Salary' }),
      acct({ guid: '2'.repeat(32), accountType: 'INCOME', fullname: 'Income:Interest' }),
    ];
    const suggestions = suggestTaxMappings(accounts, { ['1'.repeat(32)]: 'w2_wages' });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].accountGuid).toBe('2'.repeat(32));
    expect(suggestions[0].category).toBe('interest_income');
  });

  it('every suggestion includes a reason', () => {
    const suggestions = suggestTaxMappings(
      [acct({ accountType: 'INCOME', fullname: 'Income:Salary' })],
      {},
    );
    expect(suggestions[0].reason.length).toBeGreaterThan(0);
  });
});

describe('non-taxable / tax-exempt naming rules', () => {
  it('suggests exclude for income accounts named non-taxable', () => {
    const s = suggestTaxCategory({
      guid: 'g1',
      name: 'non-taxable',
      fullname: 'Income:Investment:Dividend Income:non-taxable',
      accountType: 'INCOME',
    });
    expect(s?.category).toBe('exclude');
  });

  it('suggests tax_exempt_interest for municipal interest income', () => {
    const s = suggestTaxCategory({
      guid: 'g2',
      name: 'Muni Bond Interest',
      fullname: 'Income:Investment:Interest:Muni Bond Interest',
      accountType: 'INCOME',
    });
    expect(s?.category).toBe('tax_exempt_interest');
  });

  it('does not misfire the non-taxable rule on ":taxable" accounts', () => {
    const s = suggestTaxCategory({
      guid: 'g3',
      name: 'taxable',
      fullname: 'Income:Investment:Dividend Income:taxable',
      accountType: 'INCOME',
    });
    expect(s?.category).toBe('ordinary_dividends');
  });

  it('suggests exclude for non-taxable asset accounts too', () => {
    const s = suggestTaxCategory({
      guid: 'g4',
      name: 'Non-Taxable Brokerage',
      fullname: 'Assets:Investments:Non-Taxable Brokerage',
      accountType: 'ASSET',
    });
    expect(s?.category).toBe('exclude');
  });
});
