import { describe, it, expect } from 'vitest';
import {
  ENTITY_ACCOUNT_TEMPLATES,
  ENTITY_TYPE_OPTIONS,
  getEntityAccountTemplate,
  type TemplateAccountDef,
} from '../book-templates';

/** Mirrors EntityType in src/lib/services/entity.service.ts (kept inline to
 *  avoid importing the prisma-backed service module into unit tests). */
const ALL_ENTITY_TYPES = [
  'household',
  'sole_prop',
  'llc_single',
  'llc_partnership',
  's_corp',
  'c_corp',
  'nonprofit_501c3',
] as const;

/** GnuCash account types valid for template nodes (ROOT is created separately). */
const VALID_ACCOUNT_TYPES = new Set([
  'ASSET', 'BANK', 'CASH', 'CREDIT',
  'LIABILITY', 'INCOME', 'EXPENSE',
  'EQUITY', 'RECEIVABLE', 'PAYABLE',
  'STOCK', 'MUTUAL',
]);

/** Which account types are allowed under each top-level category. */
const CATEGORY_TYPES: Record<string, Set<string>> = {
  Assets: new Set(['ASSET', 'BANK', 'CASH', 'RECEIVABLE', 'STOCK', 'MUTUAL']),
  Liabilities: new Set(['LIABILITY', 'CREDIT', 'PAYABLE']),
  Income: new Set(['INCOME']),
  Expenses: new Set(['EXPENSE']),
  Equity: new Set(['EQUITY']),
};

const TOP_LEVEL = [
  { name: 'Assets', type: 'ASSET' },
  { name: 'Liabilities', type: 'LIABILITY' },
  { name: 'Income', type: 'INCOME' },
  { name: 'Expenses', type: 'EXPENSE' },
  { name: 'Equity', type: 'EQUITY' },
];

function walk(
  defs: TemplateAccountDef[],
  visit: (def: TemplateAccountDef, siblings: TemplateAccountDef[]) => void
) {
  for (const def of defs) {
    visit(def, defs);
    if (def.children) walk(def.children, visit);
  }
}

describe('ENTITY_ACCOUNT_TEMPLATES', () => {
  it('has a template for every entity type', () => {
    expect(Object.keys(ENTITY_ACCOUNT_TEMPLATES).sort()).toEqual(
      [...ALL_ENTITY_TYPES].sort()
    );
  });

  for (const entityType of ALL_ENTITY_TYPES) {
    describe(entityType, () => {
      const template = ENTITY_ACCOUNT_TEMPLATES[entityType];

      it('has exactly the 5 standard top-level accounts with correct types', () => {
        expect(template.map((a) => ({ name: a.name, type: a.type }))).toEqual(TOP_LEVEL);
      });

      it('uses only valid GnuCash account types', () => {
        walk(template, (def) => {
          expect(VALID_ACCOUNT_TYPES.has(def.type), `${entityType}: ${def.name} has invalid type ${def.type}`).toBe(true);
        });
      });

      it('has unique account names among siblings', () => {
        walk(template, (def, siblings) => {
          const dupes = siblings.filter((s) => s.name === def.name);
          expect(dupes.length, `${entityType}: duplicate sibling name "${def.name}"`).toBe(1);
        });
      });

      it('keeps every account type consistent with its top-level category', () => {
        for (const top of template) {
          const allowed = CATEGORY_TYPES[top.name];
          walk(top.children ?? [], (def) => {
            expect(
              allowed.has(def.type),
              `${entityType}: ${top.name} > ${def.name} has type ${def.type} not allowed under ${top.name}`
            ).toBe(true);
          });
        }
      });

      it('has non-empty names throughout', () => {
        walk(template, (def) => {
          expect(def.name.trim().length).toBeGreaterThan(0);
        });
      });
    });
  }

  it('gives each top-level account at least one child', () => {
    for (const entityType of ALL_ENTITY_TYPES) {
      for (const top of ENTITY_ACCOUNT_TEMPLATES[entityType]) {
        expect(
          top.children?.length ?? 0,
          `${entityType}: ${top.name} has no children`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('entity-specific structure', () => {
  it('household matches the original default hierarchy shape', () => {
    const template = ENTITY_ACCOUNT_TEMPLATES.household;
    const assets = template.find((a) => a.name === 'Assets')!;
    expect(assets.children!.map((c) => c.name)).toEqual(['Current Assets', 'Investments']);
    const equity = template.find((a) => a.name === 'Equity')!;
    expect(equity.children!.map((c) => c.name)).toEqual(['Opening Balances']);
  });

  it('sole_prop and llc_single share the owner-equity business template', () => {
    for (const entityType of ['sole_prop', 'llc_single'] as const) {
      const template = ENTITY_ACCOUNT_TEMPLATES[entityType];
      const assets = template.find((a) => a.name === 'Assets')!;
      expect(assets.children!.find((c) => c.name === 'Accounts Receivable')?.type).toBe('RECEIVABLE');
      const liabilities = template.find((a) => a.name === 'Liabilities')!;
      expect(liabilities.children!.find((c) => c.name === 'Accounts Payable')?.type).toBe('PAYABLE');
      const equity = template.find((a) => a.name === 'Equity')!;
      expect(equity.children!.map((c) => c.name)).toEqual([
        'Opening Balances',
        "Owner's Contributions",
        "Owner's Draw",
      ]);
      const taxes = template
        .find((a) => a.name === 'Expenses')!
        .children!.find((c) => c.name === 'Taxes');
      expect(taxes?.children?.map((c) => c.name)).toEqual(['Self-Employment Tax']);
    }
  });

  it('llc_partnership has per-partner capital accounts with contributions and draws', () => {
    const equity = ENTITY_ACCOUNT_TEMPLATES.llc_partnership.find((a) => a.name === 'Equity')!;
    for (const partner of ['Partner 1 Capital', 'Partner 2 Capital']) {
      const capital = equity.children!.find((c) => c.name === partner);
      expect(capital, `missing ${partner}`).toBeDefined();
      expect(capital!.children!.map((c) => c.name)).toEqual(['Contributions', 'Draws']);
    }
  });

  it('s_corp and c_corp have payroll liabilities, payroll expenses, and shareholder equity', () => {
    for (const entityType of ['s_corp', 'c_corp'] as const) {
      const template = ENTITY_ACCOUNT_TEMPLATES[entityType];
      const payrollLiab = template
        .find((a) => a.name === 'Liabilities')!
        .children!.find((c) => c.name === 'Payroll');
      expect(payrollLiab?.children?.map((c) => c.name)).toEqual([
        'Federal Withholding',
        'State Withholding',
        'FICA Payable',
      ]);
      const payrollExp = template
        .find((a) => a.name === 'Expenses')!
        .children!.find((c) => c.name === 'Payroll');
      expect(payrollExp?.children?.map((c) => c.name)).toEqual([
        'Officer Wages',
        'Staff Wages',
        'Employer FICA',
        'Employer 401k Match',
      ]);
      const equity = template.find((a) => a.name === 'Equity')!;
      expect(equity.children!.map((c) => c.name)).toEqual([
        'Opening Balances',
        'Capital Stock',
        'Retained Earnings',
        'Shareholder Distributions',
      ]);
    }
  });

  it('nonprofit_501c3 has functional expense classes and net-asset equity', () => {
    const template = ENTITY_ACCOUNT_TEMPLATES.nonprofit_501c3;
    const income = template.find((a) => a.name === 'Income')!;
    expect(income.children!.map((c) => c.name)).toEqual([
      'Donations',
      'Grants',
      'Program Service Fees',
      'Membership Dues',
      'Investment Income',
    ]);
    const expenses = template.find((a) => a.name === 'Expenses')!;
    expect(expenses.children!.map((c) => c.name)).toEqual([
      'Program Services',
      'Management & General',
      'Fundraising',
    ]);
    for (const group of expenses.children!) {
      expect(group.children!.length).toBeGreaterThan(0);
    }
    const equity = template.find((a) => a.name === 'Equity')!;
    expect(equity.children!.map((c) => c.name)).toEqual([
      'Net Assets Without Donor Restrictions',
      'Net Assets With Donor Restrictions',
      'Opening Balances',
    ]);
  });
});

describe('ENTITY_TYPE_OPTIONS', () => {
  it('covers every entity type exactly once with labels and descriptions', () => {
    expect(ENTITY_TYPE_OPTIONS.map((o) => o.value).sort()).toEqual(
      [...ALL_ENTITY_TYPES].sort()
    );
    for (const option of ENTITY_TYPE_OPTIONS) {
      expect(option.label.trim().length).toBeGreaterThan(0);
      expect(option.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('getEntityAccountTemplate', () => {
  it('returns the matching template for each entity type', () => {
    for (const entityType of ALL_ENTITY_TYPES) {
      expect(getEntityAccountTemplate(entityType)).toBe(ENTITY_ACCOUNT_TEMPLATES[entityType]);
    }
  });
});
