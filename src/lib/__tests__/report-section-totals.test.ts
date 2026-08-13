/**
 * Cross-report invariant: every section's TOP-LEVEL items must sum to that
 * section's stated total, and a parent's amount must agree in sign with its
 * own children.
 *
 * ReportTable renders top-level rows expanded, so a section whose children and
 * total disagree in sign puts a -$45,000 Salary row underneath a +$50,000
 * Income total. All three of these reports shipped that way:
 *   - income-statement negated only the top-level item, not `children`
 *   - balance-sheet negated only the section TOTAL, not the items
 *   - account-summary dropped RECEIVABLE / PAYABLE accounts entirely
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockAccountsFindFirst = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...a: unknown[]) => mockAccountsFindMany(...a),
      findFirst: (...a: unknown[]) => mockAccountsFindFirst(...a),
    },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}));

// Single-currency book: identity multiplier. Only the context builder is
// faked; the rest of the module (coverage helpers etc.) stays real so new
// exports the reports call don't silently vanish from the mock.
vi.mock('../account-valuation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-valuation')>();
  return {
    ...actual,
    buildAccountValuationContext: vi.fn(async () => ({
      reportCurrencyGuid: 'usd',
      reportCurrencyMnemonic: 'USD',
      getMultiplier: () => 1,
    })),
  };
});

import { generateIncomeStatement } from '../reports/income-statement';
import { generateBalanceSheet } from '../reports/balance-sheet';
import { generateAccountSummary } from '../reports/account-summary';
import { generateTrialBalance } from '../reports/trial-balance';
import type { LineItem, ReportFilters, ReportSection } from '../reports/types';

const ROOT = 'root';

/** Minimal filters: whole of 2024. */
const FILTERS: ReportFilters = { startDate: '2024-01-01', endDate: '2024-12-31' };

function acct(guid: string, name: string, type: string, parent: string | null = ROOT) {
  return { guid, name, account_type: type, parent_guid: parent, commodity_guid: 'usd', commodity: { namespace: 'CURRENCY' } };
}

/** Row shape returned by sumSplitsByAccount's GROUP BY query. */
function sumRow(guid: string, quantity: number, value = quantity) {
  return { account_guid: guid, quantity_sum: quantity, value_sum: value };
}

/** Row shape returned by account-summary's opening/closing GROUP BY query. */
function openCloseRow(guid: string, opening: number, closing: number) {
  return { account_guid: guid, opening_sum: opening, closing_sum: closing };
}

/** Route $queryRaw by inspecting the SQL text of the tagged template. */
function routeQueryRaw(handlers: { openClose?: unknown[]; sums?: unknown[] }) {
  mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
    if (sql.includes('opening_sum')) return Promise.resolve(handlers.openClose ?? []);
    return Promise.resolve(handlers.sums ?? []);
  });
}

/** Recursively assert each parent's amount equals own + children (sign-consistent). */
function assertChildrenAgreeWithParent(items: LineItem[]) {
  for (const item of items) {
    if (item.children && item.children.length > 0) {
      const childSum = item.children.reduce((s, c) => s + c.amount, 0);
      // Every child must point the same way as the parent it rolls into.
      for (const child of item.children) {
        expect(Math.sign(child.amount) === 0 || Math.sign(child.amount) === Math.sign(item.amount)).toBe(true);
      }
      expect(Math.abs(item.amount)).toBeGreaterThanOrEqual(Math.abs(childSum) - 1e-9);
      assertChildrenAgreeWithParent(item.children);
    }
  }
}

function assertSectionAddsUp(section: ReportSection) {
  const sum = section.items.reduce((s, i) => s + i.amount, 0);
  expect(sum).toBeCloseTo(section.total ?? 0, 6);
  assertChildrenAgreeWithParent(section.items);
}

beforeEach(() => {
  mockAccountsFindMany.mockReset();
  mockAccountsFindFirst.mockReset().mockResolvedValue({ guid: ROOT });
  mockQueryRaw.mockReset();
});

/* ------------------------------------------------------------------ */
/* Income Statement                                                    */
/* ------------------------------------------------------------------ */

describe('income statement sections add up', () => {
  beforeEach(() => {
    mockAccountsFindMany.mockResolvedValue([
      acct('inc-top', 'Income', 'INCOME'),
      acct('inc-salary', 'Salary', 'INCOME', 'inc-top'),
      acct('exp-top', 'Expenses', 'EXPENSE'),
      acct('exp-rent', 'Rent', 'EXPENSE', 'exp-top'),
    ]);
    // GnuCash stores income as NEGATIVE (credit).
    routeQueryRaw({
      sums: [
        sumRow('inc-salary', -50_000),
        sumRow('exp-rent', 20_000),
      ],
    });
  });

  it('each section total equals the sum of its top-level items', async () => {
    const report = await generateIncomeStatement(FILTERS);
    for (const section of report.sections) assertSectionAddsUp(section);
  });

  it('the Salary CHILD is positive under a positive Income total', async () => {
    const report = await generateIncomeStatement(FILTERS);
    const income = report.sections.find(s => s.title === 'Income')!;
    expect(income.total).toBeCloseTo(50_000, 6);

    const incomeTop = income.items[0];
    expect(incomeTop.amount).toBeCloseTo(50_000, 6);
    const salary = incomeTop.children![0];
    expect(salary.name).toBe('Salary');
    // Before the fix this row rendered as -45,000-style negative under a
    // positive parent, because `children` was spread through un-negated.
    expect(salary.amount).toBeCloseTo(50_000, 6);
  });

  it('net income is income minus expenses', async () => {
    const report = await generateIncomeStatement(FILTERS);
    expect(report.grandTotal).toBeCloseTo(30_000, 6);
  });
});

/* ------------------------------------------------------------------ */
/* Balance Sheet                                                       */
/* ------------------------------------------------------------------ */

describe('balance sheet sections add up', () => {
  beforeEach(() => {
    mockAccountsFindMany.mockResolvedValue([
      acct('asset-top', 'Assets', 'ASSET'),
      acct('checking', 'Checking', 'BANK', 'asset-top'),
      acct('ar', 'Accounts Receivable', 'RECEIVABLE', 'asset-top'),
      acct('liab-top', 'Liabilities', 'LIABILITY'),
      acct('cc', 'Credit Card', 'CREDIT', 'liab-top'),
      acct('ap', 'Accounts Payable', 'PAYABLE', 'liab-top'),
      acct('equity', 'Opening Balances', 'EQUITY'),
    ]);
    // Liabilities and equity are credit-normal -> negative raw balances.
    routeQueryRaw({
      sums: [
        sumRow('checking', 1_000),
        sumRow('ar', 8_000),
        sumRow('cc', -200),
        sumRow('ap', -300),
        sumRow('equity', -8_500),
      ],
    });
  });

  it('each section total equals the sum of its top-level items', async () => {
    const report = await generateBalanceSheet(FILTERS);
    for (const section of report.sections) assertSectionAddsUp(section);
  });

  it('liability CHILDREN are positive under a positive Total Liabilities', async () => {
    const report = await generateBalanceSheet(FILTERS);
    const liabilities = report.sections.find(s => s.title === 'Liabilities')!;
    expect(liabilities.total).toBeCloseTo(500, 6);

    const top = liabilities.items[0];
    expect(top.amount).toBeCloseTo(500, 6);
    const byName = new Map(top.children!.map(c => [c.name, c.amount]));
    // Previously -200 / -300 sat under a +500 total.
    expect(byName.get('Credit Card')).toBeCloseTo(200, 6);
    expect(byName.get('Accounts Payable')).toBeCloseTo(300, 6);
  });

  it('balances: assets − liabilities − equity = 0', async () => {
    const report = await generateBalanceSheet(FILTERS);
    expect(report.grandTotal).toBeCloseTo(0, 6);
  });
});

/* ------------------------------------------------------------------ */
/* Account Summary                                                     */
/* ------------------------------------------------------------------ */

describe('account summary keeps A/R and A/P', () => {
  beforeEach(() => {
    mockAccountsFindMany.mockResolvedValue([
      acct('checking', 'Checking', 'BANK'),
      acct('ar', 'Accounts Receivable', 'RECEIVABLE'),
      acct('cc', 'Credit Card', 'CREDIT'),
      acct('ap', 'Accounts Payable', 'PAYABLE'),
    ]);
    routeQueryRaw({
      openClose: [
        openCloseRow('checking', 500, 1_000),
        openCloseRow('ar', 0, 8_000),
        openCloseRow('cc', 0, -200),
        openCloseRow('ap', 0, -300),
      ],
    });
  });

  it('each section total equals the sum of its top-level items', async () => {
    const report = await generateAccountSummary(FILTERS);
    for (const section of report.sections) assertSectionAddsUp(section);
  });

  it('an $8,000 A/R balance is included in Total Assets, not dropped', async () => {
    const report = await generateAccountSummary(FILTERS);
    const assets = report.sections.find(s => s.title === 'Assets')!;
    expect(assets.items.map(i => i.name).sort()).toEqual(['Accounts Receivable', 'Checking']);
    // Understated by the full 8,000 before RECEIVABLE was added to assetTypes.
    expect(assets.total).toBeCloseTo(9_000, 6);
  });

  it('A/P is included in Liabilities', async () => {
    const report = await generateAccountSummary(FILTERS);
    const liabilities = report.sections.find(s => s.title === 'Liabilities')!;
    expect(liabilities.items.map(i => i.name).sort()).toEqual(['Accounts Payable', 'Credit Card']);
    expect(liabilities.total).toBeCloseTo(-500, 6);
  });
});

/* ------------------------------------------------------------------ */
/* Trial Balance                                                       */
/* ------------------------------------------------------------------ */

describe('trial balance actually balances', () => {
  beforeEach(() => {
    mockAccountsFindMany.mockResolvedValue([
      acct('checking', 'Checking', 'BANK'),
      acct('stock', 'AAPL', 'STOCK'),
      acct('income', 'Salary', 'INCOME'),
      acct('trading', 'Trading', 'TRADING'),
    ]);
    // quantity_sum is deliberately DIFFERENT from value_sum for the stock
    // account: 50 shares that cost $5,000. Marking those 50 shares to a market
    // price is what used to inject a phantom imbalance.
    routeQueryRaw({
      sums: [
        sumRow('checking', 1_000, 1_000),
        sumRow('stock', 50, 5_000),
        sumRow('income', -6_000, -6_000),
      ],
    });
  });

  it('total debits equal total credits with securities carried at cost', async () => {
    const report = await generateTrialBalance(FILTERS);
    expect(report.totalDebits).toBeCloseTo(6_000, 2);
    expect(report.totalCredits).toBeCloseTo(6_000, 2);
    expect(report.totalDebits - report.totalCredits).toBeCloseTo(0, 2);
  });

  it('the security line shows its posted $5,000 cost, not 50 units', async () => {
    const report = await generateTrialBalance(FILTERS);
    const stock = report.entries.find(e => e.accountPath.includes('AAPL'))!;
    expect(stock.debit).toBeCloseTo(5_000, 2);
    expect(stock.credit).toBe(0);
  });

  it('TRADING accounts are queried, not excluded', async () => {
    await generateTrialBalance(FILTERS);
    const types = mockAccountsFindMany.mock.calls[0][0].where.account_type.in;
    expect(types).toContain('TRADING');
  });
});
