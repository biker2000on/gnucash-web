import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------
const mockAccountsFindMany = vi.fn();
const mockAccountsFindFirst = vi.fn();
const mockSplitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
      findFirst: (...args: unknown[]) => mockAccountsFindFirst(...args),
    },
    splits: {
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
    },
  },
}));

// Balance sheet valuation: identity multiplier (single-currency book)
vi.mock('../account-valuation', () => ({
  buildAccountValuationContext: vi.fn(async () => ({
    reportCurrencyGuid: 'usd',
    reportCurrencyMnemonic: 'USD',
    getMultiplier: () => 1,
  })),
}));

import { buildHierarchy, AccountWithBalance } from '../reports/utils';
import { generateBalanceSheet } from '../reports/balance-sheet';
import { generateGeneralLedger } from '../reports/general-ledger';
import { generateCashFlow } from '../reports/cash-flow';

// --- Helpers ----------------------------------------------------------------

function qsplit(amount: number) {
  return {
    quantity_num: BigInt(Math.round(amount * 100)),
    quantity_denom: 100n,
  };
}

function vsplit(amount: number, extra: Record<string, unknown> = {}) {
  return {
    value_num: BigInt(Math.round(amount * 100)),
    value_denom: 100n,
    ...extra,
  };
}

beforeEach(() => {
  mockAccountsFindMany.mockReset();
  mockAccountsFindFirst.mockReset();
  mockSplitsFindMany.mockReset();
});

// --- buildHierarchy: hidden-parent reattachment ------------------------------

describe('buildHierarchy', () => {
  it('keeps normal parent/child nesting intact', () => {
    const accounts: AccountWithBalance[] = [
      { guid: 'a', name: 'Assets', account_type: 'ASSET', parent_guid: 'root', balance: 10 },
      { guid: 'b', name: 'Checking', account_type: 'BANK', parent_guid: 'a', balance: 3 },
    ];

    const items = buildHierarchy(accounts, 'root');

    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('a');
    expect(items[0].amount).toBe(13);
    expect(items[0].children).toHaveLength(1);
    expect(items[0].children![0].guid).toBe('b');
  });

  it('re-attaches visible accounts whose parent is missing (e.g. hidden) so their balance is not lost', () => {
    const accounts: AccountWithBalance[] = [
      { guid: 'a', name: 'Assets', account_type: 'ASSET', parent_guid: 'root', balance: 10 },
      // parent 'hidden-1' was filtered out upstream (hidden: 1)
      { guid: 'orphan', name: 'Orphan Savings', account_type: 'BANK', parent_guid: 'hidden-1', balance: 5 },
      // deeper chain: visible grandchild under a hidden parent
      { guid: 'deep', name: 'Deep Account', account_type: 'BANK', parent_guid: 'hidden-2', balance: 7 },
    ];

    const items = buildHierarchy(accounts, 'root');
    const total = items.reduce((sum, item) => sum + item.amount, 0);

    expect(items.map(i => i.guid).sort()).toEqual(['a', 'deep', 'orphan']);
    expect(total).toBe(22);
  });

  it('re-attaches chains whose topmost visible ancestor has a missing parent', () => {
    const accounts: AccountWithBalance[] = [
      // 'mid' is visible but its parent is hidden; 'leaf' is under 'mid'
      { guid: 'mid', name: 'Mid', account_type: 'ASSET', parent_guid: 'hidden', balance: 1 },
      { guid: 'leaf', name: 'Leaf', account_type: 'BANK', parent_guid: 'mid', balance: 2 },
    ];

    const items = buildHierarchy(accounts, 'root');

    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('mid');
    expect(items[0].amount).toBe(3);
    expect(items[0].children![0].guid).toBe('leaf');
  });
});

// --- Balance sheet ------------------------------------------------------------

describe('generateBalanceSheet', () => {
  it('includes RECEIVABLE under assets and PAYABLE under liabilities, and sums signed totals', async () => {
    mockAccountsFindFirst.mockResolvedValue({ guid: 'root' });

    const accounts = [
      { guid: 'assets', name: 'Assets', account_type: 'ASSET', parent_guid: 'root', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      { guid: 'checking', name: 'Checking', account_type: 'BANK', parent_guid: 'assets', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      { guid: 'ar', name: 'Accounts Receivable', account_type: 'RECEIVABLE', parent_guid: 'assets', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      // visible child of a hidden parent - must still be counted
      { guid: 'orphan-bank', name: 'Orphan Bank', account_type: 'BANK', parent_guid: 'hidden-parent', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      { guid: 'liab', name: 'Liabilities', account_type: 'LIABILITY', parent_guid: 'root', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      { guid: 'cc', name: 'Credit Card', account_type: 'CREDIT', parent_guid: 'liab', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      // overpaid credit card: debit (positive) balance on a credit-normal account
      { guid: 'cc-overpaid', name: 'Overpaid Card', account_type: 'CREDIT', parent_guid: 'liab', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      { guid: 'ap', name: 'Accounts Payable', account_type: 'PAYABLE', parent_guid: 'liab', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
      { guid: 'equity', name: 'Equity', account_type: 'EQUITY', parent_guid: 'root', commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } },
    ];
    mockAccountsFindMany.mockResolvedValue(accounts);

    const splitsByAccount: Record<string, ReturnType<typeof qsplit>[]> = {
      checking: [qsplit(1000)],
      ar: [qsplit(500)],
      'orphan-bank': [qsplit(100)],
      cc: [qsplit(-200)],
      'cc-overpaid': [qsplit(50)],
      ap: [qsplit(-300)],
      equity: [qsplit(-1150)],
    };
    mockSplitsFindMany.mockImplementation(async (args: { where: { account_guid: string } }) =>
      splitsByAccount[args.where.account_guid] ?? []
    );

    const report = await generateBalanceSheet({ startDate: null, endDate: '2026-06-30' });

    const assetSection = report.sections.find(s => s.title === 'Assets')!;
    const liabilitySection = report.sections.find(s => s.title === 'Liabilities')!;
    const equitySection = report.sections.find(s => s.title === 'Equity')!;

    // RECEIVABLE counted as an asset; orphaned visible child not dropped
    expect(assetSection.total).toBeCloseTo(1600, 2); // 1000 + 500 + 100

    // PAYABLE counted as a liability; overpaid card REDUCES the total
    // (200 + 300 - 50), not Math.abs-inflated (200 + 300 + 50)
    expect(liabilitySection.total).toBeCloseTo(450, 2);

    // Equity: credit-normal signed sum displayed positive
    expect(equitySection.total).toBeCloseTo(1150, 2);

    // Balanced book: assets - liabilities - equity = 0
    expect(report.grandTotal).toBeCloseTo(0, 2);

    // The orphaned account shows up as a line item
    const flatten = (items: typeof assetSection.items): string[] =>
      items.flatMap(i => [i.guid, ...(i.children ? flatten(i.children) : [])]);
    expect(flatten(assetSection.items)).toContain('orphan-bank');
  });
});

// --- General ledger -----------------------------------------------------------

describe('generateGeneralLedger', () => {
  it('computes the opening balance with the same normal-balance convention as the running balance', async () => {
    // Same account rows serve both the ledger query and buildAccountPathMap
    mockAccountsFindMany.mockResolvedValue([
      { guid: 'salary', name: 'Salary', account_type: 'INCOME', parent_guid: null },
      { guid: 'checking', name: 'Checking', account_type: 'BANK', parent_guid: null },
    ]);

    mockSplitsFindMany.mockImplementation(
      async (args: { where: { transaction: { post_date: Record<string, unknown> } } }) => {
        const dateFilter = args.where.transaction.post_date;
        if ('lt' in dateFilter) {
          // Opening splits (before startDate), raw value sums are debit-positive:
          // income account has been credited 500 -> raw -500
          // bank account has been debited 250 -> raw +250
          return [
            { account_guid: 'salary', ...vsplit(-500) },
            { account_guid: 'checking', ...vsplit(250) },
          ];
        }
        // Period splits: one paycheck of 100 (income credited, bank debited)
        const tx = { transaction: { description: 'Paycheck', post_date: new Date('2026-03-15T12:00:00Z'), num: '' }, memo: '' };
        return [
          { account_guid: 'salary', ...vsplit(-100), ...tx },
          { account_guid: 'checking', ...vsplit(100), ...tx },
        ];
      }
    );

    const report = await generateGeneralLedger({ startDate: '2026-01-01', endDate: '2026-12-31' });

    const salary = report.accounts.find(a => a.guid === 'salary')!;
    const checking = report.accounts.find(a => a.guid === 'checking')!;

    // INCOME is credit-normal: raw -500 opening must display as +500,
    // and the period credit of 100 advances it to 600 (not -400).
    expect(salary.openingBalance).toBeCloseTo(500, 2);
    expect(salary.entries[0].runningBalance).toBeCloseTo(600, 2);
    expect(salary.closingBalance).toBeCloseTo(600, 2);

    // Debit-normal accounts are unchanged
    expect(checking.openingBalance).toBeCloseTo(250, 2);
    expect(checking.closingBalance).toBeCloseTo(350, 2);
  });
});

// --- Cash flow ----------------------------------------------------------------

describe('generateCashFlow', () => {
  it('flips line items to the same sign convention as section totals so items sum to the total', async () => {
    // Same rows serve buildAccountPathMap and the accounts query
    mockAccountsFindMany.mockResolvedValue([
      { guid: 'salary', name: 'Salary', account_type: 'INCOME', parent_guid: null },
      { guid: 'groceries', name: 'Groceries', account_type: 'EXPENSE', parent_guid: null },
      { guid: 'checking', name: 'Checking', account_type: 'BANK', parent_guid: null },
    ]);

    const splitsByAccount: Record<string, ReturnType<typeof qsplit>[]> = {
      salary: [qsplit(-1000)],   // income earned (credit) -> cash inflow of 1000
      groceries: [qsplit(300)],  // expense (debit) -> cash outflow of 300
      checking: [qsplit(700)],   // net cash change
    };
    mockSplitsFindMany.mockImplementation(async (args: { where: { account_guid: string } }) =>
      splitsByAccount[args.where.account_guid] ?? []
    );

    const report = await generateCashFlow({ startDate: '2026-01-01', endDate: '2026-12-31' });

    const operating = report.sections.find(s => s.title.includes('Operating'))!;

    // Inflows are positive on line items
    const salaryItem = operating.items.find(i => i.guid === 'salary')!;
    const groceriesItem = operating.items.find(i => i.guid === 'groceries')!;
    expect(salaryItem.amount).toBeCloseTo(1000, 2);
    expect(groceriesItem.amount).toBeCloseTo(-300, 2);

    // Items sum exactly to the section total
    const itemSum = operating.items.reduce((sum, i) => sum + i.amount, 0);
    expect(operating.total).toBeCloseTo(itemSum, 6);
    expect(operating.total).toBeCloseTo(700, 2);

    // Every section satisfies items-sum-to-total
    for (const section of report.sections) {
      const sum = section.items.reduce((s, i) => s + i.amount, 0);
      expect(section.total).toBeCloseTo(sum, 6);
    }

    // Net change in cash (grand total) matches the cash accounts' movement
    expect(report.grandTotal).toBeCloseTo(700, 2);
  });
});
