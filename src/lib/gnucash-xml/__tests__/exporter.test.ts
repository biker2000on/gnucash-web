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
    lots: { findMany: vi.fn() },
    slots: { findMany: vi.fn() },
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
  mockPrisma.lots.findMany.mockResolvedValue([]);
  mockPrisma.slots.findMany.mockResolvedValue([]);
  mockPrisma.gnucash_web_budget_ownership.findMany.mockResolvedValue([]);
  mockPrisma.budgets.findMany.mockResolvedValue([]);
});

describe('exportBookData lot references', () => {
  it('exports split lot membership as lotId so builder emits split:lot (regression)', async () => {
    // Regression: exporter used to set `lot_guid` on the split object while
    // types/builder read `lotId`, so split:lot was silently never emitted.
    mockPrisma.transactions.findMany.mockResolvedValue([
      {
        guid: 'tx-1',
        currency_guid: 'usd-guid',
        num: '',
        post_date: new Date('2024-01-15T10:30:00Z'),
        enter_date: new Date('2024-01-15T10:30:00Z'),
        description: 'Buy',
        splits: [
          {
            guid: 'split-1',
            tx_guid: 'tx-1',
            account_guid: 'local-account',
            memo: '',
            action: '',
            reconcile_state: 'n',
            reconcile_date: null,
            value_num: 100n,
            value_denom: 100n,
            quantity_num: 100n,
            quantity_denom: 100n,
            lot_guid: 'lot-1',
          },
        ],
      },
    ] as never);
    mockPrisma.commodities.findMany.mockResolvedValue([
      { guid: 'usd-guid', namespace: 'CURRENCY', mnemonic: 'USD', fullname: null, cusip: null, fraction: 100, quote_flag: 0, quote_source: null, quote_tz: null },
    ] as never);
    mockPrisma.lots.findMany.mockResolvedValue([
      { guid: 'lot-1', account_guid: 'local-account', is_closed: 0 },
    ] as never);

    const result = await exportBookData('root');

    expect(result.transactions[0].splits[0].lotId).toBe('lot-1');
    // The lot itself is emitted under its owning account.
    const local = result.accounts.find((a) => a.id === 'local-account');
    expect(local?.lots).toEqual([{ id: 'lot-1' }]);
  });

  it('attaches lot title/notes slots from the slots table', async () => {
    mockPrisma.lots.findMany.mockResolvedValue([
      { guid: 'lot-1', account_guid: 'local-account', is_closed: 1 },
    ] as never);
    mockPrisma.slots.findMany
      .mockResolvedValueOnce([
        { obj_guid: 'lot-1', name: 'title', slot_type: 4, int64_val: null, string_val: 'Lot 0', double_val: null, timespec_val: null, guid_val: null, numeric_val_num: null, numeric_val_denom: null, gdate_val: null },
        { obj_guid: 'lot-1', name: 'notes', slot_type: 4, int64_val: null, string_val: 'my note', double_val: null, timespec_val: null, guid_val: null, numeric_val_num: null, numeric_val_denom: null, gdate_val: null },
      ] as never)
      .mockResolvedValue([] as never);

    const result = await exportBookData('root');

    const local = result.accounts.find((a) => a.id === 'local-account');
    expect(local?.lots).toEqual([
      {
        id: 'lot-1',
        slots: [
          { key: 'notes', value: { type: 'string', value: 'my note' } },
          { key: 'title', value: { type: 'string', value: 'Lot 0' } },
        ],
      },
    ]);
  });
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
