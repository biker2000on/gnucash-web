import { describe, it, expect, vi, beforeEach } from 'vitest';

type Call = { op: string; data?: unknown };

const calls: Call[] = [];

function record(op: string) {
  return vi.fn(async (args: { data: unknown }) => {
    calls.push({ op, data: args?.data });
    return args?.data;
  });
}

function recordMany(op: string) {
  return vi.fn(async (args: { data: unknown[] }) => {
    calls.push({ op, data: args.data });
    return { count: args.data.length };
  });
}

const existingBookRef: { current: { root_account_guid: string | null } | null } = { current: null };
const collidingBudgetsRef: { current: Array<{ guid: string }> } = { current: [] };
const budgetOwnershipRef: {
  current: Array<{ budget_guid: string; book_guid: string }>;
} = { current: [] };

const tx = {
  commodities: {
    findMany: vi.fn(async () => []),
    create: record('commodities.create'),
  },
  accounts: {
    create: record('accounts.create'),
    update: vi.fn(async (args: { where: unknown; data: unknown }) => {
      calls.push({ op: 'accounts.update', data: args });
      return {};
    }),
    upsert: vi.fn(async (args: { where: unknown; create: unknown; update: unknown }) => {
      calls.push({ op: 'accounts.upsert', data: args });
      return {};
    }),
    updateMany: vi.fn(async (args: { where: unknown; data: unknown }) => {
      calls.push({ op: 'accounts.updateMany', data: args });
      return { count: 0 };
    }),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'accounts.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  books: {
    create: record('books.create'),
    findUnique: vi.fn(async () => existingBookRef.current),
    update: vi.fn(async (args: { where: unknown; data: unknown }) => {
      calls.push({ op: 'books.update', data: args });
      return existingBookRef.current;
    }),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'books.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  lots: {
    createMany: recordMany('lots.createMany'),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'lots.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  transactions: {
    createMany: recordMany('transactions.createMany'),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'transactions.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  splits: {
    createMany: recordMany('splits.createMany'),
    findMany: vi.fn(async () => []),
  },
  slots: {
    createMany: recordMany('slots.createMany'),
    findMany: vi.fn(async () => []),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'slots.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  prices: {
    createMany: recordMany('prices.createMany'),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'prices.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  budgets: {
    create: record('budgets.create'),
    findMany: vi.fn(async () => collidingBudgetsRef.current),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'budgets.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  budget_amounts: { createMany: recordMany('budget_amounts.createMany') },
  gnucash_web_budget_ownership: {
    create: record('gnucash_web_budget_ownership.create'),
    findMany: vi.fn(async () => budgetOwnershipRef.current),
  },
  recurrences: {
    create: record('recurrences.create'),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'recurrences.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  schedxactions: {
    create: record('schedxactions.create'),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'schedxactions.deleteMany', data: args });
      return { count: 0 };
    }),
  },
};

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: async (
      fn: (t: typeof tx) => Promise<void>,
    ) => fn(tx),
  },
}));

import { importGnuCashData } from '../importer';
import type { GnuCashXmlData } from '../types';

function minimalData(): GnuCashXmlData {
  return {
    book: { id: 'book-guid-0000000000000000000000', idType: 'guid' },
    commodities: [
      { space: 'CURRENCY', id: 'USD', fraction: 100 },
      { space: 'NASDAQ', id: 'AAPL', fraction: 10000 },
    ],
    pricedb: [],
    accounts: [
      {
        id: 'acct-investments-00000000000000000',
        name: 'Investments',
        type: 'ASSET',
        commodity: { space: 'CURRENCY', id: 'USD' },
      },
      {
        id: 'acct-aapl-000000000000000000000000',
        name: 'AAPL',
        type: 'STOCK',
        commodity: { space: 'NASDAQ', id: 'AAPL' },
        parentId: 'acct-investments-00000000000000000',
      },
    ],
    transactions: [
      {
        id: 'txn-buy-00000000000000000000000000',
        currency: { space: 'CURRENCY', id: 'USD' },
        datePosted: '2024-01-15 10:30:00 +0000',
        dateEntered: '2024-01-15 10:30:00 +0000',
        description: 'Buy AAPL',
        splits: [
          {
            id: 'split-buy-aapl-0000000000000000',
            reconciledState: 'n',
            value: '10000/100',
            quantity: '10000/10000',
            accountId: 'acct-aapl-000000000000000000000000',
            lotId: 'lot-aapl-0000000000000000000000',
          },
          {
            id: 'split-buy-cash-0000000000000000',
            reconciledState: 'n',
            value: '-10000/100',
            quantity: '-10000/100',
            accountId: 'acct-investments-00000000000000000',
          },
        ],
      },
    ],
    budgets: [],
    countData: {},
  };
}

describe('importGnuCashData — lot FK handling', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
    collidingBudgetsRef.current = [];
    budgetOwnershipRef.current = [];
  });

  it('creates referenced lots before inserting splits that point at them', async () => {
    await importGnuCashData(minimalData(), 'Test Book');

    const lotIdx = calls.findIndex((c) => c.op === 'lots.createMany');
    const firstSplitIdx = calls.findIndex((c) => c.op === 'splits.createMany');

    expect(lotIdx).toBeGreaterThanOrEqual(0);
    expect(firstSplitIdx).toBeGreaterThan(lotIdx);

    const lotRows = calls[lotIdx].data as Array<{
      guid: string;
      account_guid: string;
      is_closed: number;
    }>;
    expect(lotRows).toEqual([
      {
        guid: 'lot-aapl-0000000000000000000000',
        account_guid: 'acct-aapl-000000000000000000000000',
        is_closed: 0,
      },
    ]);

    const splitBatch = calls.find((c) => c.op === 'splits.createMany')!
      .data as Array<{ guid: string; lot_guid: string | null }>;
    const splitWithLot = splitBatch.find((s) => s.guid === 'split-buy-aapl-0000000000000000');
    expect(splitWithLot?.lot_guid).toBe('lot-aapl-0000000000000000000000');
  });

  it('skips lot creation when no splits reference a lot', async () => {
    const data = minimalData();
    data.transactions[0].splits[0].lotId = undefined;

    await importGnuCashData(data, 'Test Book');

    expect(tx.lots.createMany).not.toHaveBeenCalled();
  });
});

describe('importGnuCashData — KVP slots and lots', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
    collidingBudgetsRef.current = [];
    budgetOwnershipRef.current = [];
  });

  it('writes account, transaction, and split slots to the slots table', async () => {
    const data = minimalData();
    data.accounts[0].slots = [
      { key: 'notes', value: { type: 'string', value: 'brokerage sweep' } },
      { key: 'color', value: { type: 'string', value: 'Not Set' } },
    ];
    data.transactions[0].slots = [
      { key: 'date-posted', value: { type: 'gdate', value: '2024-01-15' } },
      { key: 'notes', value: { type: 'string', value: 'txn note' } },
    ];
    data.transactions[0].splits[0].slots = [
      { key: 'gains-split', value: { type: 'guid', value: 'gains-split-guid-0000000000000000' } },
    ];

    const result = await importGnuCashData(data, 'Test Book');

    const slotBatches = calls.filter((c) => c.op === 'slots.createMany');
    expect(slotBatches).toHaveLength(1);
    const rows = slotBatches[0].data as Array<Record<string, unknown>>;

    expect(rows).toContainEqual(
      expect.objectContaining({
        obj_guid: 'acct-investments-00000000000000000',
        name: 'notes',
        slot_type: 4,
        string_val: 'brokerage sweep',
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        obj_guid: 'txn-buy-00000000000000000000000000',
        name: 'date-posted',
        slot_type: 10,
        gdate_val: new Date('2024-01-15T00:00:00.000Z'),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        obj_guid: 'split-buy-aapl-0000000000000000',
        name: 'gains-split',
        slot_type: 5,
        guid_val: 'gains-split-guid-0000000000000000',
      }),
    );
    expect(result.slots).toBe(rows.length);
  });

  it('imports declared act:lots with their slots and derives is_closed', async () => {
    const data = minimalData();
    // Declare the lot on the AAPL account with a title, and add a closing
    // sale so the lot quantities sum to zero.
    data.accounts[1].lots = [
      {
        id: 'lot-aapl-0000000000000000000000',
        slots: [{ key: 'title', value: { type: 'string', value: 'Lot 0' } }],
      },
    ];
    data.transactions.push({
      id: 'txn-sell-0000000000000000000000000',
      currency: { space: 'CURRENCY', id: 'USD' },
      datePosted: '2024-02-15 10:30:00 +0000',
      dateEntered: '2024-02-15 10:30:00 +0000',
      description: 'Sell AAPL',
      splits: [
        {
          id: 'split-sell-aapl-000000000000000',
          reconciledState: 'n',
          value: '-11000/100',
          quantity: '-10000/10000',
          accountId: 'acct-aapl-000000000000000000000000',
          lotId: 'lot-aapl-0000000000000000000000',
        },
        {
          id: 'split-sell-cash-000000000000000',
          reconciledState: 'n',
          value: '11000/100',
          quantity: '11000/100',
          accountId: 'acct-investments-00000000000000000',
        },
      ],
    });

    const result = await importGnuCashData(data, 'Test Book');

    const lotBatch = calls.find((c) => c.op === 'lots.createMany')!.data as Array<{
      guid: string;
      account_guid: string;
      is_closed: number;
    }>;
    expect(lotBatch).toEqual([
      {
        guid: 'lot-aapl-0000000000000000000000',
        account_guid: 'acct-aapl-000000000000000000000000',
        is_closed: 1,
      },
    ]);
    expect(result.lots).toBe(1);

    const slotRows = calls.find((c) => c.op === 'slots.createMany')!.data as Array<
      Record<string, unknown>
    >;
    expect(slotRows).toContainEqual(
      expect.objectContaining({
        obj_guid: 'lot-aapl-0000000000000000000000',
        name: 'title',
        slot_type: 4,
        string_val: 'Lot 0',
      }),
    );
  });

  it('surfaces parser skip notes (e.g. binary slots) in the summary', async () => {
    const data = minimalData();
    data.skipped = ['Binary slot value skipped (account x/legacy)'];

    const result = await importGnuCashData(data, 'Test Book');

    expect(result.skipped).toContain('Binary slot value skipped (account x/legacy)');
  });
});

describe('importGnuCashData — orphan budget slots', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
    collidingBudgetsRef.current = [];
    budgetOwnershipRef.current = [];
  });

  it('collapses repeated "account not found" warnings into one line per budget', async () => {
    const data = minimalData();
    data.budgets = [
      {
        id: 'budget-orphans-00000000000000000',
        name: 'Orphaned',
        numPeriods: 12,
        amounts: [
          // Same deleted account across 12 periods
          ...Array.from({ length: 12 }, (_, i) => ({
            accountId: 'deleted-account-guid-aaaaaaaaaaa',
            periodNum: i,
            amount: '100/1',
          })),
          // Different deleted account, 3 periods
          { accountId: 'deleted-account-guid-bbbbbbbbbbb', periodNum: 0, amount: '50/1' },
          { accountId: 'deleted-account-guid-bbbbbbbbbbb', periodNum: 1, amount: '50/1' },
          { accountId: 'deleted-account-guid-bbbbbbbbbbb', periodNum: 2, amount: '50/1' },
        ],
      },
    ];

    const result = await importGnuCashData(data, 'Test Book');

    const orphanWarnings = result.warnings.filter((w) => w.startsWith('Budget "Orphaned"'));
    expect(orphanWarnings).toHaveLength(1);
    expect(orphanWarnings[0]).toContain('skipped 15 amount(s)');
    expect(orphanWarnings[0]).toContain('2 deleted account(s)');
    expect(calls).toContainEqual({
      op: 'gnucash_web_budget_ownership.create',
      data: {
        budget_guid: 'budget-orphans-00000000000000000',
        book_guid: 'book-guid-0000000000000000000000',
      },
    });
  });
});

/** minimalData plus a scheduled transaction with its template structure. */
function sxData(): GnuCashXmlData {
  const data = minimalData();
  data.commodities.push({ space: 'template', id: 'template', fraction: 1 });
  data.templateAccounts = [
    { id: 'tmpl-root-0000000000000000000000', name: 'Template Root', type: 'ROOT' },
    {
      id: 'tmpl-acct-0000000000000000000001',
      name: 'sx-rent-00000000000000000000000000',
      type: 'BANK',
      commodity: { space: 'template', id: 'template' },
      commodityScu: 1,
      parentId: 'tmpl-root-0000000000000000000000',
    },
  ];
  data.templateTransactions = [
    {
      id: 'tmpl-txn-0000000000000000000001',
      currency: { space: 'CURRENCY', id: 'USD' },
      datePosted: '2023-12-31 23:00:00 +0000',
      dateEntered: '2023-12-31 23:00:00 +0000',
      description: 'Rent',
      splits: [
        {
          id: 'tmpl-sp-a-000000000000000000001',
          reconciledState: 'n',
          value: '0/100',
          quantity: '0/1',
          accountId: 'tmpl-acct-0000000000000000000001',
          slots: [
            {
              key: 'sched-xaction',
              value: {
                type: 'frame',
                slots: [
                  { key: 'account', value: { type: 'guid', value: 'acct-investments-00000000000000000' } },
                  { key: 'credit-numeric', value: { type: 'numeric', value: '0/1' } },
                  { key: 'debit-formula', value: { type: 'string', value: '1200' } },
                  { key: 'debit-numeric', value: { type: 'numeric', value: '1200/1' } },
                ],
              },
            },
          ],
        },
        {
          id: 'tmpl-sp-b-000000000000000000001',
          reconciledState: 'n',
          value: '0/100',
          quantity: '0/1',
          accountId: 'tmpl-acct-0000000000000000000001',
          slots: [
            {
              key: 'sched-xaction',
              value: {
                type: 'frame',
                slots: [
                  { key: 'account', value: { type: 'guid', value: 'acct-aapl-000000000000000000000000' } },
                  { key: 'credit-formula', value: { type: 'string', value: '1200' } },
                  { key: 'credit-numeric', value: { type: 'numeric', value: '1200/1' } },
                  { key: 'debit-numeric', value: { type: 'numeric', value: '0/1' } },
                ],
              },
            },
          ],
        },
      ],
    },
  ];
  data.schedxactions = [
    {
      id: 'sx-rent-00000000000000000000000000',
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
      templateAccountId: 'tmpl-acct-0000000000000000000001',
      schedule: [
        { mult: 1, periodType: 'month', periodStart: '2024-01-01', weekendAdjust: 'back' },
        { mult: 1, periodType: 'month', periodStart: '2024-01-15' },
      ],
      deferredInstances: [{ last: '2024-05-01', remOccur: 0, instanceCount: 8 }],
    },
  ];
  return data;
}

describe('importGnuCashData — scheduled transactions and templates', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
    collidingBudgetsRef.current = [];
    budgetOwnershipRef.current = [];
  });

  it('creates a DISTINCT template root and points books.root_template_guid at it', async () => {
    await importGnuCashData(sxData(), 'Test Book');

    const bookCreate = calls.find((c) => c.op === 'books.create')!.data as {
      root_account_guid: string;
      root_template_guid: string;
    };
    expect(bookCreate.root_template_guid).toBe('tmpl-root-0000000000000000000000');
    expect(bookCreate.root_template_guid).not.toBe(bookCreate.root_account_guid);

    const accountCreates = calls
      .filter((c) => c.op === 'accounts.create')
      .map((c) => c.data as Record<string, unknown>);
    const templateRoot = accountCreates.find(
      (a) => a.guid === 'tmpl-root-0000000000000000000000',
    );
    expect(templateRoot).toMatchObject({
      account_type: 'ROOT',
      name: 'Template Root',
      parent_guid: null,
    });
  });

  it('creates a template root even when the XML has no template-transactions', async () => {
    await importGnuCashData(minimalData(), 'Test Book');

    const bookCreate = calls.find((c) => c.op === 'books.create')!.data as {
      root_account_guid: string;
      root_template_guid: string;
    };
    expect(bookCreate.root_template_guid).not.toBe(bookCreate.root_account_guid);
    const accountCreates = calls
      .filter((c) => c.op === 'accounts.create')
      .map((c) => c.data as Record<string, unknown>);
    expect(
      accountCreates.find((a) => a.guid === bookCreate.root_template_guid),
    ).toMatchObject({ account_type: 'ROOT', name: 'Template Root' });
  });

  it('imports template accounts/transactions with preserved guids and slot frames', async () => {
    const result = await importGnuCashData(sxData(), 'Test Book');

    // Template child account preserved, parented under the template root,
    // never on the template commodity (no template commodity is created).
    const accountCreates = calls
      .filter((c) => c.op === 'accounts.create')
      .map((c) => c.data as Record<string, unknown>);
    const templateChild = accountCreates.find(
      (a) => a.guid === 'tmpl-acct-0000000000000000000001',
    )!;
    expect(templateChild.parent_guid).toBe('tmpl-root-0000000000000000000000');
    expect(templateChild.commodity_scu).toBe(1);

    const commodityCreates = calls
      .filter((c) => c.op === 'commodities.create')
      .map((c) => c.data as { namespace: string });
    expect(commodityCreates.some((c) => c.namespace === 'template')).toBe(false);

    // Template transaction and splits ride the ordinary batched inserts.
    const txnRows = calls
      .filter((c) => c.op === 'transactions.createMany')
      .flatMap((c) => c.data as Array<{ guid: string }>);
    expect(txnRows.some((t) => t.guid === 'tmpl-txn-0000000000000000000001')).toBe(true);
    const splitRows = calls
      .filter((c) => c.op === 'splits.createMany')
      .flatMap((c) => c.data as Array<{ guid: string; account_guid: string }>);
    expect(
      splitRows.find((s) => s.guid === 'tmpl-sp-a-000000000000000000001')?.account_guid,
    ).toBe('tmpl-acct-0000000000000000000001');

    // …but are not counted as book contents.
    expect(result.transactions).toBe(1);
    expect(result.accounts).toBe(2);

    // The sched-xaction frame lands in native slots-table layout: a frame
    // row on the split plus path-named children under the frame guid.
    const slotRows = calls
      .filter((c) => c.op === 'slots.createMany')
      .flatMap((c) => c.data as Array<Record<string, unknown>>);
    const frameRow = slotRows.find(
      (r) => r.obj_guid === 'tmpl-sp-a-000000000000000000001' && r.name === 'sched-xaction',
    )!;
    expect(frameRow.slot_type).toBe(9);
    const frameChildren = slotRows.filter((r) => r.obj_guid === frameRow.guid_val);
    expect(frameChildren).toContainEqual(
      expect.objectContaining({
        name: 'sched-xaction/account',
        slot_type: 5,
        guid_val: 'acct-investments-00000000000000000',
      }),
    );
    expect(frameChildren).toContainEqual(
      expect.objectContaining({
        name: 'sched-xaction/debit-numeric',
        slot_type: 3,
        numeric_val_num: 1200n,
        numeric_val_denom: 1n,
      }),
    );
  });

  it('inserts schedxactions with one recurrences row per gnc:recurrence', async () => {
    const result = await importGnuCashData(sxData(), 'Test Book');

    const sxCreate = calls.find((c) => c.op === 'schedxactions.create')!
      .data as Record<string, unknown>;
    expect(sxCreate).toMatchObject({
      guid: 'sx-rent-00000000000000000000000000',
      name: 'Rent',
      enabled: 1,
      auto_create: 1,
      auto_notify: 0,
      adv_creation: 3,
      adv_notify: 5,
      instance_count: 12,
      num_occur: 0,
      rem_occur: 0,
      template_act_guid: 'tmpl-acct-0000000000000000000001',
    });
    expect(sxCreate.start_date).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(sxCreate.end_date).toEqual(new Date('2025-12-31T00:00:00.000Z'));
    expect(sxCreate.last_occur).toEqual(new Date('2024-06-01T00:00:00.000Z'));

    // Composite schedule: BOTH recurrence rows inserted with obj_guid = sx.
    const recurrenceCreates = calls
      .filter((c) => c.op === 'recurrences.create')
      .map((c) => c.data as Record<string, unknown>);
    expect(recurrenceCreates).toHaveLength(2);
    expect(recurrenceCreates[0]).toMatchObject({
      obj_guid: 'sx-rent-00000000000000000000000000',
      recurrence_mult: 1,
      recurrence_period_type: 'month',
      recurrence_weekend_adjust: 'back',
    });
    expect(recurrenceCreates[1]).toMatchObject({
      obj_guid: 'sx-rent-00000000000000000000000000',
      recurrence_weekend_adjust: 'none',
    });

    expect(result.schedxactions).toBe(1);
    // Deferred instances have no SQL representation — recorded as skipped.
    expect(result.skipped.some((s) => s.includes('deferred instance'))).toBe(true);
  });

  it('uses num_occur/rem_occur when the SX has an occurrence definition', async () => {
    const data = sxData();
    delete data.schedxactions![0].end;
    data.schedxactions![0].numOccur = 24;
    data.schedxactions![0].remOccur = 20;

    await importGnuCashData(data, 'Test Book');

    const sxCreate = calls.find((c) => c.op === 'schedxactions.create')!
      .data as Record<string, unknown>;
    expect(sxCreate).toMatchObject({ num_occur: 24, rem_occur: 20, end_date: null });
  });

  it('skips an SX whose template account is missing, with a warning', async () => {
    const data = sxData();
    data.schedxactions![0].templateAccountId = 'nonexistent-template-account-0000';

    const result = await importGnuCashData(data, 'Test Book');

    expect(calls.some((c) => c.op === 'schedxactions.create')).toBe(false);
    expect(result.schedxactions).toBe(0);
    expect(result.warnings.some((w) => w.includes('template account'))).toBe(true);
  });

  it('clears schedxactions, recurrences, and template rows on overwrite', async () => {
    existingBookRef.current = {
      root_account_guid: 'old-root-guid-000000000000000000',
    };

    await importGnuCashData(sxData(), 'Test Book', { overwrite: true });

    const sxDeletes = calls.filter((c) => c.op === 'schedxactions.deleteMany');
    expect(sxDeletes).toHaveLength(1);
    const recurrenceDeletes = calls
      .filter((c) => c.op === 'recurrences.deleteMany')
      .map((c) => (c.data as { where: { obj_guid: { in: string[] } } }).where.obj_guid.in);
    expect(recurrenceDeletes).toContainEqual(['sx-rent-00000000000000000000000000']);

    // Template transactions collide like ordinary ones.
    const txnDelete = calls.find((c) => c.op === 'transactions.deleteMany')!
      .data as { where: { guid: { in: string[] } } };
    expect(txnDelete.where.guid.in).toContain('tmpl-txn-0000000000000000000001');
  });
});

describe('importGnuCashData — re-import handling', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
    collidingBudgetsRef.current = [];
    budgetOwnershipRef.current = [];
  });

  it('throws BookAlreadyExistsError when the book guid exists and overwrite is off', async () => {
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };

    const { importGnuCashData: importFn, BookAlreadyExistsError } = await import('../importer');

    await expect(importFn(minimalData(), 'Test Book')).rejects.toBeInstanceOf(
      BookAlreadyExistsError,
    );
  });

  it('upserts accounts and preserves non-XML transactions on overwrite', async () => {
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };

    await importGnuCashData(minimalData(), 'Test Book', { overwrite: true });

    const ops = calls.map((c) => c.op);

    // XML transactions are deleted (splits cascade), but accounts are NOT deleted.
    expect(ops).toContain('transactions.deleteMany');
    expect(ops).not.toContain('accounts.deleteMany');
    expect(ops).not.toContain('books.deleteMany');

    // Accounts are upserted, not created.
    expect(ops.filter((op) => op === 'accounts.upsert').length).toBeGreaterThan(0);

    // Book and root account are updated, not recreated.
    expect(ops).toContain('books.update');
    expect(ops).toContain('accounts.update');
  });

  it('rejects a foreign-owned budget collision before deleting any rows', async () => {
    const data = minimalData();
    const incomingBudgetGuid = 'foreign-budget-collision-000000000';
    data.budgets = [{
      id: incomingBudgetGuid,
      name: 'Foreign collision',
      numPeriods: 12,
      amounts: [],
    }];
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };
    collidingBudgetsRef.current = [{ guid: incomingBudgetGuid }];
    budgetOwnershipRef.current = [{
      budget_guid: incomingBudgetGuid,
      book_guid: 'another-book-guid-000000000000000',
    }];

    const { BudgetOwnershipConflictError } = await import('../importer');
    await expect(
      importGnuCashData(data, 'Test Book', { overwrite: true }),
    ).rejects.toBeInstanceOf(BudgetOwnershipConflictError);

    const ops = calls.map((call) => call.op);
    expect(ops).not.toContain('prices.deleteMany');
    expect(ops).not.toContain('recurrences.deleteMany');
    expect(ops).not.toContain('budgets.deleteMany');
    expect(ops).not.toContain('transactions.deleteMany');
    expect(ops).not.toContain('gnucash_web_budget_ownership.create');
  });

  it('fails closed on an unowned legacy budget collision', async () => {
    const data = minimalData();
    const incomingBudgetGuid = 'legacy-budget-collision-0000000000';
    data.budgets = [{
      id: incomingBudgetGuid,
      name: 'Unowned collision',
      numPeriods: 12,
      amounts: [],
    }];
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };
    collidingBudgetsRef.current = [{ guid: incomingBudgetGuid }];
    budgetOwnershipRef.current = [];

    await expect(
      importGnuCashData(data, 'Test Book', { overwrite: true }),
    ).rejects.toThrow('cannot be overwritten');
    expect(calls.map((call) => call.op)).not.toContain('budgets.deleteMany');
  });

  it('permits replacement when the colliding budget belongs to the same book', async () => {
    const data = minimalData();
    const incomingBudgetGuid = 'owned-budget-collision-00000000000';
    data.budgets = [{
      id: incomingBudgetGuid,
      name: 'Owned collision',
      numPeriods: 12,
      amounts: [],
    }];
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };
    collidingBudgetsRef.current = [{ guid: incomingBudgetGuid }];
    budgetOwnershipRef.current = [{
      budget_guid: incomingBudgetGuid,
      book_guid: data.book!.id,
    }];

    await expect(
      importGnuCashData(data, 'Test Book', { overwrite: true }),
    ).resolves.toMatchObject({ budgets: 1 });

    const ops = calls.map((call) => call.op);
    expect(ops).toContain('recurrences.deleteMany');
    expect(ops).toContain('budgets.deleteMany');
    expect(ops).toContain('gnucash_web_budget_ownership.create');
  });
});
