/**
 * How each tax category actually affects a return.
 *
 * Several places need to know not "is this account mapped?" but "does mapping
 * this account to that category REDUCE taxable income?" — most importantly the
 * trade-fee rule in @/lib/trade-fees, which must not capitalize a commission
 * into cost basis when the estimator is already deducting it (one dollar, two
 * benefits), and must not withhold capitalization when it isn't (one dollar,
 * no benefit at all — the original H2 omission).
 *
 * "Mapped to anything other than 'exclude'" is NOT that predicate. A category
 * can be a tax PAYMENT (federal withholding / 1040-ES vouchers reduce the
 * balance due, never taxable income), plain INCOME, or purely INFORMATIONAL
 * (529/ESA contributions carry no federal deduction; FICA and education
 * figures are reported but never subtracted).
 *
 * ── HOW THIS TABLE WAS DERIVED ────────────────────────────────────────────
 * Not from names that sound deductible — from what buildFederalInputsFromBookData
 * (@/lib/tax/estimator-inputs) actually consumes. A category is
 * 'reduces-taxable-income' if and only if its book total flows into a
 * FederalTaxInputs field that lowers taxable income:
 *
 *   business_expense            -> selfEmploymentIncome = SE income - business_expense
 *   charitable_donation         -> charitableDonations   (itemized)
 *   mortgage_interest           -> mortgageInterest      (itemized)
 *   medical_expense             -> medicalExpenses       (itemized)
 *   other_deduction             -> otherDeductions
 *   property_tax                -> stateLocalTaxesPaid   (SALT, itemized)
 *   state_local_tax_paid        -> stateLocalTaxesPaid
 *   state_withholding           -> stateLocalTaxesPaid   (a payment AND SALT)
 *   state_estimated_tax_payment -> stateLocalTaxesPaid   (a payment AND SALT)
 *   hsa/trad_401k/trad_ira/sep_ira/simple_ira_contribution
 *                               -> the above-the-line contribution fields, via
 *                                  resolveContributionActuals (@/lib/tax/payments),
 *                                  which falls back to the category total
 *
 * Everything else is income, a payment, or informational. Note in particular
 * that FEDERAL withholding and federal estimated payments are payments only —
 * federal income tax is not deductible — while their STATE counterparts are
 * both, which is why the two halves land in different rows below.
 *
 * ── ADDING A CATEGORY ─────────────────────────────────────────────────────
 * TAX_CATEGORY_TREATMENT is a total Record over TaxCategory, so adding a value
 * to TAX_CATEGORIES fails the build here until someone states its treatment.
 * That is deliberate: a new category must not silently inherit a default in
 * either direction.
 */

import type { TaxCategory } from './types';

export type TaxCategoryTreatment =
    /** Lowers taxable income — a deduction or above-the-line adjustment. */
    | 'reduces-taxable-income'
    /** Raises taxable income (or MAGI only, for tax-exempt interest). */
    | 'increases-taxable-income'
    /** Credited against tax owed; never changes taxable income. */
    | 'tax-payment'
    /** Reported/labelled but never subtracted from anything. */
    | 'informational'
    /** Deliberately outside every tax computation. */
    | 'excluded';

export const TAX_CATEGORY_TREATMENT: Record<TaxCategory, TaxCategoryTreatment> = {
    w2_wages: 'increases-taxable-income',
    federal_withholding: 'tax-payment',
    // State taxes paid are BOTH a payment and a Schedule A deduction.
    state_withholding: 'reduces-taxable-income',
    estimated_tax_payment: 'tax-payment',
    state_estimated_tax_payment: 'reduces-taxable-income',
    // Reported for the FICA/SE reconciliation; never subtracted federally.
    fica_social_security: 'informational',
    fica_medicare: 'informational',
    interest_income: 'increases-taxable-income',
    // Excluded from taxable income, but it only ever pushes MAGI (and thus
    // Social Security taxability) UP — never a deduction.
    tax_exempt_interest: 'increases-taxable-income',
    ordinary_dividends: 'increases-taxable-income',
    qualified_dividends: 'increases-taxable-income',
    self_employment_income: 'increases-taxable-income',
    business_expense: 'reduces-taxable-income',
    rental_income: 'increases-taxable-income',
    retirement_income: 'increases-taxable-income',
    social_security_benefits: 'increases-taxable-income',
    hsa_contribution: 'reduces-taxable-income',
    trad_401k_contribution: 'reduces-taxable-income',
    // Roth money is after-tax: contributing buys no deduction.
    roth_401k_contribution: 'informational',
    trad_ira_contribution: 'reduces-taxable-income',
    roth_ira_contribution: 'informational',
    sep_ira_contribution: 'reduces-taxable-income',
    simple_ira_contribution: 'reduces-taxable-income',
    // Marks employer money for the contribution classifier only.
    employer_match: 'informational',
    // No federal deduction for 529/ESA contributions (some states differ).
    education_529_contribution: 'informational',
    esa_contribution: 'informational',
    charitable_donation: 'reduces-taxable-income',
    mortgage_interest: 'reduces-taxable-income',
    property_tax: 'reduces-taxable-income',
    state_local_tax_paid: 'reduces-taxable-income',
    medical_expense: 'reduces-taxable-income',
    // Only feeds an informational caveat in the filing comparison; no
    // education credit is computed from it.
    education_expense: 'informational',
    other_income: 'increases-taxable-income',
    other_deduction: 'reduces-taxable-income',
    exclude: 'excluded',
};

/**
 * True when a positive amount in this category LOWERS taxable income, i.e.
 * the user is already getting a deduction for it. Unknown strings (a mapping
 * row written by an older or newer build) answer false — the safe direction
 * here is to let the fee be capitalized rather than to drop it entirely.
 */
export function reducesTaxableIncome(category: string | null | undefined): boolean {
    if (!category) return false;
    return TAX_CATEGORY_TREATMENT[category as TaxCategory] === 'reduces-taxable-income';
}
