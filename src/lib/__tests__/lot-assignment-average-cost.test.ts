/**
 * TRUE AVERAGE COST BASIS (ASI-1-004).
 *
 * `autoAssignLots(acct, 'average')` used to call assignFIFO and label the
 * result "fifo (average cost not implemented)": a user who elected average
 * cost silently received FIFO realized gains, and FIFO gains are a different
 * number on a filed return. These tests drive the real thing end to end —
 * autoAssignLots against an in-memory Prisma fake, then the SAME book read
 * back through the two reporting paths that produce user-facing tax figures
 * (`getAccountLots` and `lotToRealizedSales` / Form 8949) — and pin every
 * expected figure to a hand computation written out in the test.
 *
 * Where average and FIFO disagree, BOTH numbers are computed by hand and both
 * are asserted, so the difference is the assertion rather than an artifact.
 *
 * Method assumptions under test (see the JURISDICTIONAL SCOPE note in
 * lot-assignment.ts): the pool is one account's holding of one commodity;
 * basis is fee-inclusive; and shares are deemed disposed oldest-first so the
 * short/long-term split follows Treas. Reg. §1.1012-1(e)(7)(ii) even though
 * basis is pooled.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

  /** Sibling splits of a transaction, each with its account joined. */
  const siblingsOf = (txGuid: unknown) =>
    db.splits.filter(x => x.tx_guid === txGuid).map(x => ({ ...x, account: accountByGuid(x.account_guid) }));

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
      if (txOut && wantsSiblings) txOut.splits = siblingsOf(s.tx_guid);
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

  /** Lot rows shaped like the `include` getLotsForAccounts asks for. */
  const lotWithSplits = (lot: Row) => ({
    ...lot,
    splits: db.splits
      .filter(s => s.lot_guid === lot.guid)
      .map(s => {
        const t = txByGuid(s.tx_guid);
        return {
          ...s,
          transaction: t ? { ...t, splits: siblingsOf(s.tx_guid) } : null,
        };
      }),
  });

  const lotsApi = {
    findMany: async (args: Row = {}) =>
      db.lots.filter(r => matchesWhere(r, args.where as Row)).map(lotWithSplits),
    findUnique: async (args: Row) => {
      const row = db.lots.find(r => r.guid === (args.where as Row).guid);
      if (!row) return null;
      return { ...lotWithSplits(row), account: accountByGuid(row.account_guid) };
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
    findFirst: async (args: Row) => db.slots.find(r => matchesWhere(r, (args.where as Row) ?? {})) ?? null,
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
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakePrisma),
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
    prices: { findFirst: async (args: Row) => db.prices.find(r => matchesWhere(r, args.where as Row)) ?? null },
    books: { findFirst: async () => null },
    splits: splitsApi,
    lots: lotsApi,
    slots: slotsApi,
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  };

  return { db, fakePrisma, resetDb };
});

vi.mock('../prisma', () => ({ default: fakePrisma }));
vi.mock('../db', () => ({ tryWithDatabaseAdvisoryLock: vi.fn() }));
vi.mock('../book-lock', () => ({
  BookBusyError: class BookBusyError extends Error {},
  bookLockKey: vi.fn(() => 'lock'),
  tryAcquireBookLock: vi.fn(async () => true),
  // findOrCreateAccount (reached when generateCapitalGains has to create the
  // Income:Capital Gains hierarchy) guards its check-then-create with this.
  accountNameLockKey: vi.fn((parent: string, name: string) => `${parent}:${name}`),
  acquireNamedXactLock: vi.fn(async () => false),
}));
vi.mock('../commodities', () => ({ getLatestPrice: vi.fn(async () => null) }));

import { autoAssignLots } from '../lot-assignment';
import { getAccountLots, computeRealizedGain, remainingCostBasis } from '../lots';
import { loadTradeFees } from '../trade-fees';
import { lotToRealizedSales } from '../reports/capital-gains';

const USD = 'usd-commodity';
const AAPL = 'aapl-commodity';
const STOCK_ACCT = 'stock-acct';
const STOCK_ACCT_2 = 'stock-acct-2';
const CASH_ACCT = 'cash-acct';
const FEE_ACCT = 'fee-acct';

let guidSeq = 0;
const nextGuid = (prefix: string) => `${prefix}-${(guidSeq++).toString().padStart(4, '0')}`;

const qtyFrac = (shares: number) => BigInt(Math.round(shares * 100));
const cents = (dollars: number) => BigInt(Math.round(dollars * 100));

function seedBaseAccounts() {
  db.commodities.push(
    { guid: USD, namespace: 'CURRENCY', mnemonic: 'USD', fraction: 100 },
    { guid: AAPL, namespace: 'NASDAQ', mnemonic: 'AAPL', fraction: 100 },
  );
  db.accounts.push(
    { guid: 'root', name: 'Root', parent_guid: null, account_type: 'ROOT', commodity_guid: USD, commodity_scu: 100 },
    { guid: STOCK_ACCT, name: 'AAPL', parent_guid: 'root', account_type: 'STOCK', commodity_guid: AAPL, commodity_scu: 100 },
    { guid: STOCK_ACCT_2, name: 'AAPL 2', parent_guid: 'root', account_type: 'STOCK', commodity_guid: AAPL, commodity_scu: 100 },
    { guid: CASH_ACCT, name: 'Cash', parent_guid: 'root', account_type: 'BANK', commodity_guid: USD, commodity_scu: 100 },
    { guid: FEE_ACCT, name: 'Commissions', parent_guid: 'root', account_type: 'EXPENSE', commodity_guid: USD, commodity_scu: 100 },
  );
}

/**
 * One stock trade: `shares` (+buy / −sell) for `totalValue` dollars, with an
 * optional brokerage commission booked to Expenses:Commissions the way GnuCash
 * records it — a separate EXPENSE split of the same transaction.
 * Returns the stock split's GUID.
 */
function addTrade(
  date: string,
  shares: number,
  totalValue: number,
  commission = 0,
  stockAccount: string = STOCK_ACCT,
): string {
  const txGuid = nextGuid('tx');
  db.transactions.push({ guid: txGuid, post_date: new Date(date), currency_guid: USD, description: 'trade' });
  const stockSplitGuid = nextGuid('stock-split');
  const stockValue = shares > 0 ? totalValue : -totalValue;
  db.splits.push({
    guid: stockSplitGuid,
    tx_guid: txGuid,
    account_guid: stockAccount,
    memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
    quantity_num: qtyFrac(shares), quantity_denom: 100n,
    value_num: cents(stockValue), value_denom: 100n,
    lot_guid: null,
  });
  if (commission > 0) {
    db.splits.push({
      guid: nextGuid('fee-split'),
      tx_guid: txGuid,
      account_guid: FEE_ACCT,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      quantity_num: cents(commission), quantity_denom: 100n,
      value_num: cents(commission), value_denom: 100n,
      lot_guid: null,
    });
  }
  db.splits.push({
    guid: nextGuid('cash-split'),
    tx_guid: txGuid,
    account_guid: CASH_ACCT,
    memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
    quantity_num: cents(-stockValue - commission), quantity_denom: 100n,
    value_num: cents(-stockValue - commission), value_denom: 100n,
    lot_guid: null,
  });
  return stockSplitGuid;
}

/**
 * An in-kind, same-commodity move between two of the user's own accounts:
 * shares out of `from`, shares into `to`, $0 recorded value on both legs.
 * Returns { out, in } split GUIDs.
 */
function addOwnAccountTransfer(
  date: string,
  shares: number,
  from: string,
  to: string,
): { out: string; in: string } {
  const txGuid = nextGuid('tx');
  db.transactions.push({ guid: txGuid, post_date: new Date(date), currency_guid: USD, description: 'transfer' });
  const outGuid = nextGuid('xferout-split');
  const inGuid = nextGuid('xferin-split');
  for (const [guid, account, qty] of [[outGuid, from, -shares], [inGuid, to, shares]] as const) {
    db.splits.push({
      guid,
      tx_guid: txGuid,
      account_guid: account,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      quantity_num: qtyFrac(qty), quantity_denom: 100n,
      value_num: 0n, value_denom: 100n,
      lot_guid: null,
    });
  }
  return { out: outGuid, in: inGuid };
}

const lotOfSplit = (splitGuid: string): string | null =>
  (db.splits.find(s => s.guid === splitGuid)?.lot_guid as string | null) ?? null;

const slotOf = (objGuid: string | null, name: string): number | undefined => {
  if (!objGuid) return undefined;
  const raw = db.slots.find(s => s.obj_guid === objGuid && s.name === name)?.string_val as string | undefined;
  return raw === undefined ? undefined : parseFloat(raw);
};

/** Average-cost basis recorded on one disposal split. */
const avgBasisOf = (splitGuid: string) => slotOf(splitGuid, 'avg_cost_basis');

/** All generated "Realized Gain/Loss" postings, with their income account. */
function gainsPostings(): Array<{ amount: number; incomeAccount: string }> {
  return db.transactions
    .filter(t => String(t.description ?? '').startsWith('Realized '))
    .map(t => {
      const splits = db.splits.filter(s => s.tx_guid === t.guid);
      const invest = splits.find(s => s.account_guid === STOCK_ACCT)!;
      const income = splits.find(s => s.account_guid !== STOCK_ACCT)!;
      return {
        amount: Number(invest.value_num) / Number(invest.value_denom),
        incomeAccount: String(db.accounts.find(a => a.guid === income.account_guid)?.name ?? ''),
      };
    });
}

beforeEach(() => {
  resetDb();
  guidSeq = 0;
  seedBaseAccounts();
});

describe('average cost vs FIFO on identical input', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100  ($10.00/sh)
   * Buy  2024-06-01: 10 sh for $300  ($30.00/sh)
   * Sell 2024-07-01: 10 sh for $400  ($40.00/sh)
   *
   * FIFO    — the sale consumes the January lot outright:
   *           basis $100, gain 400 − 100 = $300.
   * AVERAGE — pool at the sale date is 20 sh / $400 → $20.00 per share;
   *           10 sh sold ⇒ basis $200, gain 400 − 200 = $200.
   *
   * $100 of taxable gain hangs on which method the engine actually ran.
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    return addTrade('2024-07-01', -10, 400);
  };

  it('FIFO realizes the hand-computed $300', async () => {
    seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'fifo');

    expect(result.method).toBe('fifo');
    expect(result.totalRealizedGain).toBeCloseTo(300, 6);
  });

  it('average realizes the hand-computed $200 — a different number, not FIFO', async () => {
    const sellGuid = seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.method).toBe('average');
    expect(result.totalRealizedGain).toBeCloseTo(200, 6);
    expect(result.totalRealizedGain).not.toBeCloseTo(300, 2);

    // The pooled basis of exactly the shares sold: 10 × $20.00.
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    // ...and the untouched June lot keeps the SAME per-share basis, because
    // pooling re-prices every open share, not just the ones that were sold.
    const openLot = db.lots.find(l => l.guid !== lotOfSplit(sellGuid))!.guid as string;
    expect(slotOf(openLot, 'avg_cost_basis_remaining')).toBeCloseTo(200, 6);
  });

  it('reports the average basis through the lots report and Form 8949', async () => {
    seedBook();
    await autoAssignLots(STOCK_ACCT, 'average');

    const lots = await getAccountLots(STOCK_ACCT);
    const closed = lots.find(l => l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(200, 6);
    expect(closed.totalCost).toBeCloseTo(200, 6);

    const sales = lotToRealizedSales(closed, 'AAPL');
    expect(sales).toHaveLength(1);
    expect(sales[0].proceeds).toBeCloseTo(400, 6);
    expect(sales[0].costBasis).toBeCloseTo(200, 6);

    // The still-open lot is marked to the pool average too, so unrealized
    // gain is not measured against a per-lot cost the election discarded.
    const open = lots.find(l => !l.isClosed)!;
    expect(open.averageBasisRemaining).toBeCloseTo(200, 6);
    expect(open.totalCost).toBeCloseTo(200, 6);
  });
});

describe('average cost — partial sale re-averages the pool', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100                  pool 10 sh / $100
   * Sell 2024-02-01:  4 sh for  $80  @ $10.00 basis  ⇒ basis $40, gain $40
   *                                                  pool  6 sh /  $60
   * Buy  2024-03-01: 10 sh for $200                  pool 16 sh / $260
   * Sell 2024-04-01:  8 sh for $200  @ $16.25 basis  ⇒ basis $130, gain $70
   *
   * The second sale MUST be priced at $16.25 — the average as of ITS date.
   * Pricing it from the final pool, or from the first sale's $10.00, is wrong
   * in opposite directions.
   *
   * Lot consumption is oldest-first, so the April sale takes the January lot's
   * last 6 shares (closing it) and 2 shares from the March lot.
   *   January lot: proceeds $80 + $150 = $230, basis $40 + (6 × $16.25) = $137.50
   *                ⇒ realized $92.50, which is the only gain BOOKED (the March
   *                  lot is still open and holds the other $17.50).
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100);
    const firstSell = addTrade('2024-02-01', -4, 80);
    addTrade('2024-03-01', 10, 200);
    const secondSell = addTrade('2024-04-01', -8, 200);
    return { firstSell, secondSell };
  };

  it('prices each sale at the average as of its own date', async () => {
    const { firstSell, secondSell } = seedBook();
    await autoAssignLots(STOCK_ACCT, 'average');

    // First sale: 4 × $10.00
    expect(avgBasisOf(firstSell)).toBeCloseTo(40, 6);
    // Second sale, first allocation (6 sh from the January lot): 6 × $16.25
    expect(avgBasisOf(secondSell)).toBeCloseTo(97.5, 6);
    // ...and its sub-split for the 2 shares taken from the March lot.
    const subSplit = db.splits.find(
      s => s.tx_guid === db.splits.find(x => x.guid === secondSell)!.tx_guid
        && s.guid !== secondSell
        && s.account_guid === STOCK_ACCT,
    )!.guid as string;
    expect(avgBasisOf(subSplit)).toBeCloseTo(32.5, 6);
  });

  it('books $92.50 on the closed lot and leaves the rest with the open one', async () => {
    seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.totalRealizedGain).toBeCloseTo(92.5, 6);

    const lots = await getAccountLots(STOCK_ACCT);
    const closed = lots.find(l => l.isClosed)!;
    const open = lots.find(l => !l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(92.5, 6);
    // Open lot: 8 shares left in a pool of 8 sh / $130 ⇒ $16.25 per share.
    expect(open.totalShares).toBeCloseTo(8, 6);
    expect(open.averageBasisRemaining).toBeCloseTo(130, 6);
    expect(open.realizedGain).toBeCloseTo(50 - 32.5, 6);
  });

  it('FIFO books a different number on the same book', async () => {
    seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'fifo');

    // FIFO: the January lot's 10 shares cost $100 ⇒ $10.00/sh. It sells 4 for
    // $80 and 6 for $150, so its realized gain is 230 − 100 = $130.
    expect(result.totalRealizedGain).toBeCloseTo(130, 6);
  });
});

describe('average cost — full liquidation', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100
   * Buy  2024-06-01: 10 sh for $300
   * Sell 2024-07-01: 20 sh for $500   ⇒ $25.00 per share proceeds
   *
   * Pool 20 sh / $400 ⇒ $20.00 per share. Each lot: proceeds $250, basis $200,
   * gain $50. FIFO would instead book +$150 and −$50 for the same $100 total —
   * the same aggregate, split differently across lots and (below) across
   * holding periods.
   */
  it('splits the gain evenly across both lots at the pooled basis', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    addTrade('2024-07-01', -20, 500);

    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.totalRealizedGain).toBeCloseTo(100, 6);
    const amounts = gainsPostings().map(p => p.amount).sort((a, b) => a - b);
    expect(amounts).toHaveLength(2);
    expect(amounts[0]).toBeCloseTo(50, 6);
    expect(amounts[1]).toBeCloseTo(50, 6);

    const lots = await getAccountLots(STOCK_ACCT);
    expect(lots.every(l => l.isClosed)).toBe(true);
    for (const lot of lots) expect(lot.realizedGain).toBeCloseTo(50, 6);
  });
});

describe('average cost — short vs long term', () => {
  /**
   * Buy  2023-01-01: 10 sh for $100   (held > 1 year at the sale → LONG)
   * Buy  2024-06-01: 10 sh for $300   (held < 1 year at the sale → SHORT)
   * Sell 2024-08-01: 20 sh for $600   ⇒ $30.00 per share proceeds
   *
   * Basis is POOLED ($20.00/sh) but the shares are still deemed disposed
   * oldest-first (Treas. Reg. §1.1012-1(e)(7)(ii)), so:
   *   long-term  lot: proceeds $300 − basis $200 = +$100
   *   short-term lot: proceeds $300 − basis $200 = +$100
   * FIFO on the same book books +$200 long-term and $0 short-term, so the
   * term split — not just the total — depends on the method.
   */
  it('books equal long- and short-term gains at the pooled basis', async () => {
    addTrade('2023-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    addTrade('2024-08-01', -20, 600);

    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.totalRealizedGain).toBeCloseTo(200, 6);
    const postings = gainsPostings();
    expect(postings).toHaveLength(2);
    const byTerm = Object.fromEntries(postings.map(p => [p.incomeAccount, p.amount]));
    expect(byTerm['Long Term']).toBeCloseTo(100, 6);
    expect(byTerm['Short Term']).toBeCloseTo(100, 6);
  });

  it('FIFO books the whole gain long-term on the same book', async () => {
    addTrade('2023-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    addTrade('2024-08-01', -20, 600);

    await autoAssignLots(STOCK_ACCT, 'fifo');

    const postings = gainsPostings();
    // Long-term lot: 300 − 100 = +$200. The short-term lot breaks even
    // (300 − 300) and books no entry at all.
    expect(postings).toHaveLength(1);
    expect(postings[0].incomeAccount).toBe('Long Term');
    expect(postings[0].amount).toBeCloseTo(200, 6);
  });
});

describe('average cost — a transferred lot enters the pool at its carried basis', () => {
  /**
   * Pre-existing transfer-destination lot (ASI-1-002 / ADV-H4): 10 shares that
   * arrived on 2024-05-01 at $0 recorded value, carrying $150 of original
   * basis and a 2023-01-01 acquisition date.
   *
   * Buy  2024-02-01: 10 sh for $250
   * Sell 2024-06-01: 10 sh for $400
   *
   * Pool at the sale: 20 sh / ($150 + $250) = $400 ⇒ $20.00 per share, so the
   * 10 shares sold carry $200 of basis and realize $200.
   *
   * The two ways to get this wrong are both excluded by the numbers:
   *   transferred shares entering at $0   ⇒ pool $250/20 = $12.50 ⇒ gain $275
   *   FIFO against the transferred lot    ⇒ basis $150          ⇒ gain $250
   * The carried ACQUISITION DATE also has to survive: it is what makes the
   * transferred (older) shares the ones deemed sold.
   */
  const seedTransferLot = () => {
    const xferLot = 'xfer-lot';
    db.lots.push({ guid: xferLot, account_guid: STOCK_ACCT, is_closed: 0 });
    db.slots.push(
      { obj_guid: xferLot, name: 'title', slot_type: 4, string_val: 'Transfer 2024-05-01' },
      { obj_guid: xferLot, name: 'acquisition_date', slot_type: 4, string_val: '2023-01-01T00:00:00.000Z' },
      { obj_guid: xferLot, name: 'carried_basis', slot_type: 4, string_val: '150' },
      { obj_guid: xferLot, name: 'source_lot_guid', slot_type: 4, string_val: 'source-lot-elsewhere' },
    );
    const xferTx = nextGuid('tx');
    db.transactions.push({ guid: xferTx, post_date: new Date('2024-05-01'), currency_guid: USD, description: 'transfer in' });
    db.splits.push({
      guid: nextGuid('xferin-split'),
      tx_guid: xferTx,
      account_guid: STOCK_ACCT,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      quantity_num: qtyFrac(10), quantity_denom: 100n,
      value_num: 0n, value_denom: 100n,
      lot_guid: xferLot,
    });
    return xferLot;
  };

  it('pools the carried basis, not $0 and not the lot\'s own cost', async () => {
    const xferLot = seedTransferLot();
    addTrade('2024-02-01', 10, 250);
    const sellGuid = addTrade('2024-06-01', -10, 400);

    const result = await autoAssignLots(STOCK_ACCT, 'average');

    // Carried acquisition date wins the FIFO ordering: the transferred lot is
    // the one deemed sold, and it closes.
    expect(lotOfSplit(sellGuid)).toBe(xferLot);
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    expect(result.totalRealizedGain).toBeCloseTo(200, 6);
    expect(result.totalRealizedGain).not.toBeCloseTo(275, 2); // $0-basis transfer
    expect(result.totalRealizedGain).not.toBeCloseTo(250, 2); // FIFO

    // Long-term: the CARRIED 2023-01-01 acquisition date, not the 2024-05-01
    // transfer date, decides the holding period.
    expect(gainsPostings()).toEqual([{ amount: 200, incomeAccount: 'Long Term' }]);
  });
});

describe('average cost — commissions', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100 + $10 commission ⇒ $110 into the pool
   * Buy  2024-02-01: 10 sh for $200 + $10 commission ⇒ $210 into the pool
   * Sell 2024-06-01: 10 sh for $400 +  $5 commission
   *
   * Pool 20 sh / $320 ⇒ $16.00 per share, so 10 shares sold carry $160 of
   * basis. Per IRS Pub. 550 a buy-side commission is capitalized into basis
   * (never deducted) and a sell-side commission reduces the amount realized:
   *   ledger entry (gross proceeds, as for FIFO): 400 − 160 = $240
   *   reported gain (net of the sell fee):        395 − 160 = $235
   * Ignoring commissions entirely would give 400 − 150 = $250, and FIFO with
   * commissions 400 − 110 = $290.
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100, 10);
    addTrade('2024-02-01', 10, 200, 10);
    return addTrade('2024-06-01', -10, 400, 5);
  };

  it('capitalizes buy-side commissions into the pooled basis', async () => {
    const sellGuid = seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(avgBasisOf(sellGuid)).toBeCloseTo(160, 6);
    expect(result.totalRealizedGain).toBeCloseTo(240, 6);
    expect(result.totalRealizedGain).not.toBeCloseTo(250, 2); // fees ignored
    expect(result.totalRealizedGain).not.toBeCloseTo(290, 2); // FIFO with fees
  });

  it('nets the sell-side commission off proceeds in the lots report and Form 8949', async () => {
    seedBook();
    await autoAssignLots(STOCK_ACCT, 'average');

    const lots = await getAccountLots(STOCK_ACCT, { includeTradeFees: true });
    const closed = lots.find(l => l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(235, 6);

    const fees = await loadTradeFees(closed.splits.map(s => s.txGuid));
    const sales = lotToRealizedSales(closed, 'AAPL', fees.fees);
    expect(sales).toHaveLength(1);
    expect(sales[0].proceeds).toBeCloseTo(395, 6);
    // Buy-side commissions are already inside the pooled basis and must not
    // be added a second time here.
    expect(sales[0].costBasis).toBeCloseTo(160, 6);
  });
});

describe('average cost — chronological replay', () => {
  /**
   * A sale between two buys must be priced from the pool AS OF THE SALE, never
   * from the final pool — the same requirement that makes LIFO consume only
   * lots existing at the sell date.
   *
   * Buy  2024-01-01: 10 sh for $100        pool 10 sh / $100 ⇒ $10.00/sh
   * Sell 2024-03-01:  5 sh for $150        basis 5 × $10.00 = $50
   * Buy  2024-06-01: 10 sh for $900        (irrelevant to the March sale)
   *
   * Averaging the whole book instead would give (100 + 900)/20 = $50.00/sh and
   * a $250 basis — a fabricated $200 loss on a genuinely profitable sale.
   */
  it('prices a sale from the pool at its own date, not the final pool', async () => {
    addTrade('2024-01-01', 10, 100);
    const sellGuid = addTrade('2024-03-01', -5, 150);
    addTrade('2024-06-01', 10, 900);

    await autoAssignLots(STOCK_ACCT, 'average');

    expect(avgBasisOf(sellGuid)).toBeCloseTo(50, 6);
    expect(avgBasisOf(sellGuid)).not.toBeCloseTo(250, 2);
  });
});

describe('average cost — basis travels across an own-account transfer', () => {
  /**
   * Source account:
   *   Buy 2024-01-01: 10 sh for $100
   *   Buy 2024-02-01: 10 sh for $300     pool 20 sh / $400 ⇒ $20.00/sh
   *   Transfer out 2024-03-01: 10 sh at $0 recorded value
   *     ⇒ $200 of POOLED basis leaves, and the January lot closes with NO gain
   *       booked (a transfer is not a taxable event).
   * Destination account:
   *   Sell 2024-06-01: 10 sh for $500     basis $200 ⇒ gain $300
   *
   * The destination must receive $200, not the January lot's own $100 cost
   * (which would make the sale look like a $400 gain) and not $0.
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-02-01', 10, 300);
    const transfer = addOwnAccountTransfer('2024-03-01', 10, STOCK_ACCT, STOCK_ACCT_2);
    const destSell = addTrade('2024-06-01', -10, 500, 0, STOCK_ACCT_2);
    return { transfer, destSell };
  };

  it('carries the POOLED basis to the destination lot, not the source lot\'s cost', async () => {
    const { transfer, destSell } = seedBook();

    // Source first — scrubAllAccounts orders accounts topologically for
    // exactly this reason: the destination reads what the source recorded.
    const source = await autoAssignLots(STOCK_ACCT, 'average');
    expect(avgBasisOf(transfer.out)).toBeCloseTo(200, 6);
    // A transfer-out books nothing, even though it closed the January lot.
    expect(source.totalRealizedGain).toBeCloseTo(0, 6);
    expect(gainsPostings()).toHaveLength(0);

    const dest = await autoAssignLots(STOCK_ACCT_2, 'average');
    const destLot = lotOfSplit(transfer.in);
    expect(slotOf(destLot, 'carried_basis')).toBeCloseTo(200, 6);

    expect(avgBasisOf(destSell)).toBeCloseTo(200, 6);
    expect(dest.totalRealizedGain).toBeCloseTo(300, 6);
    expect(dest.totalRealizedGain).not.toBeCloseTo(400, 2); // source lot's own $100
    expect(dest.totalRealizedGain).not.toBeCloseTo(500, 2); // transferred in at $0
  });
});

describe('shared basis helpers (pure)', () => {
  it('computeRealizedGain nets only SELL-side fees off a pooled basis', () => {
    // 10 shares disposed for $400 gross with a $5 sell commission, pooled
    // basis $160 (which already contains the buy-side commissions).
    // Gain = (400 − 5) − 160 = $235. Re-adding a buy fee would give $225.
    const gain = computeRealizedGain(
      [
        { guid: 'buy', shares: 10, value: 100 },
        { guid: 'sell', shares: -10, value: -400, avgCostBasis: 160 },
      ],
      true,
      0,
      new Set(),
      new Map([['buy', 10], ['sell', 5]]),
    );
    expect(gain).toBeCloseTo(235, 6);
  });

  it('computeRealizedGain ignores carriedBasis once a disposal is pooled', () => {
    // carried_basis is already inside the pooled figure; adding it here would
    // subtract the transferred shares' basis twice.
    const gain = computeRealizedGain(
      [
        { guid: 'in', shares: 10, value: 0 },
        { guid: 'sell', shares: -10, value: -400, avgCostBasis: 200 },
      ],
      true,
      150,
    );
    expect(gain).toBeCloseTo(200, 6);
  });

  it('remainingCostBasis uses the recorded pool basis, not a pro-rata of totalCost', () => {
    // A lot bought 10 shares and disposed of 5 across two sales priced at
    // different pool averages ($10 then $30), leaving 5 shares worth $150 at
    // the final average. totalCost = 150 + 20 + 90 = $260, so pro-rating
    // would say 260 × 5/10 = $130 — $20 short.
    const lot = {
      averageBasisRemaining: 150,
      totalShares: 5,
      totalCost: 260,
      splits: [
        { shares: 10, value: 100 },
        { shares: -2, value: -60 },
        { shares: -3, value: -120 },
      ],
    } as unknown as Parameters<typeof remainingCostBasis>[0];
    expect(remainingCostBasis(lot)).toBeCloseTo(150, 6);

    const withoutPool = { ...lot, averageBasisRemaining: null };
    expect(remainingCostBasis(withoutPool)).toBeCloseTo(130, 6);
  });
});

describe('average-cost artifacts are removed when the election changes', () => {
  it('a FIFO re-scrub drops the average basis so nothing reports a stale pool', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    const sellGuid = addTrade('2024-07-01', -10, 400);

    await autoAssignLots(STOCK_ACCT, 'average');
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);

    // Re-scrub the same account under FIFO without clearing first.
    await autoAssignLots(STOCK_ACCT, 'fifo');

    expect(avgBasisOf(sellGuid)).toBeUndefined();
    expect(db.slots.some(s => s.name === 'avg_cost_basis')).toBe(false);
    expect(db.slots.some(s => s.name === 'avg_cost_basis_remaining')).toBe(false);

    // ...and the lots report falls straight back to per-lot FIFO basis.
    const lots = await getAccountLots(STOCK_ACCT);
    const closed = lots.find(l => l.isClosed)!;
    expect(closed.averageBasisRemaining ?? null).toBeNull();
    expect(closed.splits.every(s => s.avgCostBasis === undefined)).toBe(true);
  });
});
