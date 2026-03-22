/**
 * Financial Summary Service Tests
 *
 * Tests for the extracted financial computation logic:
 * - computeSavingsRate (pure function, no mocks needed)
 * - computeNetWorthSummary (mocked Prisma + currency)
 * - computeIncomeExpenses (mocked Prisma + currency)
 * - computeTopExpenseCategory (mocked Prisma)
 * - computeFullSummary (integration of all above)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinancialSummaryService } from '../financial-summary.service';

// Mock prisma
vi.mock('@/lib/prisma', () => ({
  default: {
    accounts: { findMany: vi.fn() },
    splits: { findMany: vi.fn() },
    prices: { findMany: vi.fn() },
  },
}));

// Mock currency functions
vi.mock('@/lib/currency', () => ({
  getBaseCurrency: vi.fn(),
  findExchangeRate: vi.fn(),
}));

import prisma from '@/lib/prisma';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';

const mockPrisma = vi.mocked(prisma);
const mockGetBaseCurrency = vi.mocked(getBaseCurrency);
const mockFindExchangeRate = vi.mocked(findExchangeRate);

const USD_CURRENCY = {
  guid: 'usd-guid',
  mnemonic: 'USD',
  fullname: 'US Dollar',
  fraction: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBaseCurrency.mockResolvedValue(USD_CURRENCY);
  mockFindExchangeRate.mockResolvedValue(null);
});

describe('FinancialSummaryService.computeSavingsRate', () => {
  it('should compute savings rate correctly', () => {
    expect(FinancialSummaryService.computeSavingsRate(10000, 7000)).toBeCloseTo(30);
  });

  it('should return 0 when income is zero', () => {
    expect(FinancialSummaryService.computeSavingsRate(0, 500)).toBe(0);
  });

  it('should return 0 when income is negative', () => {
    expect(FinancialSummaryService.computeSavingsRate(-1000, 500)).toBe(0);
  });

  it('should return 100 when expenses are zero', () => {
    expect(FinancialSummaryService.computeSavingsRate(5000, 0)).toBe(100);
  });

  it('should handle negative savings rate (expenses exceed income)', () => {
    const rate = FinancialSummaryService.computeSavingsRate(5000, 8000);
    expect(rate).toBeCloseTo(-60);
  });
});

describe('FinancialSummaryService.computeNetWorthSummary', () => {
  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-12-31');
  const bookGuids = ['root-guid', 'checking-guid', 'credit-guid'];

  it('should compute net worth from asset and liability splits', async () => {
    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'checking-guid', account_type: 'BANK', commodity_guid: 'usd-guid', commodity: { namespace: 'CURRENCY' } },
      { guid: 'credit-guid', account_type: 'CREDIT', commodity_guid: 'usd-guid', commodity: { namespace: 'CURRENCY' } },
    ] as never);

    mockPrisma.splits.findMany.mockImplementation(((args: { where: { account_guid: { in: string[] } } }) => {
      const accountGuids = args.where.account_guid.in;
      if (accountGuids.includes('checking-guid')) {
        // Cash splits
        return Promise.resolve([
          {
            account_guid: 'checking-guid',
            quantity_num: BigInt(500000),
            quantity_denom: BigInt(100),
            transaction: { post_date: new Date('2025-06-15') },
          },
          {
            account_guid: 'credit-guid',
            quantity_num: BigInt(-100000),
            quantity_denom: BigInt(100),
            transaction: { post_date: new Date('2025-06-15') },
          },
        ]);
      }
      // Investment splits
      return Promise.resolve([]);
    }) as never);

    mockPrisma.prices.findMany.mockResolvedValue([]);

    const result = await FinancialSummaryService.computeNetWorthSummary(
      bookGuids, startDate, endDate, USD_CURRENCY
    );

    // Assets: 5000, Liabilities: -1000, Net = 4000
    expect(result.end.assets).toBeCloseTo(5000);
    expect(result.end.liabilities).toBeCloseTo(-1000);
    expect(result.end.netWorth).toBeCloseTo(4000);
  });

  it('should return zeroes when no accounts exist', async () => {
    mockPrisma.accounts.findMany.mockResolvedValue([]);
    mockPrisma.splits.findMany.mockResolvedValue([]);
    mockPrisma.prices.findMany.mockResolvedValue([]);

    const result = await FinancialSummaryService.computeNetWorthSummary(
      bookGuids, startDate, endDate, USD_CURRENCY
    );

    expect(result.end.netWorth).toBe(0);
    expect(result.start.netWorth).toBe(0);
    expect(result.change).toBe(0);
    expect(result.changePercent).toBe(0);
  });

  it('should compute change percent correctly', async () => {
    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'checking-guid', account_type: 'BANK', commodity_guid: 'usd-guid', commodity: { namespace: 'CURRENCY' } },
    ] as never);

    // Two splits: one before startDate, one after
    mockPrisma.splits.findMany.mockImplementation(((args: { where: { account_guid: { in: string[] } } }) => {
      const accountGuids = args.where.account_guid.in;
      if (accountGuids.includes('checking-guid')) {
        return Promise.resolve([
          {
            account_guid: 'checking-guid',
            quantity_num: BigInt(100000),
            quantity_denom: BigInt(100),
            transaction: { post_date: new Date('2024-12-15') }, // before start
          },
          {
            account_guid: 'checking-guid',
            quantity_num: BigInt(50000),
            quantity_denom: BigInt(100),
            transaction: { post_date: new Date('2025-06-15') }, // after start
          },
        ]);
      }
      return Promise.resolve([]);
    }) as never);

    mockPrisma.prices.findMany.mockResolvedValue([]);

    const result = await FinancialSummaryService.computeNetWorthSummary(
      bookGuids, startDate, endDate, USD_CURRENCY
    );

    // Start: 1000, End: 1500, Change: 500, Percent: 50%
    expect(result.start.netWorth).toBeCloseTo(1000);
    expect(result.end.netWorth).toBeCloseTo(1500);
    expect(result.change).toBeCloseTo(500);
    expect(result.changePercent).toBeCloseTo(50);
  });
});

describe('FinancialSummaryService.computeIncomeExpenses', () => {
  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-12-31');
  const bookGuids = ['root-guid', 'salary-guid', 'rent-guid'];

  it('should compute income and expenses correctly', async () => {
    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'salary-guid', name: 'Salary', account_type: 'INCOME', hidden: 0, parent_guid: 'income-root', commodity_guid: 'usd-guid' },
      { guid: 'rent-guid', name: 'Rent', account_type: 'EXPENSE', hidden: 0, parent_guid: 'expense-root', commodity_guid: 'usd-guid' },
    ] as never);

    mockPrisma.splits.findMany.mockResolvedValue([
      {
        account_guid: 'salary-guid',
        quantity_num: BigInt(-300000),
        quantity_denom: BigInt(100),
      },
      {
        account_guid: 'rent-guid',
        quantity_num: BigInt(150000),
        quantity_denom: BigInt(100),
      },
    ] as never);

    const result = await FinancialSummaryService.computeIncomeExpenses(
      bookGuids, startDate, endDate, USD_CURRENCY
    );

    // Income: -(-3000) = 3000, Expenses: 1500
    expect(result.totalIncome).toBeCloseTo(3000);
    expect(result.totalExpenses).toBeCloseTo(1500);
    expect(result.expenseByAccount.get('rent-guid')).toBeCloseTo(1500);
  });

  it('should exclude hidden accounts', async () => {
    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'salary-guid', name: 'Salary', account_type: 'INCOME', hidden: 1, parent_guid: 'income-root', commodity_guid: 'usd-guid' },
    ] as never);

    mockPrisma.splits.findMany.mockResolvedValue([]);

    const result = await FinancialSummaryService.computeIncomeExpenses(
      bookGuids, startDate, endDate, USD_CURRENCY
    );

    expect(result.totalIncome).toBe(0);
    expect(result.totalExpenses).toBe(0);
  });

  it('should apply exchange rates for non-base currency accounts', async () => {
    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'eur-income-guid', name: 'EUR Income', account_type: 'INCOME', hidden: 0, parent_guid: 'income-root', commodity_guid: 'eur-guid' },
    ] as never);

    mockFindExchangeRate.mockResolvedValue({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 1.1,
      date: endDate,
      source: 'test',
    });

    mockPrisma.splits.findMany.mockResolvedValue([
      {
        account_guid: 'eur-income-guid',
        quantity_num: BigInt(-100000),
        quantity_denom: BigInt(100),
      },
    ] as never);

    const result = await FinancialSummaryService.computeIncomeExpenses(
      bookGuids, startDate, endDate, USD_CURRENCY
    );

    // Income: -(-1000 * 1.1) = 1100
    expect(result.totalIncome).toBeCloseTo(1100);
  });
});

describe('FinancialSummaryService.computeTopExpenseCategory', () => {
  it('should return the top expense category', async () => {
    const bookGuids = ['root-guid', 'groceries-guid', 'rent-guid', 'expense-root-guid', 'real-root-guid'];

    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'real-root-guid', name: 'Root Account', account_type: 'ROOT', parent_guid: null },
      { guid: 'expense-root-guid', name: 'Expenses', account_type: 'EXPENSE', parent_guid: 'real-root-guid' },
      { guid: 'groceries-guid', name: 'Groceries', account_type: 'EXPENSE', parent_guid: 'expense-root-guid' },
      { guid: 'rent-guid', name: 'Rent', account_type: 'EXPENSE', parent_guid: 'expense-root-guid' },
    ] as never);

    const expenseByAccount = new Map<string, number>();
    expenseByAccount.set('groceries-guid', 500);
    expenseByAccount.set('rent-guid', 1500);

    const result = await FinancialSummaryService.computeTopExpenseCategory(
      bookGuids, expenseByAccount
    );

    expect(result.name).toBe('Rent');
    expect(result.amount).toBe(1500);
  });

  it('should return empty when no expenses', async () => {
    const result = await FinancialSummaryService.computeTopExpenseCategory(
      ['root-guid'], new Map()
    );

    expect(result.name).toBe('');
    expect(result.amount).toBe(0);
  });

  it('should group sub-accounts under top-level category', async () => {
    const bookGuids = ['root-guid', 'food-guid', 'groceries-guid', 'dining-guid', 'rent-guid', 'expense-root-guid', 'real-root-guid'];

    mockPrisma.accounts.findMany.mockResolvedValue([
      { guid: 'real-root-guid', name: 'Root Account', account_type: 'ROOT', parent_guid: null },
      { guid: 'expense-root-guid', name: 'Expenses', account_type: 'EXPENSE', parent_guid: 'real-root-guid' },
      { guid: 'food-guid', name: 'Food', account_type: 'EXPENSE', parent_guid: 'expense-root-guid' },
      { guid: 'groceries-guid', name: 'Groceries', account_type: 'EXPENSE', parent_guid: 'food-guid' },
      { guid: 'dining-guid', name: 'Dining Out', account_type: 'EXPENSE', parent_guid: 'food-guid' },
      { guid: 'rent-guid', name: 'Rent', account_type: 'EXPENSE', parent_guid: 'expense-root-guid' },
    ] as never);

    const expenseByAccount = new Map<string, number>();
    expenseByAccount.set('groceries-guid', 800);  // sub of Food
    expenseByAccount.set('dining-guid', 400);     // sub of Food
    expenseByAccount.set('rent-guid', 1000);

    const result = await FinancialSummaryService.computeTopExpenseCategory(
      bookGuids, expenseByAccount
    );

    // Food (800 + 400 = 1200) > Rent (1000)
    expect(result.name).toBe('Food');
    expect(result.amount).toBe(1200);
  });
});

describe('FinancialSummaryService.computeFullSummary', () => {
  it('should return a complete financial summary with rounded values', async () => {
    const bookGuids = ['root-guid', 'checking-guid', 'salary-guid', 'rent-guid', 'real-root-guid', 'expense-root-guid'];
    const startDate = new Date('2025-01-01');
    const endDate = new Date('2025-12-31');

    // Mock accounts for net worth query
    const accountsFindMany = vi.fn();
    // First call: net worth accounts (asset/liability/investment types)
    accountsFindMany.mockResolvedValueOnce([
      { guid: 'checking-guid', account_type: 'BANK', commodity_guid: 'usd-guid', commodity: { namespace: 'CURRENCY' } },
    ]);

    // Second call: all accounts for income/expense
    accountsFindMany.mockResolvedValueOnce([
      { guid: 'salary-guid', name: 'Salary', account_type: 'INCOME', hidden: 0, parent_guid: 'income-root', commodity_guid: 'usd-guid' },
      { guid: 'rent-guid', name: 'Rent', account_type: 'EXPENSE', hidden: 0, parent_guid: 'expense-root-guid', commodity_guid: 'usd-guid' },
      { guid: 'real-root-guid', name: 'Root Account', account_type: 'ROOT', parent_guid: null, hidden: 0, commodity_guid: 'usd-guid' },
      { guid: 'expense-root-guid', name: 'Expenses', account_type: 'EXPENSE', parent_guid: 'real-root-guid', hidden: 0, commodity_guid: 'usd-guid' },
    ]);

    // Third call: all accounts for top category
    accountsFindMany.mockResolvedValueOnce([
      { guid: 'real-root-guid', name: 'Root Account', account_type: 'ROOT', parent_guid: null },
      { guid: 'expense-root-guid', name: 'Expenses', account_type: 'EXPENSE', parent_guid: 'real-root-guid' },
      { guid: 'rent-guid', name: 'Rent', account_type: 'EXPENSE', parent_guid: 'expense-root-guid' },
    ]);

    mockPrisma.accounts.findMany = accountsFindMany;

    // Splits mock: first two calls for net worth (cash + investment), third for I/E
    const splitsFindMany = vi.fn();
    splitsFindMany.mockResolvedValueOnce([
      {
        account_guid: 'checking-guid',
        quantity_num: BigInt(1000000),
        quantity_denom: BigInt(100),
        transaction: { post_date: new Date('2025-06-15') },
      },
    ]);
    splitsFindMany.mockResolvedValueOnce([]); // investment splits
    splitsFindMany.mockResolvedValueOnce([
      {
        account_guid: 'salary-guid',
        quantity_num: BigInt(-500000),
        quantity_denom: BigInt(100),
      },
      {
        account_guid: 'rent-guid',
        quantity_num: BigInt(200000),
        quantity_denom: BigInt(100),
      },
    ]);
    mockPrisma.splits.findMany = splitsFindMany;

    mockPrisma.prices.findMany.mockResolvedValue([]);

    const result = await FinancialSummaryService.computeFullSummary(
      bookGuids, startDate, endDate
    );

    expect(result.netWorth).toBe(10000);
    expect(result.totalIncome).toBe(5000);
    expect(result.totalExpenses).toBe(2000);
    expect(result.savingsRate).toBe(60);
    expect(result.topExpenseCategory).toBe('Rent');
    expect(result.topExpenseAmount).toBe(2000);
    expect(result.investmentValue).toBe(0);
  });
});
