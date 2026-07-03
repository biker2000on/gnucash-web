/**
 * Entity-Aware Book Templates
 *
 * Account hierarchy templates keyed by entity type (household, sole
 * proprietorship, LLC, S-Corp, C-Corp, 501(c)(3) nonprofit). Each template
 * follows GnuCash conventions: five top-level accounts (Assets, Liabilities,
 * Income, Expenses, Equity) with the correct account_type per node.
 *
 * Consumed by createDefaultBook() (src/lib/default-book.ts) to seed a new
 * book, and by the book-creation UI to render the entity type picker.
 * This module is safe to import from client components (type-only import
 * of EntityType; no server dependencies).
 */

import type { EntityType } from '@/lib/services/entity.service';

export interface TemplateAccountDef {
  name: string;
  type: string;
  children?: TemplateAccountDef[];
}

export interface EntityTypeOption {
  value: EntityType;
  label: string;
  description: string;
}

/** Display metadata for the entity type picker, in recommended display order. */
export const ENTITY_TYPE_OPTIONS: EntityTypeOption[] = [
  {
    value: 'household',
    label: 'Household',
    description: 'Personal & family finances',
  },
  {
    value: 'sole_prop',
    label: 'Sole Proprietorship',
    description: 'Unincorporated business owned by one person',
  },
  {
    value: 'llc_single',
    label: 'Single-Member LLC',
    description: 'Limited liability company with one owner',
  },
  {
    value: 'llc_partnership',
    label: 'Partnership LLC',
    description: 'Multi-member LLC taxed as a partnership',
  },
  {
    value: 's_corp',
    label: 'S-Corp',
    description: 'Corporation with pass-through taxation and payroll',
  },
  {
    value: 'c_corp',
    label: 'C-Corp',
    description: 'Corporation taxed at the entity level',
  },
  {
    value: 'nonprofit_501c3',
    label: '501(c)(3) Nonprofit',
    description: 'Tax-exempt organization with fund-based equity',
  },
];

// ---------------------------------------------------------------------------
// Household (the original default hierarchy, unchanged)
// ---------------------------------------------------------------------------

const HOUSEHOLD_TEMPLATE: TemplateAccountDef[] = [
  {
    name: 'Assets',
    type: 'ASSET',
    children: [
      {
        name: 'Current Assets',
        type: 'ASSET',
        children: [
          { name: 'Checking Account', type: 'BANK' },
          { name: 'Savings Account', type: 'BANK' },
          { name: 'Cash in Wallet', type: 'CASH' },
        ],
      },
      {
        name: 'Investments',
        type: 'ASSET',
        children: [
          { name: 'Brokerage Account', type: 'ASSET' },
        ],
      },
    ],
  },
  {
    name: 'Liabilities',
    type: 'LIABILITY',
    children: [
      { name: 'Credit Card', type: 'CREDIT' },
      { name: 'Mortgage', type: 'LIABILITY' },
    ],
  },
  {
    name: 'Income',
    type: 'INCOME',
    children: [
      { name: 'Salary', type: 'INCOME' },
      { name: 'Interest Income', type: 'INCOME' },
      { name: 'Other Income', type: 'INCOME' },
    ],
  },
  {
    name: 'Expenses',
    type: 'EXPENSE',
    children: [
      { name: 'Groceries', type: 'EXPENSE' },
      { name: 'Utilities', type: 'EXPENSE' },
      { name: 'Rent/Mortgage', type: 'EXPENSE' },
      { name: 'Transportation', type: 'EXPENSE' },
      { name: 'Entertainment', type: 'EXPENSE' },
      { name: 'Healthcare', type: 'EXPENSE' },
      { name: 'Insurance', type: 'EXPENSE' },
      { name: 'Dining Out', type: 'EXPENSE' },
      { name: 'Clothing', type: 'EXPENSE' },
      { name: 'Taxes', type: 'EXPENSE', children: [
        { name: 'Federal Tax', type: 'EXPENSE' },
        { name: 'State Tax', type: 'EXPENSE' },
        { name: 'Social Security', type: 'EXPENSE' },
        { name: 'Medicare', type: 'EXPENSE' },
      ]},
      { name: 'Miscellaneous', type: 'EXPENSE' },
    ],
  },
  {
    name: 'Equity',
    type: 'EQUITY',
    children: [
      { name: 'Opening Balances', type: 'EQUITY' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Shared business building blocks
// ---------------------------------------------------------------------------

function businessAssets(): TemplateAccountDef {
  return {
    name: 'Assets',
    type: 'ASSET',
    children: [
      { name: 'Checking', type: 'BANK' },
      { name: 'Savings', type: 'BANK' },
      { name: 'Accounts Receivable', type: 'RECEIVABLE' },
      { name: 'Equipment', type: 'ASSET' },
    ],
  };
}

function businessLiabilities(extra: TemplateAccountDef[] = []): TemplateAccountDef {
  return {
    name: 'Liabilities',
    type: 'LIABILITY',
    children: [
      { name: 'Credit Card', type: 'CREDIT' },
      { name: 'Accounts Payable', type: 'PAYABLE' },
      { name: 'Loans', type: 'LIABILITY' },
      ...extra,
    ],
  };
}

/** Core operating expenses shared by all business entity types. */
function businessOperatingExpenses(): TemplateAccountDef[] {
  return [
    { name: 'Advertising', type: 'EXPENSE' },
    { name: 'Bank Fees', type: 'EXPENSE' },
    { name: 'Contractors', type: 'EXPENSE' },
    { name: 'Insurance', type: 'EXPENSE' },
    { name: 'Office Supplies', type: 'EXPENSE' },
    { name: 'Professional Fees', type: 'EXPENSE' },
    { name: 'Rent', type: 'EXPENSE' },
    { name: 'Software & Subscriptions', type: 'EXPENSE' },
    { name: 'Travel', type: 'EXPENSE' },
    { name: 'Utilities', type: 'EXPENSE' },
  ];
}

// ---------------------------------------------------------------------------
// Sole proprietorship / single-member LLC
// ---------------------------------------------------------------------------

function soleProprietorTemplate(): TemplateAccountDef[] {
  return [
    businessAssets(),
    businessLiabilities(),
    {
      name: 'Income',
      type: 'INCOME',
      children: [
        { name: 'Sales', type: 'INCOME' },
        { name: 'Service Income', type: 'INCOME' },
        { name: 'Other Income', type: 'INCOME' },
      ],
    },
    {
      name: 'Expenses',
      type: 'EXPENSE',
      children: [
        ...businessOperatingExpenses(),
        { name: 'Taxes', type: 'EXPENSE', children: [
          { name: 'Self-Employment Tax', type: 'EXPENSE' },
        ]},
      ],
    },
    {
      name: 'Equity',
      type: 'EQUITY',
      children: [
        { name: 'Opening Balances', type: 'EQUITY' },
        { name: "Owner's Contributions", type: 'EQUITY' },
        { name: "Owner's Draw", type: 'EQUITY' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Partnership LLC (sole-prop structure with per-partner capital accounts)
// ---------------------------------------------------------------------------

function partnershipTemplate(): TemplateAccountDef[] {
  const template = soleProprietorTemplate();
  const equity = template.find((a) => a.name === 'Equity')!;
  equity.children = [
    { name: 'Opening Balances', type: 'EQUITY' },
    {
      name: 'Partner 1 Capital',
      type: 'EQUITY',
      children: [
        { name: 'Contributions', type: 'EQUITY' },
        { name: 'Draws', type: 'EQUITY' },
      ],
    },
    {
      name: 'Partner 2 Capital',
      type: 'EQUITY',
      children: [
        { name: 'Contributions', type: 'EQUITY' },
        { name: 'Draws', type: 'EQUITY' },
      ],
    },
  ];
  return template;
}

// ---------------------------------------------------------------------------
// S-Corp / C-Corp (payroll liabilities and expenses, shareholder equity)
// ---------------------------------------------------------------------------

function corporationTemplate(): TemplateAccountDef[] {
  return [
    businessAssets(),
    businessLiabilities([
      {
        name: 'Payroll',
        type: 'LIABILITY',
        children: [
          { name: 'Federal Withholding', type: 'LIABILITY' },
          { name: 'State Withholding', type: 'LIABILITY' },
          { name: 'FICA Payable', type: 'LIABILITY' },
        ],
      },
    ]),
    {
      name: 'Income',
      type: 'INCOME',
      children: [
        { name: 'Sales', type: 'INCOME' },
        { name: 'Service Income', type: 'INCOME' },
      ],
    },
    {
      name: 'Expenses',
      type: 'EXPENSE',
      children: [
        ...businessOperatingExpenses(),
        {
          name: 'Payroll',
          type: 'EXPENSE',
          children: [
            { name: 'Officer Wages', type: 'EXPENSE' },
            { name: 'Staff Wages', type: 'EXPENSE' },
            { name: 'Employer FICA', type: 'EXPENSE' },
            { name: 'Employer 401k Match', type: 'EXPENSE' },
          ],
        },
      ],
    },
    {
      name: 'Equity',
      type: 'EQUITY',
      children: [
        { name: 'Opening Balances', type: 'EQUITY' },
        { name: 'Capital Stock', type: 'EQUITY' },
        { name: 'Retained Earnings', type: 'EQUITY' },
        { name: 'Shareholder Distributions', type: 'EQUITY' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 501(c)(3) nonprofit (functional expense classes, net-asset equity)
// ---------------------------------------------------------------------------

function nonprofitTemplate(): TemplateAccountDef[] {
  return [
    businessAssets(),
    businessLiabilities(),
    {
      name: 'Income',
      type: 'INCOME',
      children: [
        { name: 'Donations', type: 'INCOME' },
        { name: 'Grants', type: 'INCOME' },
        { name: 'Program Service Fees', type: 'INCOME' },
        { name: 'Membership Dues', type: 'INCOME' },
        { name: 'Investment Income', type: 'INCOME' },
      ],
    },
    {
      name: 'Expenses',
      type: 'EXPENSE',
      children: [
        {
          name: 'Program Services',
          type: 'EXPENSE',
          children: [
            { name: 'Salaries', type: 'EXPENSE' },
            { name: 'Supplies', type: 'EXPENSE' },
            { name: 'Travel', type: 'EXPENSE' },
          ],
        },
        {
          name: 'Management & General',
          type: 'EXPENSE',
          children: [
            { name: 'Salaries', type: 'EXPENSE' },
            { name: 'Office Supplies', type: 'EXPENSE' },
            { name: 'Professional Fees', type: 'EXPENSE' },
          ],
        },
        {
          name: 'Fundraising',
          type: 'EXPENSE',
          children: [
            { name: 'Salaries', type: 'EXPENSE' },
            { name: 'Events', type: 'EXPENSE' },
            { name: 'Printing & Postage', type: 'EXPENSE' },
          ],
        },
      ],
    },
    {
      name: 'Equity',
      type: 'EQUITY',
      children: [
        { name: 'Net Assets Without Donor Restrictions', type: 'EQUITY' },
        { name: 'Net Assets With Donor Restrictions', type: 'EQUITY' },
        { name: 'Opening Balances', type: 'EQUITY' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ENTITY_ACCOUNT_TEMPLATES: Record<EntityType, TemplateAccountDef[]> = {
  household: HOUSEHOLD_TEMPLATE,
  sole_prop: soleProprietorTemplate(),
  llc_single: soleProprietorTemplate(),
  llc_partnership: partnershipTemplate(),
  s_corp: corporationTemplate(),
  c_corp: corporationTemplate(),
  nonprofit_501c3: nonprofitTemplate(),
};

/**
 * Returns the account template for an entity type, falling back to the
 * household hierarchy for unknown values.
 */
export function getEntityAccountTemplate(entityType: EntityType): TemplateAccountDef[] {
  return ENTITY_ACCOUNT_TEMPLATES[entityType] ?? HOUSEHOLD_TEMPLATE;
}
