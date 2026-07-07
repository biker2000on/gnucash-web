/**
 * Tax Estimator — shared types.
 *
 * All tax-category, filing-status, and estimate-breakdown types used by
 * the federal engine, state modules, book aggregation, and the UI.
 */

/** Account → tax category mapping values stored in gnucash_web_tax_mappings */
export const TAX_CATEGORIES = [
  'w2_wages',
  'federal_withholding',
  'state_withholding',
  // Quarterly 1040-ES / state voucher payments made from the book
  // (EXPENSE or ASSET-outflow accounts) — counted as taxes paid alongside
  // withholding when projecting the balance due / refund.
  'estimated_tax_payment',
  'state_estimated_tax_payment',
  'fica_social_security',
  'fica_medicare',
  'interest_income',
  // 1040 line 2a — muni-bond interest. Excluded from taxable income/AGI but
  // included in MAGI for Social Security taxability (IRS Pub 915).
  'tax_exempt_interest',
  'ordinary_dividends',
  'qualified_dividends',
  'self_employment_income',
  'business_expense',
  'rental_income',
  'retirement_income',
  'social_security_benefits',
  'hsa_contribution',
  'trad_401k_contribution',
  'roth_401k_contribution',
  'trad_ira_contribution',
  'roth_ira_contribution',
  'sep_ira_contribution',
  'simple_ira_contribution',
  // Marks INCOME accounts whose flows into retirement accounts are employer
  // money (match / profit sharing). The contribution report always classifies
  // money arriving from these accounts as EMPLOYER_MATCH, regardless of
  // account naming — a durable user override for books where the match is
  // booked from e.g. 'Salary' or 'non-taxable' income accounts.
  'employer_match',
  'education_529_contribution',
  'esa_contribution',
  'charitable_donation',
  'mortgage_interest',
  'property_tax',
  'state_local_tax_paid',
  'medical_expense',
  'education_expense',
  'other_income',
  'other_deduction',
  'exclude',
] as const;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export function isTaxCategory(value: string): value is TaxCategory {
  return (TAX_CATEGORIES as readonly string[]).includes(value);
}

/** Human-readable labels for each category */
export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  w2_wages: 'W-2 Wages',
  federal_withholding: 'Federal Withholding',
  state_withholding: 'State Withholding',
  estimated_tax_payment: 'Federal Estimated Tax Payment',
  state_estimated_tax_payment: 'State Estimated Tax Payment',
  fica_social_security: 'FICA Social Security',
  fica_medicare: 'FICA Medicare',
  interest_income: 'Interest Income',
  tax_exempt_interest: 'Tax-Exempt Interest (muni)',
  ordinary_dividends: 'Ordinary Dividends',
  qualified_dividends: 'Qualified Dividends',
  self_employment_income: 'Self-Employment Income',
  business_expense: 'Business Expense',
  rental_income: 'Rental Income',
  retirement_income: 'Retirement Income',
  social_security_benefits: 'Social Security Benefits',
  hsa_contribution: 'HSA Contribution',
  trad_401k_contribution: 'Traditional 401(k) Contribution',
  roth_401k_contribution: 'Roth 401(k) Contribution',
  trad_ira_contribution: 'Traditional IRA Contribution',
  roth_ira_contribution: 'Roth IRA Contribution',
  sep_ira_contribution: 'SEP IRA Contribution',
  simple_ira_contribution: 'SIMPLE IRA Contribution',
  employer_match: 'Employer Match (income)',
  education_529_contribution: '529 Plan Contribution',
  esa_contribution: 'Coverdell ESA Contribution',
  charitable_donation: 'Charitable Donation',
  mortgage_interest: 'Mortgage Interest',
  property_tax: 'Property Tax',
  state_local_tax_paid: 'State/Local Tax Paid',
  medical_expense: 'Medical Expense',
  education_expense: 'Education Expense',
  other_income: 'Other Income',
  other_deduction: 'Other Deduction',
  exclude: 'Excluded',
};

/** Grouping used by the mapper UI */
export const TAX_CATEGORY_GROUPS: Array<{ label: string; categories: TaxCategory[] }> = [
  {
    label: 'Income',
    categories: [
      'w2_wages', 'interest_income', 'tax_exempt_interest', 'ordinary_dividends',
      'qualified_dividends', 'self_employment_income', 'rental_income',
      'retirement_income', 'social_security_benefits', 'other_income',
    ],
  },
  {
    label: 'Taxes Withheld / Paid',
    categories: [
      'federal_withholding', 'state_withholding', 'estimated_tax_payment',
      'state_estimated_tax_payment', 'fica_social_security',
      'fica_medicare', 'state_local_tax_paid', 'property_tax',
    ],
  },
  {
    label: 'Pre-Tax Contributions',
    categories: [
      'trad_401k_contribution', 'roth_401k_contribution', 'trad_ira_contribution',
      'roth_ira_contribution', 'sep_ira_contribution', 'simple_ira_contribution',
      'hsa_contribution', 'employer_match',
    ],
  },
  {
    label: 'Deductions',
    categories: [
      'charitable_donation', 'mortgage_interest', 'medical_expense',
      'education_expense', 'business_expense', 'other_deduction',
    ],
  },
  {
    // 529 and Coverdell ESA contributions have NO federal deduction — they
    // are informational (some states offer a state-level deduction/credit).
    // They must NOT feed federal AGI adjustments.
    label: 'Education Savings',
    categories: ['education_529_contribution', 'esa_contribution'],
  },
  { label: 'Other', categories: ['exclude'] },
];

/* ------------------------------------------------------------------ */
/* Filing status / years                                               */
/* ------------------------------------------------------------------ */

export const FILING_STATUSES = ['single', 'mfj', 'mfs', 'hoh', 'qss'] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: 'Single',
  mfj: 'Married Filing Jointly',
  mfs: 'Married Filing Separately',
  hoh: 'Head of Household',
  qss: 'Qualifying Surviving Spouse',
};

export const SUPPORTED_TAX_YEARS = [2024, 2025, 2026] as const;
export type TaxYear = (typeof SUPPORTED_TAX_YEARS)[number];

export function isSupportedTaxYear(year: number): year is TaxYear {
  return (SUPPORTED_TAX_YEARS as readonly number[]).includes(year);
}

/* ------------------------------------------------------------------ */
/* Federal engine inputs / outputs                                     */
/* ------------------------------------------------------------------ */

export interface FederalTaxInputs {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** Gross W-2 wages (before pre-tax 401k/HSA payroll deferrals) */
  wages: number;
  /** Taxable interest */
  interest: number;
  /**
   * Tax-exempt interest (muni bonds, 1040 line 2a). NOT part of taxable
   * income or AGI, but included in provisional income when computing the
   * taxable portion of Social Security benefits (IRS Pub 915).
   * Optional, defaults to 0.
   */
  taxExemptInterest?: number;
  /** Total ordinary dividends (INCLUDES qualified dividends) */
  ordinaryDividends: number;
  /** Qualified dividends (subset of ordinaryDividends) */
  qualifiedDividends: number;
  /** Net short-term capital gain (may be negative) */
  shortTermCapitalGains: number;
  /** Net long-term capital gain (may be negative) */
  longTermCapitalGains: number;
  /** Net self-employment profit (Schedule C net) */
  selfEmploymentIncome: number;
  /** Net rental income */
  rentalIncome: number;
  /** Taxable retirement distributions (pensions, IRA/401k withdrawals) */
  retirementIncome: number;
  /** Gross Social Security benefits received */
  socialSecurityBenefits: number;
  /** Other taxable income */
  otherIncome: number;

  /** Pre-tax adjustments */
  traditional401kContributions: number;
  traditionalIraContributions: number;
  hsaContributions: number;
  /** SEP IRA contributions (self-employed employer contribution) — optional, defaults to 0 */
  sepIraContributions?: number;
  /** SIMPLE IRA elective deferrals — optional, defaults to 0 */
  simpleIraContributions?: number;
  /** Qualifying children under 17 at year end (Child Tax Credit) — optional, defaults to 0 */
  qualifyingChildrenUnder17?: number;

  /** Itemized deduction components */
  charitableDonations: number;
  mortgageInterest: number;
  /** State+local income tax paid + property tax (pre-cap) */
  stateLocalTaxesPaid: number;
  /** Total medical expenses (engine applies the 7.5% AGI floor) */
  medicalExpenses: number;
  otherDeductions: number;

  /** Number of taxpayers on the return who are 65 or older (0, 1, or 2) */
  filersAge65Plus: number;

  /**
   * Typed extension point for OBBBA provisions not implemented in v1
   * (tip income deduction, overtime deduction). Reserved — currently unused.
   */
  obbbaExtensions?: {
    tipIncomeDeduction?: number;
    overtimeDeduction?: number;
  };
}

export interface BracketFill {
  rate: number;        // e.g. 0.22
  bracketStart: number;
  bracketEnd: number | null; // null = top bracket
  amountInBracket: number;
  taxInBracket: number;
}

export interface CapitalGainsBracketFill {
  rate: number;        // 0, 0.15, 0.20
  amountInBracket: number;
  taxInBracket: number;
}

export interface FederalTaxResult {
  year: TaxYear;
  filingStatus: FilingStatus;

  totalIncome: number;
  adjustments: number;
  /** Deduction for half of SE tax (included in adjustments) */
  halfSeTaxDeduction: number;
  agi: number;
  /** Taxable portion of Social Security benefits (included in AGI) */
  taxableSocialSecurity: number;

  standardDeduction: number;
  itemizedDeduction: number;
  itemizedBreakdown: {
    saltAllowed: number;
    saltCap: number;
    mortgageInterest: number;
    charitable: number;
    medicalAllowed: number;
    other: number;
  };
  usedItemized: boolean;
  deductionTaken: number;
  /** OBBBA senior deduction (2025+), after phase-out */
  seniorDeduction: number;

  taxableIncome: number;
  ordinaryTaxableIncome: number;
  /** Net capital gain + qualified dividends taxed at preferential rates */
  preferentialIncome: number;

  ordinaryTax: number;
  capitalGainsTax: number;
  selfEmploymentTax: number;
  niit: number;
  additionalMedicareTax: number;
  /** Placeholder for credits (child tax credit etc.) — always 0 in v1 */
  credits: number;
  totalTax: number;

  marginalRate: number;
  effectiveRate: number; // totalTax / AGI (0 if AGI <= 0)

  ordinaryBracketFills: BracketFill[];
  capitalGainsBracketFills: CapitalGainsBracketFill[];
}

/* ------------------------------------------------------------------ */
/* Safe harbor / estimated payments                                    */
/* ------------------------------------------------------------------ */

export interface SafeHarborInputs {
  year: TaxYear;
  filingStatus: FilingStatus;
  currentYearTax: number;
  priorYearTax: number | null;
  priorYearAgi: number | null;
  /** Total expected withholding for the year */
  withholding: number;
}

export interface QuarterlyPayment {
  quarter: 1 | 2 | 3 | 4;
  dueDate: string; // YYYY-MM-DD
  amount: number;
}

export interface SafeHarborResult {
  ninetyPercentCurrent: number;
  priorYearSafeHarbor: number | null;
  /** 1.0 or 1.1 */
  priorYearMultiplier: number | null;
  /** The smallest amount that must be paid through withholding+estimates */
  requiredAnnualPayment: number;
  withholding: number;
  /** requiredAnnualPayment - withholding, floored at 0 */
  estimatedPaymentsNeeded: number;
  /** True when balance due after withholding < $1,000 (no penalty regardless) */
  underThousandDollarRule: boolean;
  quarterlySchedule: QuarterlyPayment[];
}

/* ------------------------------------------------------------------ */
/* State engine                                                        */
/* ------------------------------------------------------------------ */

export interface StateTaxInputs {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** Federal AGI is the typical state starting point */
  federalAgi: number;
  /** Optional flat-rate override (decimal, e.g. 0.05) for the generic module */
  flatRateOverride?: number;
}

export interface StateTaxResult {
  stateCode: string;
  stateName: string;
  method: 'none' | 'flat' | 'brackets' | 'flat_override';
  taxableIncome: number;
  tax: number;
  effectiveRate: number;
  marginalRate: number;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Book aggregation / API payloads                                     */
/* ------------------------------------------------------------------ */

export interface MappedAccountAmount {
  accountGuid: string;
  accountName: string;
  accountPath: string;
  amount: number;
}

export interface CategoryAggregate {
  category: TaxCategory;
  total: number;
  accounts: MappedAccountAmount[];
}

export interface BookTaxData {
  year: number;
  startDate: string;
  endDate: string;
  asOfDate: string;
  /** Fraction of the tax year elapsed as of asOfDate (1 for past years) */
  elapsedYearFraction: number;
  categories: CategoryAggregate[];
  realizedGains: {
    shortTerm: number;
    longTerm: number;
    accounts: Array<{
      accountGuid: string;
      accountName: string;
      accountPath: string;
      shortTerm: number;
      longTerm: number;
    }>;
    /**
     * Number of non-retirement STOCK/MUTUAL accounts skipped from the
     * realized-gains sweep because their effective tax mapping (direct or
     * inherited from an ancestor) is 'exclude' — i.e. accounts the user
     * marked non-taxable. Optional/additive for the UI to surface later.
     */
    excludedAccountCount?: number;
  };
  /** Employee retirement contributions by account type from contribution summary */
  contributionsByType: Record<string, number>;
  /**
   * Same contributions split by account owner ('self' | 'spouse') from the
   * gnucash_web_account_preferences.owner column. Accounts without an owner
   * (or when the column doesn't exist yet) are attributed to 'self'.
   */
  contributionsByTypeAndOwner?: Record<string, { self: number; spouse: number }>;
  mappedAccountCount: number;
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export const SCENARIO_CONTRIBUTION_FIELDS = [
  'trad401k', 'roth401k', 'tradIra', 'rothIra', 'hsa',
] as const;
export type ScenarioContributionField = (typeof SCENARIO_CONTRIBUTION_FIELDS)[number];

export const SCENARIO_FIELD_LABELS: Record<ScenarioContributionField, string> = {
  trad401k: 'Traditional 401(k)',
  roth401k: 'Roth 401(k)',
  tradIra: 'Traditional IRA',
  rothIra: 'Roth IRA',
  hsa: 'HSA',
};

export interface ContributionScenario {
  name: string;
  /** Additional contributions ON TOP of current actuals */
  additional: Record<ScenarioContributionField, number>;
}

export interface ScenarioValidationIssue {
  field: ScenarioContributionField;
  message: string;
  /** Remaining IRS headroom for this field */
  remaining: number;
  requested: number;
}

export interface ScenarioResult {
  name: string;
  valid: boolean;
  issues: ScenarioValidationIssue[];
  federal: FederalTaxResult;
  stateTax: number;
  totalLiability: number;
  baselineLiability: number;
  taxSaved: number;
  marginalRate: number;
  effectiveRate: number;
  /** Change in take-home cash: taxSaved − total additional out-of-pocket contributions */
  takeHomeChange: number;
  totalAdditional: number;
}
