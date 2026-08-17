/**
 * In-memory fake Prisma for the lot engine's end-to-end tests.
 *
 * Extracted verbatim from lot-transfer-cross-account.test.ts so the fee
 * consistency tests can drive the SAME fake book through the same scrub and
 * report paths instead of keeping a second, subtly different copy.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Rec = Record<string, any>;

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

export class FakePrisma {
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

  /**
   * One orderBy term -> comparator. Supports `{ transaction: { post_date } }`
   * and plain scalar columns, which is the whole vocabulary the lot engine
   * uses; an array of terms compares them left to right, as SQL does.
   */
  private cmpTerm(term: Rec, a: Rec, b: Rec): number {
    if (term?.transaction?.post_date) {
      const dir = term.transaction.post_date === 'desc' ? -1 : 1;
      const ta = this.txOf(a)?.post_date?.getTime?.() ?? 0;
      const tb = this.txOf(b)?.post_date?.getTime?.() ?? 0;
      return (ta - tb) * dir;
    }
    for (const [column, direction] of Object.entries(term ?? {})) {
      if (typeof direction !== 'string') continue;
      const dir = direction === 'desc' ? -1 : 1;
      const diff = cmpVal(a[column] ?? null, b[column] ?? null);
      if (diff !== 0) return diff * dir;
    }
    return 0;
  }

  private sortSplits(list: Rec[], orderBy: any): Rec[] {
    if (!orderBy) return list;
    const terms: Rec[] = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...list].sort((a, b) => {
      for (const term of terms) {
        const diff = this.cmpTerm(term, a, b);
        if (diff !== 0) return diff;
      }
      return 0;
    });
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

  // Raw SQL entry points: the lot engine uses these only for row locking and
  // the enter_date token bump — both irrelevant to this fake's assertions.
  $queryRaw = async () => [];
  $executeRaw = async () => 0;

  $transaction = async (fn: any) => {
    return fn(this);
  };
}
