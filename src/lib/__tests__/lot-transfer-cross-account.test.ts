/**
 * Cross-Account Lot Transfer & Cost Basis Tests
 *
 * End-to-end validation of cross-account lot scrubbing and cost-basis
 * carry-over using an in-memory fake Prisma database, covering:
 *  - Full transfer A -> B, sell all in B (basis + holding period carry)
 *  - Partial transfer with sells in both accounts (no double counting)
 *  - Chained transfers A -> B -> C
 *  - Multi-lot transfers with FIFO/LIFO/average allocation
 *  - scrubAllAccounts topological ordering
 *  - Transfer metadata (source_lot_guid, acquisition_date, original_* slots)
 *  - revertScrubRun cross-run safety
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fake Prisma
// ---------------------------------------------------------------------------

type Rec = Record<string, any>;

function eqVal(a: any, b: any): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    try { return BigInt(a) === BigInt(b); } catch { return false; }
  }
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return a === b;
}

function cmpVal(a: any, b: any): number {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = BigInt(a); const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchCond(value: any, cond: any): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    if ('in' in cond && !(cond.in as any[]).some(x => eqVal(value, x))) return false;
    if ('not' in cond) {
      if (cond.not === null) { if (value === null) return false; }
      else if (eqVal(value, cond.not)) return false;
    }
    if ('gt' in cond && !(value !== null && cmpVal(value, cond.gt) > 0)) return false;
    if ('gte' in cond && !(value !== null && cmpVal(value, cond.gte) >= 0)) return false;
    if ('lt' in cond && !(value !== null && cmpVal(value, cond.lt) < 0)) return false;
    if ('lte' in cond && !(value !== null && cmpVal(value, cond.lte) <= 0)) return false;
    return true;
  }
  return eqVal(value, cond);
}

/** Extract the nested relation spec from an include/select entry */
function subSpec(v: any): Rec {
  if (v === true) return {};
  return (v?.include ?? v?.select ?? {}) as Rec;
}

class FakePrisma {
  t = {
    accounts: [] as Rec[],
    transactions: [] as Rec[],
    splits: [] as Rec[],
    lots: [] as Rec[],
    slots: [] as Rec[],
    books: [] as Rec[],
    commodities: [] as Rec[],
  };

  private txOf(s: Rec): Rec | null {
    return this.t.transactions.find(x => x.guid === s.tx_guid) ?? null;
  }
  private acctByGuid(guid: string | null): Rec | null {
    if (!guid) return null;
    return this.t.accounts.find(a => a.guid === guid) ?? null;
  }
  private splitsOfTx(guid: string): Rec[] {
    return this.t.splits.filter(s => s.tx_guid === guid);
  }
  private splitsOfLot(guid: string): Rec[] {
    return this.t.splits.filter(s => s.lot_guid === guid);
  }

  private matchPlain(rec: Rec, where: Rec): boolean {
    for (const [k, cond] of Object.entries(where ?? {})) {
      if (!matchCond(rec[k], cond)) return false;
    }
    return true;
  }

  private matchSplit(rec: Rec, where: Rec): boolean {
    for (const [k, cond] of Object.entries(where ?? {})) {
      if (k === 'transaction') {
        const tr = this.txOf(rec);
        if (!tr || !this.matchPlain(tr, cond as Rec)) return false;
      } else if (k === 'account') {
        const a = this.acctByGuid(rec.account_guid);
        if (!a || !this.matchPlain(a, cond as Rec)) return false;
      } else if (!matchCond(rec[k], cond)) {
        return false;
      }
    }
    return true;
  }

  private hydrateSplit(rec: Rec, spec: Rec): Rec {
    const out: Rec = { ...rec };
    if (spec.transaction) {
      const tr = this.txOf(rec);
      out.transaction = tr ? this.hydrateTx(tr, subSpec(spec.transaction)) : null;
    }
    if (spec.account) {
      const a = this.acctByGuid(rec.account_guid);
      out.account = a ? { ...a } : null;
    }
    return out;
  }

  private hydrateTx(rec: Rec, spec: Rec): Rec {
    const out: Rec = { ...rec };
    if (spec.splits) {
      out.splits = this.splitsOfTx(rec.guid).map(s => this.hydrateSplit(s, subSpec(spec.splits)));
    }
    return out;
  }

  private hydrateLot(rec: Rec, spec: Rec): Rec {
    const out: Rec = { ...rec };
    if (spec.splits) {
      out.splits = this.splitsOfLot(rec.guid).map(s => this.hydrateSplit(s, subSpec(spec.splits)));
    }
    if (spec.account) {
      const a = this.acctByGuid(rec.account_guid);
      out.account = a ? { ...a } : null;
    }
    if (spec._count) {
      out._count = { splits: this.splitsOfLot(rec.guid).length };
    }
    return out;
  }

  private sortSplits(list: Rec[], orderBy: any): Rec[] {
    if (!orderBy) return list;
    const dir = orderBy?.transaction?.post_date === 'desc' ? -1 : 1;
    if (orderBy?.transaction?.post_date) {
      return [...list].sort((a, b) => {
        const ta = this.txOf(a)?.post_date?.getTime?.() ?? 0;
        const tb = this.txOf(b)?.post_date?.getTime?.() ?? 0;
        return (ta - tb) * dir;
      });
    }
    return list;
  }

  splits = {
    findMany: async (args: Rec = {}) => {
      let list = this.t.splits.filter(s => this.matchSplit(s, args.where ?? {}));
      list = this.sortSplits(list, args.orderBy);
      if (typeof args.take === 'number') list = list.slice(0, args.take);
      const spec = (args.include ?? args.select ?? {}) as Rec;
      return list.map(s => this.hydrateSplit(s, spec));
    },
    findUnique: async (args: Rec) => {
      const s = this.t.splits.find(x => x.guid === args.where.guid);
      if (!s) return null;
      const spec = (args.include ?? args.select ?? {}) as Rec;
      return this.hydrateSplit(s, spec);
    },
    create: async (args: Rec) => {
      const rec: Rec = { lot_guid: null, reconcile_date: null, memo: '', action: '', ...args.data };
      this.t.splits.push(rec);
      return { ...rec };
    },
    update: async (args: Rec) => {
      const s = this.t.splits.find(x => x.guid === args.where.guid);
      if (!s) throw new Error(`splits.update: record not found: ${args.where.guid}`);
      Object.assign(s, args.data);
      return { ...s };
    },
    updateMany: async (args: Rec) => {
      const list = this.t.splits.filter(s => this.matchSplit(s, args.where ?? {}));
      for (const s of list) Object.assign(s, args.data);
      return { count: list.length };
    },
    deleteMany: async (args: Rec) => {
      const before = this.t.splits.length;
      this.t.splits = this.t.splits.filter(s => !this.matchSplit(s, args.where ?? {}));
      return { count: before - this.t.splits.length };
    },
  };

  lots = {
    findMany: async (args: Rec = {}) => {
      const list = this.t.lots.filter(l => this.matchPlain(l, args.where ?? {}));
      const spec = (args.include ?? args.select ?? {}) as Rec;
      return list.map(l => this.hydrateLot(l, spec));
    },
    findUnique: async (args: Rec) => {
      const l = this.t.lots.find(x => x.guid === args.where.guid);
      if (!l) return null;
      const spec = (args.include ?? args.select ?? {}) as Rec;
      return this.hydrateLot(l, spec);
    },
    create: async (args: Rec) => {
      const rec: Rec = { ...args.data };
      this.t.lots.push(rec);
      return { ...rec };
    },
    update: async (args: Rec) => {
      const l = this.t.lots.find(x => x.guid === args.where.guid);
      if (!l) throw new Error(`lots.update: record not found: ${args.where.guid}`);
      Object.assign(l, args.data);
      return { ...l };
    },
    updateMany: async (args: Rec) => {
      const list = this.t.lots.filter(l => this.matchPlain(l, args.where ?? {}));
      for (const l of list) Object.assign(l, args.data);
      return { count: list.length };
    },
    deleteMany: async (args: Rec) => {
      const before = this.t.lots.length;
      this.t.lots = this.t.lots.filter(l => !this.matchPlain(l, args.where ?? {}));
      return { count: before - this.t.lots.length };
    },
  };

  slots = {
    findFirst: async (args: Rec) => {
      const s = this.t.slots.find(x => this.matchPlain(x, args.where ?? {}));
      return s ? { ...s } : null;
    },
    findMany: async (args: Rec = {}) => {
      return this.t.slots.filter(s => this.matchPlain(s, args.where ?? {})).map(s => ({ ...s }));
    },
    create: async (args: Rec) => {
      const rec: Rec = { ...args.data };
      this.t.slots.push(rec);
      return { ...rec };
    },
    count: async (args: Rec = {}) => {
      return this.t.slots.filter(s => this.matchPlain(s, args.where ?? {})).length;
    },
    deleteMany: async (args: Rec) => {
      const before = this.t.slots.length;
      this.t.slots = this.t.slots.filter(s => !this.matchPlain(s, args.where ?? {}));
      return { count: before - this.t.slots.length };
    },
  };

  accounts = {
    findUnique: async (args: Rec) => {
      const a = this.t.accounts.find(x => x.guid === args.where.guid);
      return a ? { ...a } : null;
    },
    findFirst: async (args: Rec) => {
      const a = this.t.accounts.find(x => this.matchPlain(x, args.where ?? {}));
      return a ? { ...a } : null;
    },
    findMany: async (args: Rec = {}) => {
      return this.t.accounts.filter(a => this.matchPlain(a, args.where ?? {})).map(a => ({ ...a }));
    },
    create: async (args: Rec) => {
      const rec: Rec = { ...args.data };
      this.t.accounts.push(rec);
      return { ...rec };
    },
  };

  books = {
    findFirst: async () => {
      const b = this.t.books[0];
      return b ? { ...b } : null;
    },
  };

  commodities = {
    findUnique: async (args: Rec) => {
      const c = this.t.commodities.find(x => x.guid === args.where.guid);
      return c ? { ...c } : null;
    },
    findMany: async (args: Rec = {}) => {
      return this.t.commodities.filter(c => this.matchPlain(c, args.where ?? {})).map(c => ({ ...c }));
    },
  };

  transactions = {
    create: async (args: Rec) => {
      const rec: Rec = { ...args.data };
      this.t.transactions.push(rec);
      return { ...rec };
    },
    findMany: async (args: Rec = {}) => {
      return this.t.transactions.filter(x => this.matchPlain(x, args.where ?? {})).map(x => ({ ...x }));
    },
    deleteMany: async (args: Rec) => {
      const before = this.t.transactions.length;
      this.t.transactions = this.t.transactions.filter(x => !this.matchPlain(x, args.where ?? {}));
      return { count: before - this.t.transactions.length };
    },
  };

  $transaction = async (fn: any) => {
    return fn(this);
  };
}

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../prisma', () => ({
  default: new Proxy({}, {
    get: (_t, prop) => {
      const db = (dbHolder as { current: any }).current;
      if (!db) throw new Error('Fake prisma not initialized');
      const v = db[prop as string];
      return typeof v === 'function' ? v.bind(db) : v;
    },
  }),
}));

vi.mock('../commodities', () => ({
  getLatestPrice: vi.fn().mockResolvedValue(null),
}));

import { autoAssignLots, scrubAllAccounts, revertScrubRun } from '../lot-assignment';
import { traceCostBasis, createCostBasisCache } from '../cost-basis';
import { getAccountLots } from '../lots';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const USD = 'usd-commodity-000000000000000000';
const AAPL = 'aapl-commodity-00000000000000000';
const ROOT = 'root-acct-guid-00000000000000000';
const ASSETS = 'assets-acct-guid-000000000000000';
const CASH = 'cash-acct-guid-00000000000000000';
const STOCK_A = 'stock-a-acct-guid-00000000000000';
const STOCK_B = 'stock-b-acct-guid-00000000000000';
const STOCK_C = 'stock-c-acct-guid-00000000000000';

function acct(guid: string, name: string, type: string, parent: string | null, commodity: string): Rec {
  return {
    guid, name, account_type: type, parent_guid: parent,
    commodity_guid: commodity, commodity_scu: 100, non_std_scu: 0,
    hidden: 0, placeholder: 0, code: '', description: '',
  };
}

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  (dbHolder as { current: any }).current = db;
});

/** Seed root/assets/cash and one STOCK account per letter, in the given order. */
function seedBase(stockOrder: string[]) {
  db.t.books.push({ guid: 'book-1', root_account_guid: ROOT });
  db.t.commodities.push(
    { guid: USD, namespace: 'CURRENCY', mnemonic: 'USD', fraction: 100, quote_flag: 0 },
    { guid: AAPL, namespace: 'NASDAQ', mnemonic: 'AAPL', fraction: 10000, quote_flag: 1 },
  );
  db.t.accounts.push(
    acct(ROOT, 'Root Account', 'ROOT', null, USD),
    acct(ASSETS, 'Assets', 'ASSET', ROOT, USD),
    acct(CASH, 'Cash', 'BANK', ASSETS, USD),
  );
  const stockGuids: Record<string, string> = { A: STOCK_A, B: STOCK_B, C: STOCK_C };
  for (const s of stockOrder) {
    const broker = `brok-${s.toLowerCase()}-acct-guid-000000000000`;
    db.t.accounts.push(
      acct(broker, `Brokerage ${s}`, 'ASSET', ASSETS, USD),
      acct(stockGuids[s], 'AAPL', 'STOCK', broker, AAPL),
    );
  }
}

/**
 * Add a balanced transaction. Splits: [splitGuid, accountGuid, qty, value].
 * NATIVE GnuCash sign convention (value follows the debit/credit of the
 * account in transaction currency):
 * buy = stock value positive (debit), cash negative;
 * sell/transfer-out = stock value negative (credit), cash positive;
 * transfer-in = value positive (mirrors the out-split so the tx balances).
 */
function addTx(guid: string, date: string, splits: Array<[string, string, number, number]>) {
  db.t.transactions.push({
    guid, currency_guid: USD, num: '',
    post_date: new Date(date), enter_date: new Date(date), description: guid,
  });
  for (const [sg, acctGuid, qty, val] of splits) {
    db.t.splits.push({
      guid: sg, tx_guid: guid, account_guid: acctGuid,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      value_num: BigInt(Math.round(val * 100)), value_denom: 100n,
      quantity_num: BigInt(Math.round(qty * 100)), quantity_denom: 100n,
      lot_guid: null,
    });
  }
}

/** Buy 100 @ $10 in A (2022), transfer ALL 100 to B (2024-06), sell all in B @ $15 (2024-11). */
function seedFullTransfer() {
  seedBase(['A', 'B']);
  addTx('tx-buy', '2022-01-10', [
    ['a-buy', STOCK_A, 100, 1000],
    ['a-buy-cash', CASH, -1000, -1000],
  ]);
  addTx('tx-xfer', '2024-06-15', [
    ['a-out', STOCK_A, -100, -1000],
    ['b-in', STOCK_B, 100, 1000],
  ]);
  addTx('tx-sell', '2024-11-02', [
    ['b-sell', STOCK_B, -100, -1500],
    ['b-sell-cash', CASH, 1500, 1500],
  ]);
}

/** Buy 100 @ $10 in A, transfer 60 to B, sell 40 in A @ $12, sell 60 in B @ $12. */
function seedPartialTransfer() {
  seedBase(['A', 'B']);
  addTx('tx-buy', '2023-01-05', [
    ['a-buy', STOCK_A, 100, 1000],
    ['a-buy-cash', CASH, -1000, -1000],
  ]);
  addTx('tx-xfer', '2024-01-10', [
    ['a-out', STOCK_A, -60, -600],
    ['b-in', STOCK_B, 60, 600],
  ]);
  addTx('tx-sell-a', '2024-02-15', [
    ['a-sell', STOCK_A, -40, -480],
    ['a-sell-cash', CASH, 480, 480],
  ]);
  addTx('tx-sell-b', '2024-03-20', [
    ['b-sell', STOCK_B, -60, -720],
    ['b-sell-cash', CASH, 720, 720],
  ]);
}

/** Buy 50 @ $10 in A, chain-transfer A -> B -> C, sell all 50 in C @ $20. */
function seedChain() {
  // Insert stock accounts in C,B,A order so a naive scrub order would be wrong.
  seedBase(['C', 'B', 'A']);
  addTx('tx-buy', '2022-03-01', [
    ['a-buy', STOCK_A, 50, 500],
    ['a-buy-cash', CASH, -500, -500],
  ]);
  addTx('tx-ab', '2023-05-01', [
    ['a-out', STOCK_A, -50, -500],
    ['b-in', STOCK_B, 50, 500],
  ]);
  addTx('tx-bc', '2024-04-01', [
    ['b-out', STOCK_B, -50, -500],
    ['c-in', STOCK_C, 50, 500],
  ]);
  addTx('tx-sell', '2024-09-01', [
    ['c-sell', STOCK_C, -50, -1000],
    ['c-sell-cash', CASH, 1000, 1000],
  ]);
}

/** Two buys in A (100 @ $10 in Jan, 100 @ $20 in Jun), then transfer qty shares to B. */
function seedTwoLots(transferQty: number, transferVal: number) {
  seedBase(['A', 'B']);
  addTx('tx-buy1', '2023-01-05', [
    ['d-buy1', STOCK_A, 100, 1000],
    ['d-buy1-cash', CASH, -1000, -1000],
  ]);
  addTx('tx-buy2', '2023-06-05', [
    ['d-buy2', STOCK_A, 100, 2000],
    ['d-buy2-cash', CASH, -2000, -2000],
  ]);
  addTx('tx-xfer', '2024-05-01', [
    ['d-out', STOCK_A, -transferQty, -transferVal],
    ['d-in', STOCK_B, transferQty, transferVal],
  ]);
}

// -- Small query helpers over the fake DB -----------------------------------

function split(guid: string): Rec {
  const s = db.t.splits.find(x => x.guid === guid);
  if (!s) throw new Error(`split not found: ${guid}`);
  return s;
}

function slotVal(objGuid: string, name: string): string | null {
  return db.t.slots.find(s => s.obj_guid === objGuid && s.name === name)?.string_val ?? null;
}

function lotsOf(accountGuid: string): Rec[] {
  return db.t.lots.filter(l => l.account_guid === accountGuid);
}

function lotShares(lotGuid: string): number {
  return db.t.splits
    .filter(s => s.lot_guid === lotGuid)
    .reduce((sum, s) => sum + Number(s.quantity_num) / Number(s.quantity_denom), 0);
}

// ---------------------------------------------------------------------------
// Cross-account scrub flows
// ---------------------------------------------------------------------------

describe('cross-account lot scrubbing', () => {
  it('full transfer A->B then sell all in B: gain uses A purchase basis, long-term via acquisition_date', async () => {
    seedFullTransfer();

    const resA = await autoAssignLots(STOCK_A, 'fifo');
    // A: buy lot created, transfer-out closes it at basis => zero realized gain in A
    expect(resA.lotsCreated).toBe(1);
    expect(resA.totalRealizedGain).toBeCloseTo(0);

    const resB = await autoAssignLots(STOCK_B, 'fifo');
    expect(resB.lotsCreated).toBe(1);
    expect(resB.gainsTransactions).toBe(1);
    // Gain = proceeds 1500 - original basis 1000 = 500 (not 1500!)
    expect(resB.totalRealizedGain).toBeCloseTo(500);

    // Destination lot metadata links back to the source lot
    const aLot = split('a-buy').lot_guid as string;
    const bLot = split('b-in').lot_guid as string;
    expect(aLot).toBeTruthy();
    expect(bLot).toBeTruthy();
    expect(slotVal(bLot, 'source_lot_guid')).toBe(aLot);
    // Acquisition date carries the ORIGINAL purchase date (2022), not the transfer date
    expect(slotVal(bLot, 'acquisition_date')).toBe('2022-01-10T00:00:00.000Z');

    // Holding period spans from original purchase => Long Term gains account used.
    // A $500 gain CREDITS the income account: value -50000n (native signs).
    const ltAccount = db.t.accounts.find(a => a.name === 'Long Term');
    expect(ltAccount).toBeDefined();
    const gainSplits = db.t.splits.filter(
      s => s.account_guid === ltAccount!.guid && s.value_num === -50000n,
    );
    expect(gainSplits).toHaveLength(1);

    // Both lots closed
    expect(db.t.lots.find(l => l.guid === aLot)?.is_closed).toBe(1);
    expect(db.t.lots.find(l => l.guid === bLot)?.is_closed).toBe(1);
  });

  it('partial transfer (60 of 100): sells in both A and B split basis without double counting', async () => {
    seedPartialTransfer();

    const resA = await autoAssignLots(STOCK_A, 'fifo');
    // A lot: buy +1000, transfer-out -600, sell -480 => gain 80 (40 sh x $2)
    expect(resA.totalRealizedGain).toBeCloseTo(80);
    expect(resA.gainsTransactions).toBe(1);

    const resB = await autoAssignLots(STOCK_B, 'fifo');
    // B lot: transfer-in +600, sell -720 => gain 120 (60 sh x $2)
    expect(resB.totalRealizedGain).toBeCloseTo(120);
    expect(resB.gainsTransactions).toBe(1);

    // Total across both accounts = 100 sh x $2 = 200, no double counting
    expect(resA.totalRealizedGain + resB.totalRealizedGain).toBeCloseTo(200);

    // Metadata: dest lot points to source lot, acquisition date = original buy
    const bLot = split('b-in').lot_guid as string;
    expect(slotVal(bLot, 'source_lot_guid')).toBe(split('a-buy').lot_guid);
    expect(slotVal(bLot, 'acquisition_date')).toBe('2023-01-05T00:00:00.000Z');
  });

  it('chained transfer A->B->C via scrubAllAccounts: topological order and basis trace to origin', async () => {
    seedChain();

    // Pass account guids dest-first; account table is also seeded C,B,A.
    const { results, order } = await scrubAllAccounts(
      'fifo',
      [STOCK_C, STOCK_B, STOCK_A, CASH, ASSETS],
    );

    // Source must be scrubbed before destination all the way down the chain
    expect(order.indexOf(STOCK_A)).toBeLessThan(order.indexOf(STOCK_B));
    expect(order.indexOf(STOCK_B)).toBeLessThan(order.indexOf(STOCK_C));

    // Transfers at basis: A and B realize 0; C realizes 1000 - 500 = 500
    const total = results.reduce((s, r) => s + r.totalRealizedGain, 0);
    expect(total).toBeCloseTo(500);

    const cLot = split('c-in').lot_guid as string;
    const bLot = split('b-in').lot_guid as string;
    const aLot = split('a-buy').lot_guid as string;
    // Chain metadata: C's lot links to B's, B's to A's
    expect(slotVal(cLot, 'source_lot_guid')).toBe(bLot);
    expect(slotVal(bLot, 'source_lot_guid')).toBe(aLot);
    // Acquisition date propagates through the whole chain
    expect(slotVal(bLot, 'acquisition_date')).toBe('2022-03-01T00:00:00.000Z');
    expect(slotVal(cLot, 'acquisition_date')).toBe('2022-03-01T00:00:00.000Z');
  });

  it('FIFO: transfer spanning two source lots creates per-source dest lots (earliest lot first)', async () => {
    seedTwoLots(150, 2000);

    await autoAssignLots(STOCK_A, 'fifo');
    const lot1 = split('d-buy1').lot_guid as string; // Jan buy
    const lot2 = split('d-buy2').lot_guid as string; // Jun buy
    expect(lot1).toBeTruthy();
    expect(lot2).toBeTruthy();
    expect(lot1).not.toBe(lot2);

    // FIFO: transfer-out consumes lot1 fully (100), then 50 from lot2
    expect(split('d-out').lot_guid).toBe(lot1);
    expect(split('d-out').quantity_num).toBe(-10000n);
    const aSub = db.t.splits.find(
      s => s.account_guid === STOCK_A && s.lot_guid === lot2 && s.quantity_num === -5000n,
    );
    expect(aSub).toBeDefined();
    // Original quantity saved for revert
    expect(slotVal('d-out', 'original_quantity_num')).toBe('-15000');

    await autoAssignLots(STOCK_B, 'fifo');
    const bLots = lotsOf(STOCK_B);
    expect(bLots).toHaveLength(2);
    const bySource = new Map(bLots.map(l => [slotVal(l.guid, 'source_lot_guid'), l.guid]));
    expect(lotShares(bySource.get(lot1)!)).toBeCloseTo(100);
    expect(lotShares(bySource.get(lot2)!)).toBeCloseTo(50);
    // Transfer-in was sub-split and its original quantity saved
    expect(split('d-in').quantity_num).toBe(10000n);
    expect(slotVal('d-in', 'original_quantity_num')).toBe('15000');
    // Acquisition dates per dest lot match each source lot's buy date
    expect(slotVal(bySource.get(lot1)!, 'acquisition_date')).toBe('2023-01-05T00:00:00.000Z');
    expect(slotVal(bySource.get(lot2)!, 'acquisition_date')).toBe('2023-06-05T00:00:00.000Z');
  });

  it('LIFO: transfer spanning two source lots consumes latest lot first', async () => {
    seedTwoLots(150, 2500);

    await autoAssignLots(STOCK_A, 'lifo');
    const lot1 = split('d-buy1').lot_guid as string;
    const lot2 = split('d-buy2').lot_guid as string;

    // LIFO: transfer-out consumes lot2 fully (100), then 50 from lot1
    expect(split('d-out').lot_guid).toBe(lot2);
    expect(split('d-out').quantity_num).toBe(-10000n);
    const aSub = db.t.splits.find(
      s => s.account_guid === STOCK_A && s.lot_guid === lot1 && s.quantity_num === -5000n,
    );
    expect(aSub).toBeDefined();

    await autoAssignLots(STOCK_B, 'lifo');
    const bLots = lotsOf(STOCK_B);
    expect(bLots).toHaveLength(2);
    const bySource = new Map(bLots.map(l => [slotVal(l.guid, 'source_lot_guid'), l.guid]));
    expect(lotShares(bySource.get(lot2)!)).toBeCloseTo(100);
    expect(lotShares(bySource.get(lot1)!)).toBeCloseTo(50);
  });

  it('revertScrubRun: reverting the destination run leaves the source account intact, then reverting the source restores everything', async () => {
    seedTwoLots(150, 2000);
    const seededTxCount = db.t.transactions.length;
    const seededSplitCount = db.t.splits.length;

    const resA = await autoAssignLots(STOCK_A, 'fifo');
    const resB = await autoAssignLots(STOCK_B, 'fifo');
    const aSplitCountAfterScrub = db.t.splits.filter(s => s.account_guid === STOCK_A).length;

    // --- Revert B's run only ---
    await revertScrubRun(resB.runId);

    // B: transfer-in restored to a single split with the original quantity
    expect(db.t.splits.filter(s => s.account_guid === STOCK_B)).toHaveLength(1);
    expect(split('d-in').quantity_num).toBe(15000n);
    expect(split('d-in').value_num).toBe(200000n);
    expect(split('d-in').lot_guid).toBeNull();
    expect(lotsOf(STOCK_B)).toHaveLength(0);

    // A: completely untouched by B's revert
    expect(db.t.splits.filter(s => s.account_guid === STOCK_A)).toHaveLength(aSplitCountAfterScrub);
    expect(split('d-out').quantity_num).toBe(-10000n); // still sub-split
    expect(split('d-out').lot_guid).not.toBeNull();
    expect(lotsOf(STOCK_A).length).toBeGreaterThan(0);
    expect(slotVal('d-out', 'original_quantity_num')).toBe('-15000');

    // --- Revert A's run ---
    await revertScrubRun(resA.runId);

    expect(split('d-out').quantity_num).toBe(-15000n);
    expect(split('d-out').value_num).toBe(-200000n);
    expect(split('d-out').lot_guid).toBeNull();
    expect(lotsOf(STOCK_A)).toHaveLength(0);
    // Gains transactions removed, split/tx counts back to the seeded state
    expect(db.t.transactions).toHaveLength(seededTxCount);
    expect(db.t.splits).toHaveLength(seededSplitCount);
    expect(db.t.splits.every(s => s.lot_guid === null)).toBe(true);
    // No leftover scrub metadata
    const leftover = db.t.slots.filter(s =>
      s.name === 'gnucash_web_generated' || s.name.startsWith('original_'),
    );
    expect(leftover).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cost basis tracing (no lots assigned)
// ---------------------------------------------------------------------------

describe('traceCostBasis across accounts (unscrubbed)', () => {
  it('partial transfer FIFO: transferred shares carry the original purchase basis (no self-consumption)', async () => {
    seedPartialTransfer();

    // 60 shares transferred out of a 100 @ $10 lot => basis $600, NOT $400
    // ($400 would mean the transfer-out itself was double-counted as a prior sale)
    const result = await traceCostBasis('b-in', 'fifo', AAPL, 60, createCostBasisCache());
    expect(result.totalCost).toBeCloseTo(600);
    expect(result.perShareCost).toBeCloseTo(10);
    expect(result.tracedFromAccount).toBe('AAPL');
  });

  it('two source lots: FIFO / LIFO / average allocate destination basis per method', async () => {
    // Transfer 100 of 200 shares (100 @ $10 then 100 @ $20)
    seedTwoLots(100, 1500);

    const fifo = await traceCostBasis('d-in', 'fifo', AAPL, 100, createCostBasisCache());
    expect(fifo.totalCost).toBeCloseTo(1000); // earliest lot: 100 @ $10

    const lifo = await traceCostBasis('d-in', 'lifo', AAPL, 100, createCostBasisCache());
    expect(lifo.totalCost).toBeCloseTo(2000); // latest lot: 100 @ $20

    const avg = await traceCostBasis('d-in', 'average', AAPL, 100, createCostBasisCache());
    expect(avg.totalCost).toBeCloseTo(1500); // blended: 100 @ $15
  });

  it('chained transfer A->B->C: basis traces recursively through the chain', async () => {
    seedChain();

    const result = await traceCostBasis('c-in', 'fifo', AAPL, 50, createCostBasisCache());
    expect(result.totalCost).toBeCloseTo(500); // original A purchase: 50 @ $10
    expect(result.perShareCost).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// Cost basis tracing (after scrub — lot_guid assigned)
// ---------------------------------------------------------------------------

describe('traceCostBasis with scrubbed lots', () => {
  it('lotted transfer-in falls back to chain tracing when the destination lot has no purchase splits', async () => {
    seedPartialTransfer();
    await autoAssignLots(STOCK_A, 'fifo');
    await autoAssignLots(STOCK_B, 'fifo');

    // b-in now has lot_guid pointing at the destination lot, whose only other
    // splits are sells. Basis must still resolve to the original $600, not $0.
    expect(split('b-in').lot_guid).not.toBeNull();
    const result = await traceCostBasis('b-in', 'fifo', AAPL, 60, createCostBasisCache());
    expect(result.totalCost).toBeCloseTo(600);
    expect(result.perShareCost).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// lots.ts — transfer metadata surfaced in lot summaries
// ---------------------------------------------------------------------------

describe('getAccountLots transfer metadata', () => {
  it('surfaces sourceLotGuid and acquisitionDate written by the scrub engine', async () => {
    seedFullTransfer();
    await autoAssignLots(STOCK_A, 'fifo');
    await autoAssignLots(STOCK_B, 'fifo');

    const summaries = await getAccountLots(STOCK_B);
    expect(summaries).toHaveLength(1);
    const lot = summaries[0];
    expect(lot.isClosed).toBe(true);
    expect(lot.sourceLotGuid).toBe(split('a-buy').lot_guid);
    expect(lot.acquisitionDate).toBe('2022-01-10T00:00:00.000Z');
    // Holding period computed from the ORIGINAL acquisition, so long_term
    expect(lot.holdingPeriod).toBe('long_term');
    expect(Math.abs(lot.totalShares)).toBeLessThan(0.0001);
    // Realized gain = proceeds 1500 - carried basis 1000 = +500, even though
    // the scrubbed lot's splits (incl. the gains offset) sum to zero.
    expect(lot.realizedGain).toBeCloseTo(500);
  });
});


