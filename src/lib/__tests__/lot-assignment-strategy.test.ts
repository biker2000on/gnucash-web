/**
 * autoAssignLots — per-sale (time-correct) FIFO/LIFO replay.
 *
 * The audit finding: assignWithStrategy used to create lots for ALL buys
 * first and then run sells against one statically-sorted lot list, so a LIFO
 * sell could consume shares bought AFTER the sale date. The engine now
 * replays events chronologically — each sale sees only the lots that existed
 * at its own date — and orders transferred lots by their CARRIED
 * acquisition_date instead of the transfer date.
 *
 * These tests drive autoAssignLots end-to-end against a small in-memory fake
 * of the Prisma surface the scrub engine touches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const { db, fakePrisma, resetDb } = vi.hoisted(() => {
  interface Row { [k: string]: unknown }

  const db = {
    accounts: [] as Row[],
    transactions: [] as Row[],
    splits: [] as Row[],
    lots: [] as Row[],
    slots: [] as Row[],
    commodities: [] as Row[],
    prices: [] as Row[],
  };

  function resetDb() {
    for (const key of Object.keys(db) as Array<keyof typeof db>) db[key] = [];
  }

  function matchesWhere(row: Row, where: Row | undefined): boolean {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === 'transaction') continue; // nested relation filters unused here
      if (v === null) {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (typeof v === 'object' && typeof v !== 'bigint') {
        const cond = v as Row;
        if ('in' in cond) {
          if (!(cond.in as unknown[]).includes(row[k])) return false;
        } else if ('not' in cond) {
          if (row[k] === cond.not) return false;
        } else if ('gt' in cond) {
          if (!((row[k] as number) > (cond.gt as number))) return false;
        } else if ('lte' in cond) {
          if (!((row[k] as Date) <= (cond.lte as Date))) return false;
        } else {
          return false;
        }
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  }

  const accountByGuid = (guid: unknown) => db.accounts.find(a => a.guid === guid) ?? null;
  const txByGuid = (guid: unknown) => db.transactions.find(t => t.guid === guid) ?? null;

  function hydrateSplit(s: Row, include?: Row): Row {
    const out: Row = { ...s };
    if (include?.account || include === undefined) {
      out.account = accountByGuid(s.account_guid);
    }
    if (include?.transaction) {
      const t = txByGuid(s.tx_guid);
      const txOut: Row | null = t ? { ...t } : null;
      const txInclude = include.transaction as Row;
      const wantsSiblings =
        typeof txInclude === 'object' &&
        ((txInclude.include as Row | undefined)?.splits || (txInclude.select as Row | undefined)?.splits);
      if (txOut && wantsSiblings) {
        txOut.splits = db.splits
          .filter(x => x.tx_guid === s.tx_guid)
          .map(x => ({ ...x, account: accountByGuid(x.account_guid) }));
      }
      out.transaction = txOut;
    }
    return out;
  }

  function sortByPostDate(rows: Row[]): Row[] {
    return [...rows].sort((a, b) => {
      const ta = (txByGuid(a.tx_guid)?.post_date as Date | undefined)?.getTime() ?? 0;
      const tb = (txByGuid(b.tx_guid)?.post_date as Date | undefined)?.getTime() ?? 0;
      return ta - tb;
    });
  }

  const splitsApi = {
    findMany: async (args: Row = {}) => {
      let rows = db.splits.filter(r => matchesWhere(r, args.where as Row));
      if (args.orderBy) rows = sortByPostDate(rows);
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows.map(r => hydrateSplit(r, (args.include as Row) ?? { transaction: { select: { post_date: true } }, account: true }));
    },
    findUnique: async (args: Row) => {
      const row = db.splits.find(r => r.guid === (args.where as Row).guid);
      if (!row) return null;
      return hydrateSplit(row, (args.include as Row) ?? undefined);
    },
    create: async (args: Row) => {
      const row = { lot_guid: null, ...(args.data as Row) };
      db.splits.push(row);
      return row;
    },
    update: async (args: Row) => {
      const row = db.splits.find(r => r.guid === (args.where as Row).guid);
      if (!row) throw new Error('split not found');
      Object.assign(row, args.data as Row);
      return row;
    },
    updateMany: async (args: Row) => {
      const rows = db.splits.filter(r => matchesWhere(r, args.where as Row));
      for (const r of rows) Object.assign(r, args.data as Row);
      return { count: rows.length };
    },
    deleteMany: async (args: Row) => {
      const doomed = db.splits.filter(r => matchesWhere(r, args.where as Row));
      db.splits = db.splits.filter(r => !doomed.includes(r));
      return { count: doomed.length };
    },
  };

  const lotsApi = {
    findMany: async (args: Row = {}) => {
      const rows = db.lots.filter(r => matchesWhere(r, args.where as Row));
      return rows.map(r => ({
        ...r,
        splits: db.splits.filter(s => s.lot_guid === r.guid),
      }));
    },
    findUnique: async (args: Row) => {
      const row = db.lots.find(r => r.guid === (args.where as Row).guid);
      if (!row) return null;
      return {
        ...row,
        account: accountByGuid(row.account_guid),
        splits: db.splits
          .filter(s => s.lot_guid === row.guid)
          .map(s => ({ ...s, transaction: txByGuid(s.tx_guid) })),
      };
    },
    create: async (args: Row) => {
      db.lots.push({ ...(args.data as Row) });
      return args.data;
    },
    update: async (args: Row) => {
      const row = db.lots.find(r => r.guid === (args.where as Row).guid);
      if (!row) throw new Error('lot not found');
      Object.assign(row, args.data as Row);
      return row;
    },
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  };

  const slotsApi = {
    findFirst: async (args: Row) => {
      return db.slots.find(r => matchesWhere(r, (args.where as Row) ?? {})) ?? null;
    },
    findMany: async (args: Row = {}) => db.slots.filter(r => matchesWhere(r, args.where as Row)),
    create: async (args: Row) => {
      db.slots.push({ ...(args.data as Row) });
      return args.data;
    },
    count: async (args: Row = {}) => db.slots.filter(r => matchesWhere(r, args.where as Row)).length,
    deleteMany: async (args: Row) => {
      const doomed = db.slots.filter(r => matchesWhere(r, args.where as Row));
      db.slots = db.slots.filter(r => !doomed.includes(r));
      return { count: doomed.length };
    },
  };

  const fakePrisma = {
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx()),
    accounts: {
      findUnique: async (args: Row) => accountByGuid((args.where as Row).guid),
      findFirst: async (args: Row) => db.accounts.find(r => matchesWhere(r, args.where as Row)) ?? null,
      findMany: async (args: Row = {}) => db.accounts.filter(r => matchesWhere(r, args.where as Row)),
      create: async (args: Row) => {
        db.accounts.push({ ...(args.data as Row) });
        return args.data;
      },
    },
    transactions: {
      create: async (args: Row) => {
        db.transactions.push({ ...(args.data as Row) });
        return args.data;
      },
      findMany: async (args: Row = {}) => db.transactions.filter(r => matchesWhere(r, args.where as Row)),
      deleteMany: async () => ({ count: 0 }),
    },
    commodities: {
      findUnique: async (args: Row) => db.commodities.find(c => c.guid === (args.where as Row).guid) ?? null,
      findFirst: async (args: Row) => db.commodities.find(r => matchesWhere(r, args.where as Row)) ?? null,
      findMany: async (args: Row = {}) => db.commodities.filter(r => matchesWhere(r, args.where as Row)),
    },
    prices: {
      findFirst: async (args: Row) => db.prices.find(r => matchesWhere(r, args.where as Row)) ?? null,
    },
    books: {
      findFirst: async () => null,
    },
    splits: splitsApi,
    lots: lotsApi,
    slots: slotsApi,
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  };

  function fakeTx() {
    return fakePrisma;
  }

  return { db, fakePrisma, resetDb };
});

vi.mock('../prisma', () => ({ default: fakePrisma }));
vi.mock('../db', () => ({
  tryWithDatabaseAdvisoryLock: vi.fn(),
}));
vi.mock('../book-lock', () => ({
  BookBusyError: class BookBusyError extends Error {},
  bookLockKey: vi.fn(() => 'lock'),
  tryAcquireBookLock: vi.fn(async () => true),
}));

import { autoAssignLots } from '../lot-assignment';

const USD = 'usd-commodity';
const AAPL = 'aapl-commodity';
const STOCK_ACCT = 'stock-acct';
const CASH_ACCT = 'cash-acct';

let guidSeq = 0;
function nextGuid(prefix: string): string {
  return `${prefix}-${(guidSeq++).toString().padStart(4, '0')}`;
}

function seedBaseAccounts() {
  db.commodities.push(
    { guid: USD, namespace: 'CURRENCY', mnemonic: 'USD', fraction: 100 },
    { guid: AAPL, namespace: 'NASDAQ', mnemonic: 'AAPL', fraction: 100 },
  );
  db.accounts.push(
    { guid: 'root', name: 'Root', parent_guid: null, account_type: 'ROOT', commodity_guid: USD, commodity_scu: 100 },
    { guid: STOCK_ACCT, name: 'AAPL', parent_guid: 'root', account_type: 'STOCK', commodity_guid: AAPL, commodity_scu: 100 },
    { guid: CASH_ACCT, name: 'Cash', parent_guid: 'root', account_type: 'BANK', commodity_guid: USD, commodity_scu: 100 },
  );
}

/** Add a stock trade transaction: shares (+buy/-sell) at totalValue dollars. */
function addTrade(date: string, shares: number, totalValue: number): string {
  const txGuid = nextGuid('tx');
  db.transactions.push({ guid: txGuid, post_date: new Date(date), currency_guid: USD, description: 'trade' });
  const stockSplitGuid = nextGuid('stock-split');
  db.splits.push({
    guid: stockSplitGuid,
    tx_guid: txGuid,
    account_guid: STOCK_ACCT,
    memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
    quantity_num: BigInt(Math.round(shares * 100)),
    quantity_denom: 100n,
    value_num: BigInt(Math.round((shares > 0 ? totalValue : -totalValue) * 100)),
    value_denom: 100n,
    lot_guid: null,
  });
  db.splits.push({
    guid: nextGuid('cash-split'),
    tx_guid: txGuid,
    account_guid: CASH_ACCT,
    memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
    quantity_num: BigInt(Math.round((shares > 0 ? -totalValue : totalValue) * 100)),
    quantity_denom: 100n,
    value_num: BigInt(Math.round((shares > 0 ? -totalValue : totalValue) * 100)),
    value_denom: 100n,
    lot_guid: null,
  });
  return stockSplitGuid;
}

function lotOfSplit(splitGuid: string): string | null {
  return (db.splits.find(s => s.guid === splitGuid)?.lot_guid as string | null) ?? null;
}

function lotTitle(lotGuid: string | null): string | undefined {
  if (!lotGuid) return undefined;
  return db.slots.find(s => s.obj_guid === lotGuid && s.name === 'title')?.string_val as string | undefined;
}

beforeEach(() => {
  resetDb();
  guidSeq = 0;
  seedBaseAccounts();
});

describe('per-sale LIFO replay', () => {
  it('a LIFO sell consumes the newest lot existing AT the sell date, never later buys', async () => {
    addTrade('2024-01-01', 10, 1000);                    // buy1 -> lot "Buy 2024-01-01"
    const sellGuid = addTrade('2024-03-01', -5, 600);    // sell BETWEEN the two buys
    addTrade('2024-06-01', 10, 2000);                    // buy2 AFTER the sell

    const result = await autoAssignLots(STOCK_ACCT, 'lifo');

    expect(result.lotsCreated).toBe(2);
    // The March sell can only have consumed the January lot — the June buy
    // did not exist yet. The old static-sort implementation assigned it to
    // the June lot.
    expect(lotTitle(lotOfSplit(sellGuid))).toBe('Buy 2024-01-01');
  });

  it('a LIFO sell after the second buy consumes the newest lot', async () => {
    addTrade('2024-01-01', 10, 1000);
    addTrade('2024-06-01', 10, 2000);
    const sellGuid = addTrade('2024-07-01', -5, 1100);

    await autoAssignLots(STOCK_ACCT, 'lifo');

    expect(lotTitle(lotOfSplit(sellGuid))).toBe('Buy 2024-06-01');
  });

  it('FIFO still consumes the oldest lot', async () => {
    addTrade('2024-01-01', 10, 1000);
    addTrade('2024-06-01', 10, 2000);
    const sellGuid = addTrade('2024-07-01', -5, 1100);

    await autoAssignLots(STOCK_ACCT, 'fifo');

    expect(lotTitle(lotOfSplit(sellGuid))).toBe('Buy 2024-01-01');
  });
});

describe('FIFO ordering of transferred lots', () => {
  it('orders a transferred lot by its CARRIED acquisition_date, not the transfer date', async () => {
    // Pre-existing transfer-destination lot: shares arrived 2024-05-01 but
    // were originally acquired 2023-01-01 (acquisition_date slot).
    const xferLot = 'xfer-lot';
    db.lots.push({ guid: xferLot, account_guid: STOCK_ACCT, is_closed: 0 });
    db.slots.push(
      { obj_guid: xferLot, name: 'title', slot_type: 4, string_val: 'Transfer 2024-05-01' },
      { obj_guid: xferLot, name: 'acquisition_date', slot_type: 4, string_val: '2023-01-01T00:00:00.000Z' },
    );
    const xferTx = nextGuid('tx');
    db.transactions.push({ guid: xferTx, post_date: new Date('2024-05-01'), currency_guid: USD, description: 'transfer in' });
    db.splits.push({
      guid: nextGuid('xferin-split'),
      tx_guid: xferTx,
      account_guid: STOCK_ACCT,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      quantity_num: 1000n, quantity_denom: 100n,
      value_num: 0n, value_denom: 100n,
      lot_guid: xferLot,
    });

    // Direct buy dated AFTER the original acquisition but BEFORE the transfer
    addTrade('2024-02-01', 10, 1500);
    // Sell after everything: FIFO must consume the transferred (older) shares
    const sellGuid = addTrade('2024-06-01', -5, 800);

    await autoAssignLots(STOCK_ACCT, 'fifo');

    // Old behavior ordered the transferred lot by its earliest split date
    // (2024-05-01), placing it AFTER the 2024-02-01 buy under FIFO.
    expect(lotOfSplit(sellGuid)).toBe(xferLot);
  });
});
