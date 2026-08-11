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
    schedxactions: { findMany: vi.fn() },
    recurrences: { findMany: vi.fn() },
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
  mockPrisma.schedxactions.findMany.mockResolvedValue([]);
  mockPrisma.recurrences.findMany.mockResolvedValue([]);
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

describe('exportBookData scheduled transactions and templates', () => {
  const emptySlotRow = {
    int64_val: null,
    string_val: null,
    double_val: null,
    timespec_val: null,
    guid_val: null,
    numeric_val_num: null,
    numeric_val_denom: null,
    gdate_val: null,
  };

  function mockTemplateBook(options: {
    templateAccounts: Array<Record<string, unknown>>;
    templateTransactions?: Array<Record<string, unknown>>;
    slotRows?: Array<Record<string, unknown>>;
    schedxactions?: Array<Record<string, unknown>>;
    recurrences?: Array<Record<string, unknown>>;
  }) {
    mockPrisma.books.findFirst.mockResolvedValue({
      guid: 'book-a',
      root_account_guid: 'root',
      root_template_guid: 'tmpl-root',
    } as never);
    // First $queryRaw call = real account tree, second = template tree.
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ guid: 'local-account' }])
      .mockResolvedValueOnce(
        options.templateAccounts.map((a) => ({ guid: a.guid })),
      );
    const realAccounts = [
      { guid: 'root', name: 'Root', account_type: 'ROOT', commodity_guid: 'usd-guid', commodity_scu: 100, non_std_scu: 0, description: null, parent_guid: null, hidden: 0, placeholder: 0, commodity: null },
      { guid: 'local-account', name: 'Local', account_type: 'EXPENSE', commodity_guid: 'usd-guid', commodity_scu: 100, non_std_scu: 0, description: null, parent_guid: 'root', hidden: 0, placeholder: 0, commodity: null },
    ];
    mockPrisma.accounts.findMany.mockImplementation((async (args?: unknown) => {
      const guids: string[] | undefined = (args as { where?: { guid?: { in?: string[] } } })
        ?.where?.guid?.in;
      if (guids?.includes('tmpl-root')) {
        return options.templateAccounts;
      }
      return realAccounts;
    }) as never);
    mockPrisma.transactions.findMany.mockImplementation((async (args?: unknown) => {
      const accountGuids: string[] | undefined = (
        args as { where?: { splits?: { some?: { account_guid?: { in?: string[] } } } } }
      )?.where?.splits?.some?.account_guid?.in;
      if (accountGuids?.includes('tmpl-root')) {
        return options.templateTransactions ?? [];
      }
      return [];
    }) as never);
    mockPrisma.commodities.findMany.mockResolvedValue([
      { guid: 'usd-guid', namespace: 'CURRENCY', mnemonic: 'USD', fullname: null, cusip: null, fraction: 100, quote_flag: 0, quote_source: null, quote_tz: null },
    ] as never);
    mockPrisma.slots.findMany
      .mockReset()
      .mockResolvedValueOnce((options.slotRows ?? []) as never)
      .mockResolvedValue([] as never);
    mockPrisma.schedxactions.findMany.mockResolvedValue(
      (options.schedxactions ?? []) as never,
    );
    mockPrisma.recurrences.findMany.mockResolvedValue(
      (options.recurrences ?? []) as never,
    );
  }

  it('exports the template tree, sched-xaction frames, and sx elements (native layout)', async () => {
    mockTemplateBook({
      templateAccounts: [
        { guid: 'tmpl-root', name: 'Template Root', account_type: 'ROOT', commodity_guid: 'tmpl-cmdty', commodity_scu: 1, non_std_scu: 0, description: null, parent_guid: null, hidden: 0, placeholder: 0 },
        { guid: 'tmpl-acct1', name: 'sx-1-guid', account_type: 'BANK', commodity_guid: 'tmpl-cmdty', commodity_scu: 1, non_std_scu: 0, description: null, parent_guid: 'tmpl-root', hidden: 0, placeholder: 0 },
      ],
      templateTransactions: [
        {
          guid: 'tmpl-txn1',
          currency_guid: 'usd-guid',
          num: '',
          post_date: new Date('2024-01-01T00:00:00Z'),
          enter_date: new Date('2024-01-01T00:00:00Z'),
          description: 'Rent',
          splits: [
            { guid: 'tmpl-sp1', tx_guid: 'tmpl-txn1', account_guid: 'tmpl-acct1', memo: '', action: '', reconcile_state: 'n', reconcile_date: null, value_num: 0n, value_denom: 100n, quantity_num: 0n, quantity_denom: 1n, lot_guid: null },
          ],
        },
      ],
      slotRows: [
        { ...emptySlotRow, obj_guid: 'tmpl-sp1', name: 'sched-xaction', slot_type: 9, guid_val: 'frame-1' },
        { ...emptySlotRow, obj_guid: 'frame-1', name: 'sched-xaction/account', slot_type: 5, guid_val: 'local-account' },
        { ...emptySlotRow, obj_guid: 'frame-1', name: 'sched-xaction/debit-formula', slot_type: 4, string_val: '1200' },
        { ...emptySlotRow, obj_guid: 'frame-1', name: 'sched-xaction/debit-numeric', slot_type: 3, numeric_val_num: 1200n, numeric_val_denom: 1n },
      ],
      schedxactions: [
        {
          guid: 'sx-1-guid',
          name: 'Rent',
          enabled: 1,
          start_date: new Date('2024-01-01T00:00:00Z'),
          end_date: new Date('2025-12-31T00:00:00Z'),
          last_occur: new Date('2024-06-01T00:00:00Z'),
          num_occur: 0,
          rem_occur: 0,
          auto_create: 1,
          auto_notify: 0,
          adv_creation: 3,
          adv_notify: 5,
          instance_count: 12,
          template_act_guid: 'tmpl-acct1',
        },
      ],
      recurrences: [
        { id: 1, obj_guid: 'sx-1-guid', recurrence_mult: 1, recurrence_period_type: 'month', recurrence_period_start: new Date('2024-01-01T00:00:00Z'), recurrence_weekend_adjust: 'back' },
        { id: 2, obj_guid: 'sx-1-guid', recurrence_mult: 1, recurrence_period_type: 'month', recurrence_period_start: new Date('2024-01-15T00:00:00Z'), recurrence_weekend_adjust: 'none' },
      ],
    });

    const result = await exportBookData('root');

    // Template accounts: ROOT first (no commodity), children on the
    // template namespace commodity.
    expect(result.templateAccounts).toHaveLength(2);
    expect(result.templateAccounts![0]).toMatchObject({ id: 'tmpl-root', type: 'ROOT' });
    expect(result.templateAccounts![0].commodity).toBeUndefined();
    expect(result.templateAccounts![1]).toMatchObject({
      id: 'tmpl-acct1',
      commodity: { space: 'template', id: 'template' },
      commodityScu: 1,
      parentId: 'tmpl-root',
    });

    // The split-owned sched-xaction frame survives via the slots codec.
    const split = result.templateTransactions![0].splits[0];
    expect(split.slots).toEqual([
      {
        key: 'sched-xaction',
        value: {
          type: 'frame',
          slots: [
            { key: 'account', value: { type: 'guid', value: 'local-account' } },
            { key: 'debit-formula', value: { type: 'string', value: '1200' } },
            { key: 'debit-numeric', value: { type: 'numeric', value: '1200/1' } },
          ],
        },
      },
    ]);

    // SX mapping: y/n flags, gdates, end trio (num_occur 0 = no occur def
    // so the end date is used), both recurrence rows.
    expect(result.schedxactions).toEqual([
      {
        id: 'sx-1-guid',
        name: 'Rent',
        enabled: true,
        autoCreate: true,
        autoCreateNotify: false,
        advanceCreateDays: 3,
        advanceRemindDays: 5,
        instanceCount: 12,
        start: '2024-01-01',
        last: '2024-06-01',
        end: '2025-12-31',
        templateAccountId: 'tmpl-acct1',
        schedule: [
          { mult: 1, periodType: 'month', periodStart: '2024-01-01', weekendAdjust: 'back' },
          { mult: 1, periodType: 'month', periodStart: '2024-01-15' },
        ],
        slots: undefined,
      },
    ]);

    // Count data and the template commodity declaration.
    expect(result.countData.schedxaction).toBe(1);
    expect(
      result.commodities.find((c) => c.space === 'template' && c.id === 'template'),
    ).toMatchObject({ fraction: 1 });
  });

  it('synthesizes sched-xaction frames for app-created templates and hides the account mirror slot', async () => {
    // App layout (scheduled-tx-create): tmpl-root -> sx root -> one child
    // per split; each child carries the account mirror row and the split
    // value carries the signed amount.
    mockTemplateBook({
      templateAccounts: [
        { guid: 'tmpl-root', name: 'Template Root', account_type: 'ROOT', commodity_guid: 'usd-guid', commodity_scu: 100, non_std_scu: 0, description: null, parent_guid: null, hidden: 0, placeholder: 0 },
        { guid: 'sx-root', name: 'My SX', account_type: 'BANK', commodity_guid: 'usd-guid', commodity_scu: 100, non_std_scu: 0, description: null, parent_guid: 'tmpl-root', hidden: 0, placeholder: 0 },
        { guid: 'sx-child-a', name: '', account_type: 'BANK', commodity_guid: 'usd-guid', commodity_scu: 100, non_std_scu: 0, description: null, parent_guid: 'sx-root', hidden: 0, placeholder: 0 },
        { guid: 'sx-child-b', name: '', account_type: 'BANK', commodity_guid: 'usd-guid', commodity_scu: 100, non_std_scu: 0, description: null, parent_guid: 'sx-root', hidden: 0, placeholder: 0 },
      ],
      templateTransactions: [
        {
          guid: 'app-tmpl-txn',
          currency_guid: 'usd-guid',
          num: '',
          post_date: null,
          enter_date: new Date('2024-01-01T00:00:00Z'),
          description: 'My SX',
          splits: [
            { guid: 'app-sp-a', tx_guid: 'app-tmpl-txn', account_guid: 'sx-child-a', memo: '', action: '', reconcile_state: 'n', reconcile_date: null, value_num: 2665n, value_denom: 100n, quantity_num: 2665n, quantity_denom: 100n, lot_guid: null },
            { guid: 'app-sp-b', tx_guid: 'app-tmpl-txn', account_guid: 'sx-child-b', memo: '', action: '', reconcile_state: 'n', reconcile_date: null, value_num: -2665n, value_denom: 100n, quantity_num: -2665n, quantity_denom: 100n, lot_guid: null },
          ],
        },
      ],
      slotRows: [
        { ...emptySlotRow, obj_guid: 'sx-child-a', name: 'account', slot_type: 4, guid_val: 'local-account' },
        { ...emptySlotRow, obj_guid: 'sx-child-b', name: 'account', slot_type: 4, guid_val: 'root' },
      ],
    });

    const result = await exportBookData('root');

    // The app-internal mirror row never leaks into act:slots.
    const childA = result.templateAccounts!.find((a) => a.id === 'sx-child-a')!;
    expect(childA.slots).toBeUndefined();

    // Debit side (positive value) and credit side (negative value) frames.
    const splits = result.templateTransactions![0].splits;
    expect(splits[0].slots).toEqual([
      {
        key: 'sched-xaction',
        value: {
          type: 'frame',
          slots: [
            { key: 'account', value: { type: 'guid', value: 'local-account' } },
            { key: 'credit-formula', value: { type: 'string', value: '' } },
            { key: 'credit-numeric', value: { type: 'numeric', value: '0/1' } },
            { key: 'debit-formula', value: { type: 'string', value: '26.65' } },
            { key: 'debit-numeric', value: { type: 'numeric', value: '2665/100' } },
          ],
        },
      },
    ]);
    expect(splits[1].slots).toEqual([
      {
        key: 'sched-xaction',
        value: {
          type: 'frame',
          slots: [
            { key: 'account', value: { type: 'guid', value: 'root' } },
            { key: 'credit-formula', value: { type: 'string', value: '26.65' } },
            { key: 'credit-numeric', value: { type: 'numeric', value: '2665/100' } },
            { key: 'debit-formula', value: { type: 'string', value: '' } },
            { key: 'debit-numeric', value: { type: 'numeric', value: '0/1' } },
          ],
        },
      },
    ]);
  });

  it('exports no template tree for legacy books whose template root IS the account root', async () => {
    mockPrisma.books.findFirst.mockResolvedValue({
      guid: 'book-a',
      root_account_guid: 'root',
      root_template_guid: 'root',
    } as never);

    const result = await exportBookData('root');

    expect(result.templateAccounts).toEqual([]);
    expect(result.templateTransactions).toEqual([]);
    expect(result.schedxactions).toEqual([]);
    expect(result.countData.schedxaction).toBe(0);
    expect(result.commodities.find((c) => c.space === 'template')).toBeUndefined();
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
