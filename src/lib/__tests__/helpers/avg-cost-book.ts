/**
 * Shared in-memory book for the average-cost tests.
 *
 * Two test files drive the same engine against the same fake: the behavioural
 * suite in lot-assignment-average-cost.test.ts, and the depth/repair proof in
 * avg-basis-history-depth.test.ts. The fake lives here so the second one does
 * not have to carry a divergent copy of the first one's Prisma stand-in.
 *
 * This module deliberately imports NOTHING from src/lib. The prisma module is
 * mocked with `default: fakePrisma` from here, so an import back into the code
 * under test would make the mock factory re-enter a module that is still
 * loading.
 */

import { createAvgBasisHistoryFake } from './fake-avg-basis-history';

/** The app-owned gnucash_web_avg_basis_history table, in memory. */
const avgBasisHistoryFake = createAvgBasisHistoryFake();

export interface Row { [k: string]: unknown }

export const db = {
  accounts: [] as Row[],
  transactions: [] as Row[],
  splits: [] as Row[],
  lots: [] as Row[],
  slots: [] as Row[],
  commodities: [] as Row[],
  prices: [] as Row[],
};

export function resetDb() {
  for (const key of Object.keys(db) as Array<keyof typeof db>) db[key] = [];
  avgBasisHistoryFake.reset();
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
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

export const accountByGuid = (guid: unknown) => db.accounts.find(a => a.guid === guid) ?? null;
export const txByGuid = (guid: unknown) => db.transactions.find(t => t.guid === guid) ?? null;

/** Sibling splits of a transaction, each with its account joined. */
export const siblingsOf = (txGuid: unknown) =>
  db.splits.filter(x => x.tx_guid === txGuid).map(x => ({ ...x, account: accountByGuid(x.account_guid) }));

export function hydrateSplit(s: Row, include?: Row): Row {
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

export function sortByPostDate(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ta = (txByGuid(a.tx_guid)?.post_date as Date | undefined)?.getTime() ?? 0;
    const tb = (txByGuid(b.tx_guid)?.post_date as Date | undefined)?.getTime() ?? 0;
    return ta - tb;
  });
}

export const splitsApi = {
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
export const lotWithSplits = (lot: Row) => ({
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

export const lotsApi = {
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
  // Real implementations (not stubs): the revert-provenance tests below
  // drive revertScrubRun, which deletes run-created lots and reopens the
  // ones it closed. A no-op here would let those assertions pass vacuously.
  updateMany: async (args: Row) => {
    const rows = db.lots.filter(r => matchesWhere(r, args.where as Row));
    for (const r of rows) Object.assign(r, args.data as Row);
    return { count: rows.length };
  },
  deleteMany: async (args: Row) => {
    const doomed = db.lots.filter(r => matchesWhere(r, args.where as Row));
    db.lots = db.lots.filter(r => !doomed.includes(r));
    return { count: doomed.length };
  },
};

export const slotsApi = {
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

/** The history table's rows, for tests that inspect or damage them. */
export const avgBasisHistory = avgBasisHistoryFake;

export const fakePrisma = {
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
    deleteMany: async (args: Row) => {
      const doomed = db.transactions.filter(r => matchesWhere(r, args.where as Row));
      db.transactions = db.transactions.filter(r => !doomed.includes(r));
      return { count: doomed.length };
    },
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
  // DDL: the table is provisioned for real by db-init / ensureAvgBasisHistoryTable.
  $executeRawUnsafe: async () => 0,
  // The lot engine's other raw SQL is the FOR UPDATE lock helpers, which need
  // no fake; the history fake returns undefined for those.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
    avgBasisHistoryFake.query(strings, values) ?? [],
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
    avgBasisHistoryFake.execute(strings, values) ?? 0,
};


export const USD = 'usd-commodity';
export const AAPL = 'aapl-commodity';
export const STOCK_ACCT = 'stock-acct';
export const STOCK_ACCT_2 = 'stock-acct-2';
export const CASH_ACCT = 'cash-acct';
export const FEE_ACCT = 'fee-acct';

export let guidSeq = 0;
export const nextGuid = (prefix: string) => `${prefix}-${(guidSeq++).toString().padStart(4, '0')}`;

/** Reset the guid counter so each test file's book starts from the same names. */
export const resetGuidSeq = (): void => { guidSeq = 0; };

export const qtyFrac = (shares: number) => BigInt(Math.round(shares * 100));
export const cents = (dollars: number) => BigInt(Math.round(dollars * 100));

export function seedBaseAccounts() {
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
export function addTrade(
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
export function addOwnAccountTransfer(
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

export const lotOfSplit = (splitGuid: string): string | null =>
  (db.splits.find(s => s.guid === splitGuid)?.lot_guid as string | null) ?? null;

export const slotOf = (objGuid: string | null, name: string): number | undefined => {
  if (!objGuid) return undefined;
  const raw = db.slots.find(s => s.obj_guid === objGuid && s.name === name)?.string_val as string | undefined;
  return raw === undefined ? undefined : parseFloat(raw);
};

/** Average-cost basis recorded on one disposal split. */
export const avgBasisOf = (splitGuid: string) => slotOf(splitGuid, 'avg_cost_basis');

/** Every slot name the average-cost election can write. */
export const AVG_SLOT_NAMES = [
  'avg_cost_basis',
  'avg_cost_basis_run',
  'avg_cost_basis_remaining',
  'avg_cost_basis_remaining_run',
  'avg_cost_basis_remaining_prev',
  'avg_cost_basis_remaining_prev_run',
] as const;

/** Raw (unparsed) slot value — provenance slots hold run ids, not numbers. */
export const rawSlotOf = (objGuid: string, name: string): string | undefined =>
  db.slots.find(s => s.obj_guid === objGuid && s.name === name)?.string_val as string | undefined;

/** The run that wrote a disposal split's pooled basis. */
export const avgRunOf = (splitGuid: string) => rawSlotOf(splitGuid, 'avg_cost_basis_run');
/** An open lot's remaining pooled basis, and the run that wrote it. */
export const remainingOf = (lotGuid: string) => slotOf(lotGuid, 'avg_cost_basis_remaining');
export const remainingRunOf = (lotGuid: string) => rawSlotOf(lotGuid, 'avg_cost_basis_remaining_run');
/**
 * Every pooled-basis write a lot carries, oldest first, straight out of the
 * app-owned history table. The last entry is the live one mirrored into
 * `avg_cost_basis_remaining`.
 */
export const writeHistory = (lotGuid: string): Array<{ run: string | null; value: string }> =>
  avgBasisHistoryFake.forLot(lotGuid).map(r => ({ run: r.run_id, value: r.basis_val }));

/** The DISPLACED writes only — everything under the live top of the stack. */
export const stashHistory = (lotGuid: string) => writeHistory(lotGuid).slice(0, -1);
/** The most recently displaced value on a lot, and the run it belonged to. */
export const stashOf = (lotGuid: string): number | undefined => {
  const history = stashHistory(lotGuid);
  return history.length > 0 ? parseFloat(history[history.length - 1].value) : undefined;
};
export const stashRunOf = (lotGuid: string): string | undefined => {
  const history = stashHistory(lotGuid);
  return history.length > 0 ? (history[history.length - 1].run ?? undefined) : undefined;
};

export const allLotGuids = (): string[] => db.lots.map(l => l.guid as string);
export const slotsNamed = (name: string) => db.slots.filter(s => s.name === name);
export const generatedFor = (runId: string) =>
  db.slots.filter(s => s.name === 'gnucash_web_generated' && s.string_val === runId);

/** All generated "Realized Gain/Loss" postings, with their income account. */
export function gainsPostings(): Array<{ amount: number; incomeAccount: string }> {
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
