import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: vi.fn(),
    books: { findFirst: vi.fn() },
    accounts: { findMany: vi.fn() },
    transactions: { findMany: vi.fn() },
    commodities: { findMany: vi.fn() },
    prices: { findMany: vi.fn() },
    budgets: { findMany: vi.fn() },
    gnucash_web_budget_ownership: { findMany: vi.fn() },
  },
}));

import prisma from '@/lib/prisma';
import { exportBookData } from '../exporter';

const mockPrisma = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.books.findFirst.mockResolvedValue({ guid: 'book-a', root_account_guid: 'root' } as never);
  (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ guid: 'local-account' }]);
  mockPrisma.accounts.findMany.mockResolvedValue([
    { guid: 'root', name: 'Root', account_type: 'ROOT', commodity_guid: null, commodity_scu: 100, description: null, parent_guid: null, commodity: null },
    { guid: 'local-account', name: 'Local', account_type: 'EXPENSE', commodity_guid: null, commodity_scu: 100, description: null, parent_guid: 'root', commodity: null },
  ] as never);
  mockPrisma.transactions.findMany.mockResolvedValue([]);
  mockPrisma.commodities.findMany.mockResolvedValue([]);
  mockPrisma.prices.findMany.mockResolvedValue([]);
});

describe('exportBookData budget ownership', () => {
  it('exports owned empty budgets and removes foreign budgets and amounts', async () => {
    mockPrisma.gnucash_web_budget_ownership.findMany.mockResolvedValue([
      { budget_guid: 'owned-empty' },
      { budget_guid: 'owned-mixed' },
    ] as never);
    mockPrisma.budgets.findMany.mockResolvedValue([
      { guid: 'owned-empty', name: 'Empty', description: null, num_periods: 12, amounts: [], recurrences: [] },
      {
        guid: 'owned-mixed', name: 'Mixed', description: null, num_periods: 12, recurrences: [],
        amounts: [
          { account_guid: 'local-account', period_num: 0, amount_num: 100n, amount_denom: 1n },
          { account_guid: 'foreign-account', period_num: 0, amount_num: 200n, amount_denom: 1n },
        ],
      },
      {
        guid: 'foreign-budget', name: 'Foreign', description: null, num_periods: 12, recurrences: [],
        amounts: [{ account_guid: 'local-account', period_num: 0, amount_num: 300n, amount_denom: 1n }],
      },
    ] as never);

    const result = await exportBookData('root');

    expect(mockPrisma.gnucash_web_budget_ownership.findMany).toHaveBeenCalledWith({
      where: { book_guid: 'book-a' },
      select: { budget_guid: true },
    });
    expect(mockPrisma.budgets.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guid: { in: ['owned-empty', 'owned-mixed'] } },
      include: {
        amounts: { where: { account_guid: { in: ['local-account', 'root'] } } },
        recurrences: true,
      },
    }));
    expect(result.budgets).toEqual([
      expect.objectContaining({ id: 'owned-empty', amounts: [] }),
      expect.objectContaining({
        id: 'owned-mixed',
        amounts: [{ accountId: 'local-account', periodNum: 0, amount: '100/1' }],
      }),
    ]);
  });
});
