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

const tx = {
  commodities: {
    findMany: vi.fn(async () => []),
    create: record('commodities.create'),
  },
  accounts: {
    create: record('accounts.create'),
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
  },
  prices: { createMany: recordMany('prices.createMany') },
  budgets: {
    create: record('budgets.create'),
    deleteMany: vi.fn(async (args: { where: unknown }) => {
      calls.push({ op: 'budgets.deleteMany', data: args });
      return { count: 0 };
    }),
  },
  budget_amounts: { createMany: recordMany('budget_amounts.createMany') },
};

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: async (
      fn: (t: typeof tx) => Promise<void>,
      _opts?: { maxWait?: number; timeout?: number },
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

describe('importGnuCashData — orphan budget slots', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
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
  });
});

describe('importGnuCashData — re-import handling', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    tx.commodities.findMany.mockResolvedValue([]);
    existingBookRef.current = null;
  });

  it('throws BookAlreadyExistsError when the book guid exists and overwrite is off', async () => {
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };

    const { importGnuCashData: importFn, BookAlreadyExistsError } = await import('../importer');

    await expect(importFn(minimalData(), 'Test Book')).rejects.toBeInstanceOf(
      BookAlreadyExistsError,
    );
  });

  it('wipes the old book rows before re-inserting when overwrite is true', async () => {
    existingBookRef.current = { root_account_guid: 'old-root-guid-000000000000000000' };

    await importGnuCashData(minimalData(), 'Test Book', { overwrite: true });

    const ops = calls.map((c) => c.op);
    // Deletes must come before inserts.
    const firstInsertIdx = ops.findIndex((op) => op.endsWith('.create') || op.endsWith('.createMany'));
    const lastDeleteIdx = Math.max(
      ops.lastIndexOf('transactions.deleteMany'),
      ops.lastIndexOf('lots.deleteMany'),
      ops.lastIndexOf('accounts.deleteMany'),
      ops.lastIndexOf('books.deleteMany'),
    );
    expect(lastDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(lastDeleteIdx).toBeLessThan(firstInsertIdx);

    // The previously-generated root account must be deleted too.
    const oldRootDelete = calls.find(
      (c) =>
        c.op === 'accounts.deleteMany' &&
        JSON.stringify(c.data).includes('old-root-guid-000000000000000000'),
    );
    expect(oldRootDelete).toBeDefined();

    // Accounts must have their parent nulled before being removed to
    // avoid breaking the self-referential parent_guid FK.
    const nullParentIdx = ops.indexOf('accounts.updateMany');
    const accountDeleteIdx = ops.indexOf('accounts.deleteMany');
    expect(nullParentIdx).toBeGreaterThanOrEqual(0);
    expect(nullParentIdx).toBeLessThan(accountDeleteIdx);
  });
});
