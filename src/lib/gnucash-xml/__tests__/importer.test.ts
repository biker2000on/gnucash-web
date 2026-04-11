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

const tx = {
  commodities: {
    findMany: vi.fn(async () => []),
    create: record('commodities.create'),
  },
  accounts: {
    create: record('accounts.create'),
  },
  books: {
    create: record('books.create'),
  },
  lots: {
    createMany: recordMany('lots.createMany'),
  },
  transactions: {
    createMany: recordMany('transactions.createMany'),
  },
  splits: {
    createMany: recordMany('splits.createMany'),
  },
  prices: { createMany: recordMany('prices.createMany') },
  budgets: { create: record('budgets.create') },
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
