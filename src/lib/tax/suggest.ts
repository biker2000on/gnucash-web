/**
 * Tax category auto-suggestion — pure keyword/type heuristics.
 *
 * Proposes a TaxCategory for an account from its GnuCash account type,
 * name, full path, and (when available) the retirement_account_type from
 * account preferences. Returns null when no confident suggestion exists.
 */

import type { TaxCategory } from './types';

export interface SuggestableAccount {
  guid: string;
  name: string;
  /** Colon-separated full path from account_hierarchy.fullname */
  fullname: string;
  accountType: string; // GnuCash account_type (INCOME, EXPENSE, BANK, ...)
  /** From gnucash_web_account_preferences (inherited from flagged parents) */
  retirementAccountType?: string | null;
}

export interface TaxMappingSuggestion {
  accountGuid: string;
  category: TaxCategory;
  reason: string;
}

interface Rule {
  category: TaxCategory;
  /** Account types this rule applies to (empty = any) */
  types: string[];
  pattern: RegExp;
  reason: string;
}

/**
 * Ordered rules — first match wins. Patterns are tested against the
 * lowercase full path (so parent names like "Income:Salary" match too).
 */
const RULES: Rule[] = [
  // --- Withholding & FICA (expense-side, most specific first) ---
  { category: 'federal_withholding', types: ['EXPENSE', 'LIABILITY'], pattern: /federal.*(income.*)?tax|fed(eral)?.*withholding|\bfed wh\b|\bfit\b/, reason: 'Federal tax withholding keywords' },
  { category: 'fica_social_security', types: ['EXPENSE', 'LIABILITY'], pattern: /social security|\boasdi\b|\bss tax\b|\bfica.*(ss|social)/, reason: 'Social Security / OASDI keywords' },
  { category: 'fica_medicare', types: ['EXPENSE', 'LIABILITY'], pattern: /medicare/, reason: 'Medicare tax keywords' },
  { category: 'state_withholding', types: ['EXPENSE', 'LIABILITY'], pattern: /state.*(income.*)?tax|state.*withholding|\bsit\b/, reason: 'State tax withholding keywords' },
  { category: 'property_tax', types: ['EXPENSE'], pattern: /property tax|real estate tax|\bre tax\b/, reason: 'Property tax keywords' },
  { category: 'state_local_tax_paid', types: ['EXPENSE'], pattern: /local tax|city tax|county tax|\bsalt\b/, reason: 'Local tax keywords' },

  // --- Income ---
  { category: 'w2_wages', types: ['INCOME'], pattern: /salary|wages?\b|paycheck|payroll|\bw-?2\b|gross pay|employment income/, reason: 'Wage/salary keywords on an income account' },
  { category: 'qualified_dividends', types: ['INCOME'], pattern: /qualified div/, reason: 'Qualified dividend keywords' },
  { category: 'ordinary_dividends', types: ['INCOME'], pattern: /dividend|distributions?\b|cap(ital)? gains? dist/, reason: 'Dividend keywords on an income account' },
  { category: 'interest_income', types: ['INCOME'], pattern: /interest/, reason: 'Interest keywords on an income account' },
  { category: 'self_employment_income', types: ['INCOME'], pattern: /self.?employ|freelance|consulting|1099|contract(ing|or)|side (gig|hustle)|business income/, reason: 'Self-employment keywords' },
  { category: 'rental_income', types: ['INCOME'], pattern: /rent(al)?s?\b/, reason: 'Rental keywords on an income account' },
  { category: 'social_security_benefits', types: ['INCOME'], pattern: /social security|\bssa\b|\bss benefit/, reason: 'Social Security benefit keywords' },
  { category: 'retirement_income', types: ['INCOME'], pattern: /pension|annuity|ira (withdrawal|distribution)|401k? (withdrawal|distribution)|\brmd\b/, reason: 'Retirement distribution keywords' },

  // --- Deductions ---
  { category: 'charitable_donation', types: ['EXPENSE'], pattern: /charit|donation|tithe|tithing|church|non.?profit|giving/, reason: 'Charitable giving keywords' },
  { category: 'mortgage_interest', types: ['EXPENSE'], pattern: /mortgage.*interest|interest.*mortgage/, reason: 'Mortgage interest keywords' },
  { category: 'medical_expense', types: ['EXPENSE'], pattern: /medical|doctor|dental|health ?care|prescription|hospital/, reason: 'Medical expense keywords' },
  { category: 'education_expense', types: ['EXPENSE'], pattern: /tuition|education|student loan interest|529\b/, reason: 'Education expense keywords' },
  { category: 'business_expense', types: ['EXPENSE'], pattern: /business expense|home office|self.?employ/, reason: 'Business expense keywords' },
];

/** Map retirement_account_type preference → contribution category */
const RETIREMENT_TYPE_CATEGORY: Record<string, TaxCategory> = {
  '401k': 'trad_401k_contribution',
  '403b': 'trad_401k_contribution',
  '457': 'trad_401k_contribution',
  traditional_ira: 'trad_ira_contribution',
  roth_ira: 'roth_ira_contribution',
  hsa: 'hsa_contribution',
};

/**
 * Suggest a tax category for one account, or null if nothing matches.
 * Pure function.
 */
export function suggestTaxCategory(account: SuggestableAccount): TaxMappingSuggestion | null {
  const path = (account.fullname || account.name || '').toLowerCase();
  const type = (account.accountType || '').toUpperCase();

  // 1. Retirement account preference seeds contribution categories
  if (account.retirementAccountType) {
    const rt = account.retirementAccountType.toLowerCase();
    const isRoth = /roth/.test(path);
    if (rt in RETIREMENT_TYPE_CATEGORY) {
      let category = RETIREMENT_TYPE_CATEGORY[rt];
      if ((rt === '401k' || rt === '403b' || rt === '457') && isRoth) {
        category = 'roth_401k_contribution';
      }
      return {
        accountGuid: account.guid,
        category,
        reason: `Account flagged as ${account.retirementAccountType} retirement account`,
      };
    }
    // brokerage / hra / fsa: no contribution category
  }

  // 2. Keyword rules
  for (const rule of RULES) {
    if (rule.types.length > 0 && !rule.types.includes(type)) continue;
    if (rule.pattern.test(path)) {
      return { accountGuid: account.guid, category: rule.category, reason: rule.reason };
    }
  }

  return null;
}

/** Suggest categories for many accounts, skipping already-mapped ones. */
export function suggestTaxMappings(
  accounts: SuggestableAccount[],
  existingMappings: ReadonlyMap<string, TaxCategory> | Record<string, TaxCategory>,
): TaxMappingSuggestion[] {
  const mapped =
    existingMappings instanceof Map
      ? existingMappings
      : new Map(Object.entries(existingMappings));
  const out: TaxMappingSuggestion[] = [];
  for (const account of accounts) {
    if (mapped.has(account.guid)) continue;
    const suggestion = suggestTaxCategory(account);
    if (suggestion) out.push(suggestion);
  }
  return out;
}
