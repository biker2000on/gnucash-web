/**
 * Invoice/Bill Posting Engine tests
 *
 * Part 1 — pure math (invoice-totals.ts): totals, discounts, tax, sign
 * conventions, payment allocation, due dates, numbering. DB-free.
 *
 * Part 2 — engine behavior (invoice-engine.ts) against an in-memory fake
 * prisma: create/post/unpost/payment flows, GnuCash-native slot+lot layout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  roundCurrency,
  computeEntry,
  computeInvoiceTotals,
  buildPostingSplits,
  buildPaymentSplits,
  amountDueFromLotSplits,
  allocatePaymentFifo,
  computeDueDate,
  nextIdFromExisting,
  formatInvoiceId,
  invoiceStatus,
  type EntryLineInput,
  type TaxTableSpec,
} from '../invoice-totals';

// ---------------------------------------------------------------------------
// In-memory fake prisma
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

/** Assert a fake-db lookup found a row (keeps strict null checks happy). */
function req<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a row, got none');
  return v;
}

/**
 * Ownership rows the `ownership` relation filter joins against. Registered by
 * the fake db below so `matches` can model the join rather than waving it
 * through as an unsupported operator — waving it through would make every
 * cross-book assertion below pass vacuously.
 */
let ownershipRowsRef: Row[] = [];

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'ownership') {
      // Relation filter against the per-entity ownership view. Guids are unique
      // across entity types in these fixtures, so matching on guid + book is
      // equivalent to joining the type-specific view.
      const wanted = (v as any)?.book_guid;
      const owned = ownershipRowsRef.some(
        (o) => o.entity_guid === row.guid && o.book_guid === wanted,
      );
      if (!owned) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && typeof v !== 'bigint') {
      const cond = v as any;
      if ('in' in cond) {
        if (!cond.in.includes(row[k])) return false;
        continue;
      }
      if ('not' in cond) {
        if (cond.not === null ? row[k] === null || row[k] === undefined : row[k] === cond.not) return false;
        continue;
      }
      continue; // unsupported operator — treat as match
    }
    if (row[k] !== v) return false;
  }
  return true;
}

let slotAutoId = 1;

/**
 * gnucash_web_business_entity_ownership uses a compound primary key, which the
 * generic `matches` helper above cannot express — hence a bespoke fake.
 */
function ownershipModel(rows: Row[]) {
  ownershipRowsRef = rows;
  return {
    rows,
    create: async ({ data }: any) => {
      rows.push({ ...data });
      return data;
    },
    findUnique: async ({ where }: any) => {
      const key = where.entity_type_entity_guid;
      const hit = rows.find(
        (r) => r.entity_type === key.entity_type && r.entity_guid === key.entity_guid,
      );
      return hit ? { book_guid: hit.book_guid } : null;
    },
    findMany: async ({ where }: any) =>
      rows
        .filter((r) => r.entity_type === where.entity_type && r.book_guid === where.book_guid)
        .map((r) => ({ entity_guid: r.entity_guid })),
    deleteMany: async ({ where }: any) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].entity_type === where.entity_type && rows[i].entity_guid === where.entity_guid) {
          rows.splice(i, 1);
        }
      }
    },
  };
}

function model(rows: Row[], opts: { autoId?: boolean } = {}) {
  return {
    rows,
    findUnique: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async (args: any = {}) => rows.filter((r) => matches(r, args?.where)),
    create: async ({ data }: any) => {
      const row = { ...data };
      if (opts.autoId && row.id === undefined) row.id = slotAutoId++;
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error('update: row not found');
      Object.assign(r, data);
      return r;
    },
    delete: async ({ where }: any) => {
      const i = rows.findIndex((x) => matches(x, where));
      if (i >= 0) rows.splice(i, 1);
    },
    deleteMany: async ({ where }: any) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
    },
  };
}

const BOOK_A = 'book1';
const BOOK_B = 'book2';

interface FakeDb {
  // Tables (model(...)) plus the raw-SQL surface ($queryRaw / $rawSql log)
  // the engine's locking and counter paths use on the transaction client.
  [table: string]: any;
}

const holder: { db: FakeDb | null } = { db: null };

vi.mock('@/lib/prisma', () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(holder.db);
        }
        if (prop === '$queryRaw') {
          // Raw queries on the GLOBAL client are the period-lock guard's
          // lookups (gnucash_web_book_settings / account→book resolution) —
          // return no rows so engine tests run against an unlocked book.
          // The engine's own raw ops (row locks, counter increments) run on
          // the transaction client, i.e. holder.db.$queryRaw below.
          return async () => [];
        }
        return holder.db?.[prop];
      },
    }
  ),
}));

function seedDb(): FakeDb {
  slotAutoId = 1;
  const db: FakeDb = {
    books: model([
      { guid: 'book1', root_account_guid: 'root' },
      { guid: 'book2', root_account_guid: 'root2' },
    ]),
    commodities: model([
      { guid: 'usd', namespace: 'CURRENCY', mnemonic: 'USD', fraction: 100, quote_flag: 0 },
    ]),
    accounts: model([
      { guid: 'root', name: 'Root', account_type: 'ROOT', commodity_guid: 'usd', commodity_scu: 100, parent_guid: null, placeholder: 0 },
      { guid: 'inc1', name: 'Sales', account_type: 'INCOME', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root', placeholder: 0 },
      { guid: 'exp1', name: 'Supplies', account_type: 'EXPENSE', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root', placeholder: 0 },
      { guid: 'bank1', name: 'Checking', account_type: 'BANK', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root', placeholder: 0 },
      { guid: 'ar1', name: 'Accounts Receivable', account_type: 'RECEIVABLE', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root', placeholder: 0 },
      { guid: 'ap1', name: 'Accounts Payable', account_type: 'PAYABLE', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root', placeholder: 0 },
      { guid: 'tax1', name: 'Sales Tax Payable', account_type: 'LIABILITY', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root', placeholder: 0 },
      // Book B's hierarchy — nothing here may be reached from book A.
      { guid: 'root2', name: 'Root B', account_type: 'ROOT', commodity_guid: 'usd', commodity_scu: 100, parent_guid: null, placeholder: 0 },
      { guid: 'inc2', name: 'Sales B', account_type: 'INCOME', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root2', placeholder: 0 },
      { guid: 'ar2', name: 'Accounts Receivable B', account_type: 'RECEIVABLE', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root2', placeholder: 0 },
      { guid: 'bank2', name: 'Checking B', account_type: 'BANK', commodity_guid: 'usd', commodity_scu: 100, parent_guid: 'root2', placeholder: 0 },
    ]),
    customers: model([
      { guid: 'cust1', name: 'Acme Corp', id: '000001', notes: '', active: 1, currency: 'usd', tax_override: 0, terms: null, discount_num: 0n, discount_denom: 1n, credit_num: 0n, credit_denom: 1n },
      { guid: 'cust2', name: 'Beta Ltd (book B)', id: '000001', notes: '', active: 1, currency: 'usd', tax_override: 0, terms: null, discount_num: 0n, discount_denom: 1n, credit_num: 0n, credit_denom: 1n },
    ]),
    vendors: model([
      { guid: 'vend1', name: 'Widget Supply Co', id: '000001', notes: '', active: 1, currency: 'usd', tax_override: 0, terms: null },
    ]),
    jobs: model([]),
    billterms: model([
      { guid: 'net30', name: 'Net 30', description: '', refcount: 0, invisible: 0, parent: null, type: 'GNC_TERM_TYPE_DAYS', duedays: 30, discountdays: 0, cutoff: 0 },
    ]),
    taxtables: model([{ guid: 'tt1', name: 'Sales Tax 5%', refcount: 0n, invisible: 0, parent: null }]),
    taxtable_entries: model(
      [{ id: 1, taxtable: 'tt1', account: 'tax1', amount_num: 5n, amount_denom: 1n, type: 2 }],
      { autoId: true }
    ),
    invoices: model([]),
    entries: model([]),
    transactions: model([]),
    splits: model([]),
    lots: model([]),
    slots: model([], { autoId: true }),
    // Audit S5: the native business tables carry no book_guid, so scope lives
    // here. Missing ownership means FOREIGN.
    gnucash_web_business_entity_ownership: ownershipModel([
      { entity_type: 'customer', entity_guid: 'cust1', book_guid: BOOK_A },
      { entity_type: 'vendor', entity_guid: 'vend1', book_guid: BOOK_A },
      { entity_type: 'customer', entity_guid: 'cust2', book_guid: BOOK_B },
    ]),
  };

  // Raw-SQL surface used by the engine on the transaction client:
  //   - pg_advisory_xact_lock(...)          -> no-op (single-threaded fake)
  //   - UPDATE slots ... RETURNING int64_val -> atomic counter increment
  //   - SELECT ... FOR UPDATE                -> row locks are no-ops here
  // Every statement is logged to $rawSql so tests can assert locks are taken.
  db.$rawSql = [] as string[];
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join('?');
    db.$rawSql.push(sql);
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('UPDATE slots')) {
      const row = db.slots.rows.find((r: Row) => r.id === values[0]);
      if (!row) return [];
      row.int64_val = (row.int64_val ?? 0n) + 1n;
      return [{ int64_val: row.int64_val }];
    }
    return [];
  };

  return db;
}

import {
  createInvoice,
  postInvoice,
  unpostInvoice,
  applyPayment,
  getInvoiceWithStatus,
  listInvoices,
  listPayments,
  deleteInvoice,
  updateInvoice,
  buildInvoiceView,
  InvoiceValidationError,
  InvoiceStateError,
  InvoiceNotFoundError,
} from '../invoice-engine';
import { buildAgingReport } from '../business-reports';

// ===========================================================================
// Part 1 — pure math
// ===========================================================================

const pctTax5: TaxTableSpec = {
  guid: 'tt1',
  entries: [{ accountGuid: 'tax1', type: 'PERCENT', amount: 5 }],
};

describe('roundCurrency', () => {
  it('rounds half away from zero', () => {
    // Exact halves (fraction 1 avoids float-representation noise)
    expect(roundCurrency(1.5, 1)).toBe(2);
    expect(roundCurrency(-1.5, 1)).toBe(-2); // away from zero, not toward +inf
    expect(roundCurrency(2.494)).toBe(2.49);
    expect(roundCurrency(2.496)).toBe(2.5);
    expect(roundCurrency(-2.496)).toBe(-2.5);
  });
});

describe('computeEntry — qty x price and discounts', () => {
  it('computes plain qty x price', () => {
    const e = computeEntry({ accountGuid: 'inc1', quantity: 2, price: 50 });
    expect(e.net).toBe(100);
    expect(e.subtotal).toBe(100);
    expect(e.taxTotal).toBe(0);
    expect(e.gross).toBe(100);
  });

  it('applies a VALUE discount as a flat amount', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50,
      discount: 10, discountType: 'VALUE',
    });
    expect(e.net).toBe(90);
    expect(e.discountValue).toBe(10);
  });

  it('applies a PERCENT discount (PRETAX)', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50,
      discount: 10, discountType: 'PERCENT', discountHow: 'PRETAX',
    });
    expect(e.net).toBe(90);
    expect(e.discountValue).toBe(10);
  });

  it('PRETAX: tax computed on the discounted value', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50,
      discount: 10, discountType: 'PERCENT', discountHow: 'PRETAX',
      taxable: true, taxTable: pctTax5,
    });
    expect(e.net).toBe(90);
    expect(e.taxes).toEqual([{ accountGuid: 'tax1', amount: 4.5 }]);
    expect(e.gross).toBe(94.5);
  });

  it('SAMETIME: discount and tax both on the pre-discount value', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50,
      discount: 10, discountType: 'PERCENT', discountHow: 'SAMETIME',
      taxable: true, taxTable: pctTax5,
    });
    expect(e.net).toBe(90);
    expect(e.taxes).toEqual([{ accountGuid: 'tax1', amount: 5 }]); // tax on 100
    expect(e.gross).toBe(95);
  });

  it('POSTTAX: discount computed on the post-tax value, tax on pretax', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50,
      discount: 10, discountType: 'PERCENT', discountHow: 'POSTTAX',
      taxable: true, taxTable: pctTax5,
    });
    // taxOnPretax = 5; discount = (100 + 5) * 10% = 10.50; net = 89.50
    expect(e.net).toBe(89.5);
    expect(e.discountValue).toBe(10.5);
    expect(e.taxes).toEqual([{ accountGuid: 'tax1', amount: 5 }]);
  });
});

describe('computeEntry — tax', () => {
  it('percent tax on the net value', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50, taxable: true, taxTable: pctTax5,
    });
    expect(e.net).toBe(100);
    expect(e.taxTotal).toBe(5);
    expect(e.gross).toBe(105);
  });

  it('fixed (VALUE) tax is per entry, not scaled by quantity', () => {
    const fixed: TaxTableSpec = {
      guid: 'ttf', entries: [{ accountGuid: 'tax1', type: 'VALUE', amount: 3 }],
    };
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 4, price: 25, taxable: true, taxTable: fixed,
    });
    expect(e.net).toBe(100);
    expect(e.taxes).toEqual([{ accountGuid: 'tax1', amount: 3 }]);
  });

  it('tax-included percent backs the tax out of the price', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 52.5,
      taxable: true, taxIncluded: true, taxTable: pctTax5,
    });
    // 105 gross including 5% => pretax 100, tax 5
    expect(e.net).toBe(100);
    expect(e.taxTotal).toBe(5);
    expect(e.gross).toBe(105);
  });

  it('tax-included with a fixed component: pretax = (agg - fixed) / (1 + pct)', () => {
    const mixed: TaxTableSpec = {
      guid: 'ttm',
      entries: [
        { accountGuid: 'tax1', type: 'PERCENT', amount: 5 },
        { accountGuid: 'tax1', type: 'VALUE', amount: 10 },
      ],
    };
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 1, price: 115,
      taxable: true, taxIncluded: true, taxTable: mixed,
    });
    // (115 - 10) / 1.05 = 100
    expect(e.net).toBe(100);
    expect(e.taxTotal).toBe(15);
    expect(e.gross).toBe(115);
  });

  it('non-taxable entries ignore the tax table', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 2, price: 50, taxable: false, taxTable: pctTax5,
    });
    expect(e.taxTotal).toBe(0);
    expect(e.net).toBe(100);
  });

  it('rounds line values to the currency fraction', () => {
    const e = computeEntry({
      accountGuid: 'inc1', quantity: 3, price: 0.333, taxable: true, taxTable: pctTax5,
    });
    expect(e.net).toBe(1.0); // 0.999 -> 1.00
    expect(e.taxTotal).toBe(0.05); // 0.04995 -> 0.05
  });
});

describe('computeInvoiceTotals', () => {
  it('aggregates lines and taxes by account', () => {
    const lines: EntryLineInput[] = [
      { accountGuid: 'inc1', quantity: 2, price: 50, taxable: true, taxTable: pctTax5 },
      { accountGuid: 'inc2', quantity: 1, price: 200, taxable: true, taxTable: pctTax5 },
      { accountGuid: 'inc1', quantity: 1, price: 30, taxable: false },
    ];
    const t = computeInvoiceTotals(lines);
    expect(t.subtotal).toBe(330);
    expect(t.taxTotal).toBe(15); // 5 + 10
    expect(t.total).toBe(345);
    expect(t.taxByAccount).toEqual([{ accountGuid: 'tax1', amount: 15 }]);
  });
});

describe('buildPostingSplits — sign conventions', () => {
  const lines: EntryLineInput[] = [
    { accountGuid: 'inc1', description: 'Consulting', quantity: 2, price: 50, taxable: true, taxTable: pctTax5 },
  ];

  it('customer invoice: DEBIT A/R, CREDIT income and tax', () => {
    const totals = computeInvoiceTotals(lines);
    const splits = buildPostingSplits('invoice', totals, lines, 'ar1');
    expect(splits.find((s) => s.isPostSplit)).toMatchObject({ accountGuid: 'ar1', value: 105 });
    expect(splits.find((s) => s.accountGuid === 'inc1')).toMatchObject({ value: -100, memo: 'Consulting', action: 'Invoice' });
    expect(splits.find((s) => s.accountGuid === 'tax1')).toMatchObject({ value: -5 });
    expect(roundCurrency(splits.reduce((sum, s) => sum + s.value, 0))).toBe(0);
  });

  it('vendor bill: CREDIT A/P, DEBIT expense and tax', () => {
    const billLines: EntryLineInput[] = [
      { accountGuid: 'exp1', quantity: 2, price: 50, taxable: true, taxTable: pctTax5 },
    ];
    const totals = computeInvoiceTotals(billLines);
    const splits = buildPostingSplits('bill', totals, billLines, 'ap1');
    expect(splits.find((s) => s.isPostSplit)).toMatchObject({ accountGuid: 'ap1', value: -105 });
    expect(splits.find((s) => s.accountGuid === 'exp1')).toMatchObject({ value: 100, action: 'Bill' });
    expect(splits.find((s) => s.accountGuid === 'tax1')).toMatchObject({ value: 5 });
    expect(roundCurrency(splits.reduce((sum, s) => sum + s.value, 0))).toBe(0);
  });
});

describe('amountDueFromLotSplits', () => {
  it('invoice: due = lot balance (posting +105, payment -45 => 60 due)', () => {
    expect(amountDueFromLotSplits('invoice', [105, -45])).toBe(60);
    expect(amountDueFromLotSplits('invoice', [105, -105])).toBe(0);
  });
  it('bill: due = negated lot balance', () => {
    expect(amountDueFromLotSplits('bill', [-105, 45])).toBe(60);
    expect(amountDueFromLotSplits('bill', [-105, 105])).toBe(0);
  });
});

describe('allocatePaymentFifo', () => {
  const open = [
    { guid: 'B', datePosted: new Date('2026-02-05'), amountDue: 200 },
    { guid: 'A', datePosted: new Date('2026-01-05'), amountDue: 105 },
  ];

  it('allocates oldest-first across invoices', () => {
    const r = allocatePaymentFifo(open, 150);
    expect(r.allocations).toEqual([
      { invoiceGuid: 'A', amount: 105 },
      { invoiceGuid: 'B', amount: 45 },
    ]);
    expect(r.remainder).toBe(0);
  });

  it('closes exactly when the payment matches the total due', () => {
    const r = allocatePaymentFifo(open, 305);
    expect(r.allocations).toEqual([
      { invoiceGuid: 'A', amount: 105 },
      { invoiceGuid: 'B', amount: 200 },
    ]);
    expect(r.remainder).toBe(0);
  });

  it('reports the overpayment remainder', () => {
    const r = allocatePaymentFifo(open, 400);
    expect(r.remainder).toBe(95);
  });

  it('sorts null-dated invoices last', () => {
    const r = allocatePaymentFifo(
      [
        { guid: 'X', datePosted: null, amountDue: 50 },
        { guid: 'A', datePosted: new Date('2026-01-05'), amountDue: 105 },
      ],
      120
    );
    expect(r.allocations[0].invoiceGuid).toBe('A');
    expect(r.allocations[1]).toEqual({ invoiceGuid: 'X', amount: 15 });
  });
});

describe('buildPaymentSplits — sign conventions', () => {
  it('customer payment: DEBIT deposit, CREDIT A/R into lots', () => {
    const splits = buildPaymentSplits('invoice', 150, 'bank1', [
      { accountGuid: 'ar1', lotGuid: 'lotA', amount: 105 },
      { accountGuid: 'ar1', lotGuid: 'lotB', amount: 45 },
    ]);
    expect(splits[0]).toMatchObject({ accountGuid: 'bank1', value: 150, lotGuid: null });
    expect(splits[1]).toMatchObject({ accountGuid: 'ar1', value: -105, lotGuid: 'lotA', action: 'Payment' });
    expect(splits[2]).toMatchObject({ value: -45, lotGuid: 'lotB' });
    expect(roundCurrency(splits.reduce((sum, s) => sum + s.value, 0))).toBe(0);
  });

  it('vendor payment: CREDIT bank, DEBIT A/P into lots', () => {
    const splits = buildPaymentSplits('bill', 80, 'bank1', [
      { accountGuid: 'ap1', lotGuid: 'lotC', amount: 80 },
    ]);
    expect(splits[0]).toMatchObject({ accountGuid: 'bank1', value: -80 });
    expect(splits[1]).toMatchObject({ accountGuid: 'ap1', value: 80, lotGuid: 'lotC' });
  });
});

describe('computeDueDate', () => {
  const post = new Date('2026-01-05T12:00:00Z');

  it('returns the post date when there is no term', () => {
    expect(computeDueDate(post, null).toISOString().slice(0, 10)).toBe('2026-01-05');
  });

  it('DAYS: post + duedays', () => {
    const due = computeDueDate(post, { type: 'GNC_TERM_TYPE_DAYS', duedays: 30, cutoff: null });
    expect(due.toISOString().slice(0, 10)).toBe('2026-02-04');
  });

  it('PROXIMO: due on day N of next month; posts after cutoff roll a month', () => {
    const before = computeDueDate(post, { type: 'GNC_TERM_TYPE_PROXIMO', duedays: 15, cutoff: 20 });
    expect(before.toISOString().slice(0, 10)).toBe('2026-02-15');
    const late = computeDueDate(new Date('2026-01-25T12:00:00Z'), { type: 'GNC_TERM_TYPE_PROXIMO', duedays: 15, cutoff: 20 });
    expect(late.toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});

describe('numbering', () => {
  it('nextIdFromExisting: max numeric + 1, ignoring non-numeric ids', () => {
    expect(nextIdFromExisting([])).toBe(1);
    expect(nextIdFromExisting(['000007', '000012', 'INV-9', 'abc'])).toBe(13);
  });
  it('formatInvoiceId zero-pads to 6 (GnuCash %.6 counter format)', () => {
    expect(formatInvoiceId(13)).toBe('000013');
    expect(formatInvoiceId(1234567)).toBe('1234567');
  });
});

describe('invoiceStatus', () => {
  const today = new Date('2026-07-08T12:00:00Z');
  it('classifies draft/paid/overdue/open', () => {
    expect(invoiceStatus(false, 100, null, today)).toBe('draft');
    expect(invoiceStatus(true, 0, new Date('2026-01-01'), today)).toBe('paid');
    expect(invoiceStatus(true, 50, new Date('2026-06-01'), today)).toBe('overdue');
    expect(invoiceStatus(true, 50, new Date('2026-08-01'), today)).toBe('open');
    expect(invoiceStatus(true, 50, null, today)).toBe('open');
  });
});

// ===========================================================================
// Part 2 — engine behavior against the fake DB
// ===========================================================================

describe('invoice engine (fake prisma)', () => {
  beforeEach(() => {
    holder.db = seedDb();
  });

  /** getInvoiceWithStatus is book-scoped and nullable; these cases expect a hit. */
  const getView = async (guid: string) => req(await getInvoiceWithStatus(BOOK_A, guid));

  const customerInvoiceInput = () => ({
    ownerType: 'customer' as const,
    ownerGuid: 'cust1',
    dateOpened: '2026-01-05',
    termsGuid: 'net30',
    bookGuid: 'book1',
    entries: [
      {
        description: 'Consulting',
        quantity: 2,
        price: 50,
        accountGuid: 'inc1',
        taxable: true,
        taxTableGuid: 'tt1',
      },
    ],
  });

  it('createInvoice writes i_* entry columns for a customer invoice', async () => {
    const view = await createInvoice(BOOK_A, customerInvoiceInput());
    expect(view.type).toBe('invoice');
    expect(view.id).toBe('000001'); // fallback numbering (no counter slot)
    expect(view.status).toBe('draft');
    expect(view.totals).toMatchObject({ subtotal: 100, taxTotal: 5, total: 105 });
    expect(view.amountDue).toBe(105);

    const entry = holder.db!.entries.rows[0];
    expect(entry.invoice).toBe(view.guid);
    expect(entry.bill).toBeUndefined();
    expect(entry.i_acct).toBe('inc1');
    expect(entry.i_taxtable).toBe('tt1');
    expect(entry.i_disc_type).toBe('VALUE');
    expect(entry.i_disc_how).toBe('PRETAX');
    expect(entry.quantity_num).toBe(200n);
    expect(entry.quantity_denom).toBe(100n);
    expect(entry.i_price_num).toBe(50000000n);
    expect(entry.i_price_denom).toBe(1000000n);

    // Fallback numbering persists a GnuCash-style counter for future use
    const frame = req(
      holder.db!.slots.rows.find((s: Row) => s.obj_guid === 'book1' && s.name === 'counters' && s.slot_type === 9)
    );
    const counter = req(
      holder.db!.slots.rows.find((s: Row) => s.obj_guid === frame.guid_val && s.name === 'counters/gncInvoice')
    );
    expect(counter.int64_val).toBe(1n);
    expect(counter.slot_type).toBe(1);
  });

  it('createInvoice writes b_* entry columns for a vendor bill', async () => {
    const view = await createInvoice(BOOK_A, {
      ownerType: 'vendor',
      ownerGuid: 'vend1',
      dateOpened: '2026-01-05',
      entries: [{ description: 'Widgets', quantity: 10, price: 4, accountGuid: 'exp1', taxable: false }],
    });
    expect(view.type).toBe('bill');
    const entry = holder.db!.entries.rows[0];
    expect(entry.bill).toBe(view.guid);
    expect(entry.b_acct).toBe('exp1');
    expect(entry.i_acct).toBeUndefined();
    expect(view.totals.total).toBe(40);
  });

  it('rejects discounts on bills (GnuCash bills have no discount columns)', async () => {
    await expect(
      createInvoice(BOOK_A, {
        ownerType: 'vendor',
        ownerGuid: 'vend1',
          entries: [{ quantity: 1, price: 10, accountGuid: 'exp1', discount: 2 }],
      })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });

  it('uses and increments the book counter slot when present', async () => {
    // GnuCash frame layout: book -> 'counters' frame -> child on frame guid
    holder.db!.slots.rows.push(
      { id: 900, obj_guid: 'book1', name: 'counters', slot_type: 9, guid_val: 'frameC' },
      { id: 901, obj_guid: 'frameC', name: 'counters/gncInvoice', slot_type: 1, int64_val: 42n }
    );
    const view = await createInvoice(BOOK_A, customerInvoiceInput());
    expect(view.id).toBe('000043');
    const counter = req(holder.db!.slots.rows.find((s: Row) => s.name === 'counters/gncInvoice'));
    expect(counter.int64_val).toBe(43n);
  });

  it('postInvoice creates the GnuCash-native transaction, splits, lot and slots', async () => {
    const view = await createInvoice(BOOK_A, customerInvoiceInput());
    const result = await postInvoice(BOOK_A, view.guid, { postDate: '2026-01-05' });

    expect(result.total).toBe(105);
    expect(result.dueDate).toBe('2026-02-04'); // Net 30
    expect(result.postAccountGuid).toBe('ar1');

    // Transaction
    const txn = req(holder.db!.transactions.rows.find((t: Row) => t.guid === result.transactionGuid));
    expect(txn).toMatchObject({ currency_guid: 'usd', num: '000001', description: 'Acme Corp' });
    expect(txn.post_date.toISOString()).toBe('2026-01-05T12:00:00.000Z');

    // Splits: +105 A/R (with lot), -100 income, -5 tax
    const splits = holder.db!.splits.rows.filter((s: Row) => s.tx_guid === result.transactionGuid);
    expect(splits).toHaveLength(3);
    const arSplit = req(splits.find((s: Row) => s.account_guid === 'ar1'));
    expect(arSplit.value_num).toBe(10500n);
    expect(arSplit.value_denom).toBe(100n);
    expect(arSplit.lot_guid).toBe(result.lotGuid);
    expect(arSplit.action).toBe('Invoice');
    expect(req(splits.find((s: Row) => s.account_guid === 'inc1')).value_num).toBe(-10000n);
    expect(req(splits.find((s: Row) => s.account_guid === 'tax1')).value_num).toBe(-500n);
    const balance = splits.reduce((sum: bigint, s: Row) => sum + s.value_num, 0n);
    expect(balance).toBe(0n);

    // Lot on A/R
    const lot = holder.db!.lots.rows.find((l: Row) => l.guid === result.lotGuid);
    expect(lot).toMatchObject({ account_guid: 'ar1', is_closed: 0 });

    // Lot slots: gncInvoice frame -> gncInvoice/invoice-guid
    const lotFrame = req(
      holder.db!.slots.rows.find(
        (s: Row) => s.obj_guid === result.lotGuid && s.name === 'gncInvoice' && s.slot_type === 9
      )
    );
    expect(lotFrame).toBeTruthy();
    const lotChild = holder.db!.slots.rows.find(
      (s: Row) => s.obj_guid === lotFrame.guid_val && s.name === 'gncInvoice/invoice-guid'
    );
    expect(lotChild).toMatchObject({ slot_type: 5, guid_val: view.guid });

    // Transaction slots
    const txnSlots = holder.db!.slots.rows.filter((s: Row) => s.obj_guid === result.transactionGuid);
    expect(txnSlots.find((s: Row) => s.name === 'trans-txn-type')).toMatchObject({ slot_type: 4, string_val: 'I' });
    expect(txnSlots.find((s: Row) => s.name === 'trans-date-due')?.slot_type).toBe(6);
    expect(txnSlots.find((s: Row) => s.name === 'trans-read-only')?.string_val).toContain('unposting');
    expect(txnSlots.find((s: Row) => s.name === 'date-posted')?.slot_type).toBe(10);
    const txnFrame = req(txnSlots.find((s: Row) => s.name === 'gncInvoice'));
    const txnChild = holder.db!.slots.rows.find(
      (s: Row) => s.obj_guid === txnFrame.guid_val && s.name === 'gncInvoice/invoice-guid'
    );
    expect(txnChild?.guid_val).toBe(view.guid);

    // Invoice row updated
    const invRow = req(holder.db!.invoices.rows.find((i: Row) => i.guid === view.guid));
    expect(invRow.post_txn).toBe(result.transactionGuid);
    expect(invRow.post_acc).toBe('ar1');
    expect(invRow.post_lot).toBe(result.lotGuid);
    expect(invRow.date_posted).toBeInstanceOf(Date);

    const after = await getView(view.guid);
    // Unpaid and past the 2026-02-04 due date relative to the real clock
    expect(after.status).toBe('overdue');
    expect(after.amountDue).toBe(105);
    expect(after.dueDate).toBe('2026-02-04');
  });

  it('bill posting flips signs (credit A/P, debit expense)', async () => {
    const bill = await createInvoice(BOOK_A, {
      ownerType: 'vendor',
      ownerGuid: 'vend1',
      entries: [{ quantity: 10, price: 4, accountGuid: 'exp1', taxable: false }],
    });
    const result = await postInvoice(BOOK_A, bill.guid, { postDate: '2026-01-10' });
    const splits = holder.db!.splits.rows.filter((s: Row) => s.tx_guid === result.transactionGuid);
    expect(req(splits.find((s: Row) => s.account_guid === 'ap1')).value_num).toBe(-4000n);
    expect(req(splits.find((s: Row) => s.account_guid === 'exp1')).value_num).toBe(4000n);
    expect(req(splits.find((s: Row) => s.account_guid === 'ap1')).lot_guid).toBe(result.lotGuid);
  });

  it('updateInvoice/deleteInvoice refuse posted invoices', async () => {
    const view = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, view.guid, { postDate: '2026-01-05' });
    await expect(updateInvoice(BOOK_A, view.guid, { notes: 'x' })).rejects.toBeInstanceOf(InvoiceStateError);
    await expect(deleteInvoice(BOOK_A, view.guid)).rejects.toBeInstanceOf(InvoiceStateError);
  });

  it('postInvoice locks the invoice row and rejects a second post (double-post guard)', async () => {
    const view = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, view.guid, { postDate: '2026-01-05' });

    // The FOR UPDATE row lock is taken inside the transaction, before the
    // already-posted check, so concurrent posts serialize on it.
    expect(
      holder.db!.$rawSql.some(
        (sql: string) => sql.includes('FROM invoices') && sql.includes('FOR UPDATE')
      )
    ).toBe(true);

    await expect(
      postInvoice(BOOK_A, view.guid, { postDate: '2026-01-06' })
    ).rejects.toBeInstanceOf(InvoiceStateError);
    await expect(
      postInvoice(BOOK_A, view.guid, { postDate: '2026-01-06' })
    ).rejects.toThrow('Invoice is already posted');

    // The losing posts booked nothing: still one transaction, one lot,
    // three splits.
    expect(holder.db!.transactions.rows).toHaveLength(1);
    expect(holder.db!.lots.rows).toHaveLength(1);
    expect(holder.db!.splits.rows).toHaveLength(3);
  });

  it('unpostInvoice rejects a second unpost (mirror guard)', async () => {
    const view = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, view.guid, { postDate: '2026-01-05' });
    await unpostInvoice(BOOK_A, view.guid);
    await expect(unpostInvoice(BOOK_A, view.guid)).rejects.toBeInstanceOf(InvoiceStateError);
    await expect(unpostInvoice(BOOK_A, view.guid)).rejects.toThrow('Invoice is not posted');
  });

  it('applyPayment locks the posted invoice rows before computing amountDue', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    holder.db!.$rawSql.length = 0;

    await applyPayment(BOOK_A, {
      ownerType: 'customer',
      ownerGuid: 'cust1',
      transferAccountGuid: 'bank1',
      amount: 105,
      date: '2026-03-01',
    });

    expect(
      holder.db!.$rawSql.some(
        (sql: string) => sql.includes('FROM invoices') && sql.includes('FOR UPDATE')
      )
    ).toBe(true);
  });

  it('applyPayment allocates oldest-first, assigns lots and closes paid lots', async () => {
    const inv1 = await createInvoice(BOOK_A, customerInvoiceInput()); // 105 total
    await postInvoice(BOOK_A, inv1.guid, { postDate: '2026-01-05' });
    const inv2 = await createInvoice(BOOK_A, {
      ...customerInvoiceInput(),
      entries: [{ quantity: 4, price: 50, accountGuid: 'inc1', taxable: false }], // 200
    });
    await postInvoice(BOOK_A, inv2.guid, { postDate: '2026-02-05' });

    const result = await applyPayment(BOOK_A, {
      ownerType: 'customer',
      ownerGuid: 'cust1',
      transferAccountGuid: 'bank1',
      amount: 150,
      date: '2026-03-01',
      memo: 'Check 1001',
    });

    expect(result.allocations).toEqual([
      { invoiceGuid: inv1.guid, amount: 105 },
      { invoiceGuid: inv2.guid, amount: 45 },
    ]);
    expect(result.fullyPaidInvoiceGuids).toEqual([inv1.guid]);

    const splits = holder.db!.splits.rows.filter((s: Row) => s.tx_guid === result.transactionGuid);
    expect(splits.find((s: Row) => s.account_guid === 'bank1')).toMatchObject({
      value_num: 15000n,
      lot_guid: null,
      memo: 'Check 1001',
    });
    const arSplits = splits.filter((s: Row) => s.account_guid === 'ar1');
    expect(arSplits.map((s: Row) => s.value_num).sort()).toEqual([-10500n, -4500n]);
    expect(arSplits.every((s: Row) => s.action === 'Payment')).toBe(true);

    // Payment txn slot
    const typeSlot = req(
      holder.db!.slots.rows.find(
        (s: Row) => s.obj_guid === result.transactionGuid && s.name === 'trans-txn-type'
      )
    );
    expect(typeSlot.string_val).toBe('P');

    // First invoice fully paid; second partially
    const inv1After = await getView(inv1.guid);
    expect(inv1After.amountDue).toBe(0);
    expect(inv1After.status).toBe('paid');
    const lot1 = req(holder.db!.lots.rows.find((l: Row) => l.guid === inv1After.postLotGuid));
    expect(lot1.is_closed).toBe(1);

    const inv2After = await getView(inv2.guid);
    expect(inv2After.amountDue).toBe(155);

    // Payment listing
    const payments = await listPayments(BOOK_A, 'customer', 'cust1');
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(150);
    expect(payments[0].allocations).toHaveLength(2);
  });

  it('reuses a caller-supplied payment transaction GUID idempotently', async () => {
    const invoice = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, invoice.guid, { postDate: '2026-01-05' });
    const transactionGuid = 'a'.repeat(32);
    const input = {
      ownerType: 'customer' as const,
      ownerGuid: 'cust1',
      transferAccountGuid: 'bank1',
      amount: 105,
      date: '2026-03-01',
      allocations: [{ invoiceGuid: invoice.guid, amount: 105 }],
      transactionGuid,
    };

    const first = await applyPayment(BOOK_A, input);
    const second = await applyPayment(BOOK_A, input);

    expect(first.transactionGuid).toBe(transactionGuid);
    expect(second.transactionGuid).toBe(transactionGuid);
    expect(holder.db!.transactions.rows.filter((row: Row) => row.guid === transactionGuid)).toHaveLength(1);
  });

  it('rejects overpayments cleanly', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    await expect(
      applyPayment(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust1',
        transferAccountGuid: 'bank1',
        amount: 500,
        date: '2026-03-01',
      })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });

  it('rejects explicit allocations that exceed the amount due', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    await expect(
      applyPayment(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust1',
        transferAccountGuid: 'bank1',
        amount: 200,
        date: '2026-03-01',
        allocations: [{ invoiceGuid: inv.guid, amount: 200 }],
      })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });

  it('unpost refuses while payments are applied', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });

    await applyPayment(BOOK_A, {
      ownerType: 'customer',
      ownerGuid: 'cust1',
      transferAccountGuid: 'bank1',
      amount: 50,
      date: '2026-02-01',
    });
    await expect(unpostInvoice(BOOK_A, inv.guid)).rejects.toBeInstanceOf(InvoiceStateError);
    await expect(unpostInvoice(BOOK_A, inv.guid)).rejects.toThrow(/payments are applied/);

    // Refusal is total: nothing was reversed, the invoice is still posted.
    expect(req(holder.db!.invoices.rows.find((i: Row) => i.guid === inv.guid)).post_txn).toBe(
      posted.transactionGuid
    );
  });

  // -------------------------------------------------------------------------
  // Unpost REVERSES, it does not delete (H8)
  //
  // Deleting a posted transaction destroys the audit trail, silently restates
  // whatever period it sat in, and can take a split that was reconciled
  // against a statement with it. These cases pin the reversal down: the
  // original survives untouched, an equal-and-opposite transaction cancels it,
  // and every affected account nets to zero.
  // -------------------------------------------------------------------------

  /** Net value per account across EVERY split in the book, in cents. */
  const netByAccount = () => {
    const net = new Map<string, bigint>();
    for (const s of holder.db!.splits.rows) {
      expect(s.value_denom).toBe(100n); // fixtures are USD cents throughout
      net.set(s.account_guid, (net.get(s.account_guid) ?? 0n) + s.value_num);
    }
    return net;
  };

  const splitsOf = (txGuid: string) =>
    holder.db!.splits.rows.filter((s: Row) => s.tx_guid === txGuid);

  const slotsOf = (objGuid: string) =>
    holder.db!.slots.rows.filter((s: Row) => s.obj_guid === objGuid);

  /** The one transaction that is not the invoice's posting transaction. */
  const reversalOf = (postTxnGuid: string) =>
    req(holder.db!.transactions.rows.find((t: Row) => t.guid !== postTxnGuid));

  const today = () => new Date().toISOString().slice(0, 10);

  it('unpost keeps the posting transaction and writes an equal-and-opposite reversal', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    const before = splitsOf(posted.transactionGuid).map((s: Row) => ({ ...s }));

    await unpostInvoice(BOOK_A, inv.guid);

    // 1. The original posting transaction and its splits are still there,
    //    byte for byte.
    expect(holder.db!.transactions.rows.find((t: Row) => t.guid === posted.transactionGuid)).toBeTruthy();
    const after = splitsOf(posted.transactionGuid);
    expect(after).toHaveLength(3);
    for (const original of before) {
      const still = req(after.find((s: Row) => s.guid === original.guid));
      expect(still.account_guid).toBe(original.account_guid);
      expect(still.value_num).toBe(original.value_num);
      expect(still.quantity_num).toBe(original.quantity_num);
      expect(still.reconcile_state).toBe(original.reconcile_state);
    }

    // 2. A reversing transaction exists: same accounts, negated values,
    //    balanced on its own.
    expect(holder.db!.transactions.rows).toHaveLength(2);
    const reversal = reversalOf(posted.transactionGuid);
    const reversalSplits = splitsOf(reversal.guid);
    expect(reversalSplits).toHaveLength(3);
    for (const original of before) {
      const mirror = req(
        reversalSplits.find((s: Row) => s.account_guid === original.account_guid)
      );
      expect(mirror.value_num).toBe(-original.value_num);
      expect(mirror.value_denom).toBe(original.value_denom);
      expect(mirror.quantity_num).toBe(-original.quantity_num);
      expect(mirror.reconcile_state).toBe('n');
    }
    expect(reversalSplits.reduce((sum: bigint, s: Row) => sum + s.value_num, 0n)).toBe(0n);

    // 3. Net effect on every affected account is exactly zero.
    const net = netByAccount();
    expect(net.get('ar1')).toBe(0n);
    expect(net.get('inc1')).toBe(0n);
    expect(net.get('tax1')).toBe(0n);

    // 4. The invoice reads as a draft again.
    const view = await getView(inv.guid);
    expect(view.posted).toBe(false);
    expect(view.status).toBe('draft');
    expect(view.postTxnGuid).toBeNull();
    const invRow = req(holder.db!.invoices.rows.find((i: Row) => i.guid === inv.guid));
    expect(invRow.post_txn).toBeNull();
    expect(invRow.post_acc).toBeNull();
    expect(invRow.post_lot).toBeNull();
    expect(invRow.date_posted).toBeNull();
  });

  it('unpost retires the native invoice linkage and records the reversal pair', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    const postingFrame = req(
      slotsOf(posted.transactionGuid).find((s: Row) => s.name === 'gncInvoice')
    );

    await unpostInvoice(BOOK_A, inv.guid);
    const reversal = reversalOf(posted.transactionGuid);

    // The 'this IS invoice X's posting' pointer is gone from the transaction
    // and the lot — invoice and book agree that nothing is posted — and the
    // frame's child row went with it.
    const postingSlots = slotsOf(posted.transactionGuid);
    expect(postingSlots.find((s: Row) => s.name === 'gncInvoice')).toBeUndefined();
    expect(slotsOf(postingFrame.guid_val)).toHaveLength(0);
    expect(slotsOf(posted.lotGuid).find((s: Row) => s.name === 'gncInvoice')).toBeUndefined();

    // The history is kept in readable form on both transactions.
    expect(postingSlots.find((s: Row) => s.name === 'gncweb-unposted-invoice-guid')?.string_val).toBe(inv.guid);
    expect(postingSlots.find((s: Row) => s.name === 'gncweb-reversed-by-txn')?.string_val).toBe(reversal.guid);
    expect(postingSlots.find((s: Row) => s.name === 'trans-read-only')?.string_val).toMatch(/audit trail/);
    const reversalSlots = slotsOf(reversal.guid);
    expect(reversalSlots.find((s: Row) => s.name === 'gncweb-reverses-txn')?.string_val).toBe(posted.transactionGuid);
    expect(reversalSlots.find((s: Row) => s.name === 'trans-read-only')?.string_val).toMatch(/Reverses the posting/);

    // The lot survives (the original split still references it) and closes,
    // because posting + reversal sum to zero.
    const lot = req(holder.db!.lots.rows.find((l: Row) => l.guid === posted.lotGuid));
    expect(lot.is_closed).toBe(1);
    const lotSplits = holder.db!.splits.rows.filter((s: Row) => s.lot_guid === posted.lotGuid);
    expect(lotSplits).toHaveLength(2);
    expect(lotSplits.reduce((sum: bigint, s: Row) => sum + s.value_num, 0n)).toBe(0n);

    // ...and the reversal split in that lot is NOT mistaken for a payment.
    expect(await listPayments(BOOK_A, 'customer', 'cust1')).toEqual([]);
  });

  it('dates the reversal today, leaving the original period as it was reported', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2020-03-15' });

    await unpostInvoice(BOOK_A, inv.guid);

    const original = req(holder.db!.transactions.rows.find((t: Row) => t.guid === posted.transactionGuid));
    expect(original.post_date.toISOString()).toBe('2020-03-15T12:00:00.000Z');
    const reversal = reversalOf(posted.transactionGuid);
    expect(reversal.post_date.toISOString().slice(0, 10)).toBe(today());
    expect(reversal.description).toMatch(/^Unpost reversal —/);
    expect(reversal.num).toBe(original.num);
  });

  it('never dates a reversal before the posting it reverses', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: future });

    await unpostInvoice(BOOK_A, inv.guid);

    const reversal = reversalOf(posted.transactionGuid);
    expect(reversal.post_date.toISOString().slice(0, 10)).toBe(future);
  });

  it('post -> unpost -> repost leaves exactly one invoice on the books', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const first = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    await unpostInvoice(BOOK_A, inv.guid);
    const second = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-02-10' });

    // Three transactions: the original, its reversal, the new posting.
    expect(holder.db!.transactions.rows).toHaveLength(3);
    expect(second.transactionGuid).not.toBe(first.transactionGuid);
    for (const t of holder.db!.transactions.rows) {
      expect(splitsOf(t.guid).reduce((sum: bigint, s: Row) => sum + s.value_num, 0n)).toBe(0n);
    }

    // No double count: the first pair cancelled, so the book carries exactly
    // one invoice's worth.
    const net = netByAccount();
    expect(net.get('ar1')).toBe(10500n);
    expect(net.get('inc1')).toBe(-10000n);
    expect(net.get('tax1')).toBe(-500n);

    // The re-post owns a fresh lot; the retired one stays closed.
    expect(second.lotGuid).not.toBe(first.lotGuid);
    expect(req(holder.db!.lots.rows.find((l: Row) => l.guid === first.lotGuid)).is_closed).toBe(1);
    expect(req(holder.db!.lots.rows.find((l: Row) => l.guid === second.lotGuid)).is_closed).toBe(0);

    const view = await getView(inv.guid);
    expect(view.posted).toBe(true);
    expect(view.postTxnGuid).toBe(second.transactionGuid);
    expect(view.amountDue).toBe(105);

    // And the re-posted invoice can still be paid in full.
    await applyPayment(BOOK_A, {
      ownerType: 'customer',
      ownerGuid: 'cust1',
      transferAccountGuid: 'bank1',
      amount: 105,
      date: '2026-03-01',
    });
    expect((await getView(inv.guid)).amountDue).toBe(0);
  });

  it('a reconciled posting split does not block unpost, and is left untouched', async () => {
    // The reconciled-split guard (src/lib/services/reconciled-split.service.ts)
    // blocks amount/account/date changes and deletions. A reversal does none
    // of those — it only INSERTs new, unreconciled splits — so it must be
    // allowed on a book whose A/R has already been reconciled, and the
    // reconciled row must come through unchanged.
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    const arSplit = req(
      splitsOf(posted.transactionGuid).find((s: Row) => s.account_guid === 'ar1')
    );
    arSplit.reconcile_state = 'y';
    arSplit.reconcile_date = new Date('2026-01-31T00:00:00Z');

    await unpostInvoice(BOOK_A, inv.guid);

    const still = req(holder.db!.splits.rows.find((s: Row) => s.guid === arSplit.guid));
    expect(still.reconcile_state).toBe('y');
    expect(still.value_num).toBe(10500n);
    expect(still.account_guid).toBe('ar1');
    const reversal = reversalOf(posted.transactionGuid);
    expect(req(splitsOf(reversal.guid).find((s: Row) => s.account_guid === 'ar1')).reconcile_state).toBe('n');
    expect(netByAccount().get('ar1')).toBe(0n);
  });

  it('refuses to reverse a posting whose receivable split was moved elsewhere', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    req(splitsOf(posted.transactionGuid).find((s: Row) => s.account_guid === 'ar1')).account_guid = 'bank1';

    await expect(unpostInvoice(BOOK_A, inv.guid)).rejects.toBeInstanceOf(InvoiceStateError);
    await expect(unpostInvoice(BOOK_A, inv.guid)).rejects.toThrow(/has moved from account ar1 to bank1/);

    // Loud, not lossy: no reversal written, invoice still posted.
    expect(holder.db!.transactions.rows).toHaveLength(1);
    expect(req(holder.db!.invoices.rows.find((i: Row) => i.guid === inv.guid)).post_txn).toBe(
      posted.transactionGuid
    );
  });

  it('refuses to reverse a posting that no longer balances', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    req(splitsOf(posted.transactionGuid).find((s: Row) => s.account_guid === 'inc1')).value_num = -9000n;

    await expect(unpostInvoice(BOOK_A, inv.guid)).rejects.toThrow(/does not balance/);
    expect(holder.db!.transactions.rows).toHaveLength(1);
  });

  it('refuses to reverse a posting transaction that has vanished', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    const posted = await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });
    holder.db!.transactions.rows.length = 0;
    holder.db!.splits.rows.length = 0;

    await expect(unpostInvoice(BOOK_A, inv.guid)).rejects.toThrow(/no longer exists/);
    expect(req(holder.db!.invoices.rows.find((i: Row) => i.guid === inv.guid)).post_txn).toBe(
      posted.transactionGuid
    );
  });

  it('listInvoices filters by type and status', async () => {
    const inv = await createInvoice(BOOK_A, customerInvoiceInput());
    await createInvoice(BOOK_A, {
      ownerType: 'vendor',
      ownerGuid: 'vend1',
      entries: [{ quantity: 1, price: 40, accountGuid: 'exp1', taxable: false }],
    });
    await postInvoice(BOOK_A, inv.guid, { postDate: '2026-01-05' });

    const invoicesOnly = await listInvoices(BOOK_A, { type: 'invoice' });
    expect(invoicesOnly).toHaveLength(1);
    expect(invoicesOnly[0].guid).toBe(inv.guid);

    const bills = await listInvoices(BOOK_A, { type: 'bill' });
    expect(bills).toHaveLength(1);
    expect(bills[0].status).toBe('draft');

    // Posted Net-30 invoice from 2026-01-05 is overdue by "today" (real clock)
    const overdue = await listInvoices(BOOK_A, { status: 'overdue' });
    expect(overdue.map((v) => v.guid)).toContain(inv.guid);

    const drafts = await listInvoices(BOOK_A, { status: 'draft' });
    expect(drafts).toHaveLength(1);
  });
});

// ===========================================================================
// Part 3 — cross-book isolation (audit S5)
//
// The native GnuCash business tables have no book_guid, so before ownership
// existed every book's API returned every book's invoices, and PUT/DELETE on
// a foreign invoice succeeded. Each case below asserts the closed behaviour:
// a foreign document is indistinguishable from a missing one.
// ===========================================================================

describe('invoice engine — book scope', () => {
  beforeEach(() => {
    holder.db = seedDb();
  });

  /** An invoice living in book B, created through the engine as book B. */
  const bookBInvoice = () =>
    createInvoice(BOOK_B, {
      ownerType: 'customer' as const,
      ownerGuid: 'cust2',
      dateOpened: '2026-01-05',
      entries: [{ description: 'Book B work', quantity: 1, price: 90, accountGuid: 'inc2', taxable: false }],
    });

  const bookAInvoice = () =>
    createInvoice(BOOK_A, {
      ownerType: 'customer' as const,
      ownerGuid: 'cust1',
      dateOpened: '2026-01-05',
      entries: [{ description: 'Book A work', quantity: 1, price: 10, accountGuid: 'inc1', taxable: false }],
    });

  it('createInvoice records ownership for the creating book', async () => {
    const view = await bookAInvoice();
    const rows = holder.db!.gnucash_web_business_entity_ownership.rows;
    expect(rows).toContainEqual(
      expect.objectContaining({ entity_type: 'invoice', entity_guid: view.guid, book_guid: BOOK_A }),
    );
  });

  it('rejects an invoice billed to another book\'s customer', async () => {
    await expect(
      createInvoice(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust2', // owned by book B
        entries: [{ quantity: 1, price: 10, accountGuid: 'inc1' }],
      }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
    expect(holder.db!.invoices.rows).toHaveLength(0);
  });

  it('rejects an invoice whose entry account lives in another book', async () => {
    await expect(
      createInvoice(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust1',
        entries: [{ quantity: 1, price: 10, accountGuid: 'inc2' }],
      }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it('treats an invoice with NO ownership row as foreign, not as public', async () => {
    const view = await bookAInvoice();
    holder.db!.gnucash_web_business_entity_ownership.rows.length = 0;
    expect(await getInvoiceWithStatus(BOOK_A, view.guid)).toBeNull();
    expect(await listInvoices(BOOK_A)).toEqual([]);
  });

  it('listInvoices never returns another book\'s invoice', async () => {
    const mine = await bookAInvoice();
    const theirs = await bookBInvoice();

    const listA = await listInvoices(BOOK_A);
    expect(listA.map((v) => v.guid)).toEqual([mine.guid]);

    const listB = await listInvoices(BOOK_B);
    expect(listB.map((v) => v.guid)).toEqual([theirs.guid]);
  });

  it('getInvoiceWithStatus returns null for a foreign guid', async () => {
    const theirs = await bookBInvoice();
    expect(await getInvoiceWithStatus(BOOK_A, theirs.guid)).toBeNull();
    expect(await buildInvoiceView(BOOK_A, theirs.guid)).toBeNull();
    // ...and the owning book still sees it.
    expect((await getInvoiceWithStatus(BOOK_B, theirs.guid))?.guid).toBe(theirs.guid);
  });

  it('updateInvoice on a foreign guid is a no-op reported as not found', async () => {
    const theirs = await bookBInvoice();
    expect(await updateInvoice(BOOK_A, theirs.guid, { notes: 'hijacked' })).toBeNull();

    const row = req(holder.db!.invoices.rows.find((i: Row) => i.guid === theirs.guid));
    expect(row.notes).not.toBe('hijacked');
  });

  it('deleteInvoice on a foreign guid leaves the invoice standing', async () => {
    const theirs = await bookBInvoice();
    expect(await deleteInvoice(BOOK_A, theirs.guid)).toBeNull();

    expect(holder.db!.invoices.rows.find((i: Row) => i.guid === theirs.guid)).toBeTruthy();
    expect(holder.db!.entries.rows.filter((e: Row) => e.invoice === theirs.guid)).toHaveLength(1);
  });

  it('deleteInvoice removes the ownership row with the invoice', async () => {
    const mine = await bookAInvoice();
    expect(await deleteInvoice(BOOK_A, mine.guid)).toEqual({ guid: mine.guid });
    expect(
      holder.db!.gnucash_web_business_entity_ownership.rows.find(
        (r: Row) => r.entity_type === 'invoice' && r.entity_guid === mine.guid,
      ),
    ).toBeUndefined();
  });

  it('postInvoice on a foreign guid is rejected and posts nothing', async () => {
    const theirs = await bookBInvoice();
    await expect(
      postInvoice(BOOK_A, theirs.guid, { postDate: '2026-01-05' }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);

    const row = req(holder.db!.invoices.rows.find((i: Row) => i.guid === theirs.guid));
    expect(row.post_txn).toBeNull();
    expect(holder.db!.transactions.rows).toHaveLength(0);
  });

  it('posts into the OWNING book\'s A/R account, never the caller\'s', async () => {
    const theirs = await bookBInvoice();
    const result = await postInvoice(BOOK_B, theirs.guid, { postDate: '2026-01-05' });
    expect(result.postAccountGuid).toBe('ar2');
  });

  it('unpostInvoice on a foreign guid is rejected', async () => {
    const theirs = await bookBInvoice();
    await postInvoice(BOOK_B, theirs.guid, { postDate: '2026-01-05' });
    await expect(unpostInvoice(BOOK_A, theirs.guid)).rejects.toBeInstanceOf(InvoiceNotFoundError);

    const row = req(holder.db!.invoices.rows.find((i: Row) => i.guid === theirs.guid));
    expect(row.post_txn).toBeTruthy();
  });

  it('applyPayment cannot reach another book\'s owner or invoice', async () => {
    const theirs = await bookBInvoice();
    await postInvoice(BOOK_B, theirs.guid, { postDate: '2026-01-05' });

    // Owner belongs to book B
    await expect(
      applyPayment(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust2',
        transferAccountGuid: 'bank1',
        amount: 90,
        date: '2026-01-10',
      }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);

    // Book A's own customer cannot be used to allocate against book B's invoice
    await expect(
      applyPayment(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust1',
        transferAccountGuid: 'bank1',
        amount: 90,
        date: '2026-01-10',
        allocations: [{ invoiceGuid: theirs.guid, amount: 90 }],
      }),
    ).rejects.toBeInstanceOf(InvoiceValidationError);

    expect(holder.db!.transactions.rows.filter((t: Row) => t.num === '')).toHaveLength(0);
  });

  it('applyPayment rejects a transfer account from another book', async () => {
    const mine = await bookAInvoice();
    await postInvoice(BOOK_A, mine.guid, { postDate: '2026-01-05' });
    await expect(
      applyPayment(BOOK_A, {
        ownerType: 'customer',
        ownerGuid: 'cust1',
        transferAccountGuid: 'bank2', // book B's bank
        amount: 10,
        date: '2026-01-10',
      }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it('listPayments returns nothing for another book\'s owner', async () => {
    const theirs = await bookBInvoice();
    await postInvoice(BOOK_B, theirs.guid, { postDate: '2026-01-05' });
    await applyPayment(BOOK_B, {
      ownerType: 'customer',
      ownerGuid: 'cust2',
      transferAccountGuid: 'bank2',
      amount: 90,
      date: '2026-01-10',
    });

    expect(await listPayments(BOOK_A, 'customer', 'cust2')).toEqual([]);
    expect(await listPayments(BOOK_B, 'customer', 'cust2')).toHaveLength(1);
  });
});

// ===========================================================================
// Part 3 — the view's due date comes from the POSTING, not current terms
// ===========================================================================

describe('invoice view due date — stored, never recomputed', () => {
  beforeEach(() => {
    holder.db = seedDb();
  });

  const getView = async (guid: string) => req(await getInvoiceWithStatus(BOOK_A, guid));

  const net30Invoice = () =>
    createInvoice(BOOK_A, {
      ownerType: 'customer',
      ownerGuid: 'cust1',
      dateOpened: '2026-01-05',
      termsGuid: 'net30',
      entries: [{ description: 'Consulting', quantity: 2, price: 50, accountGuid: 'inc1', taxable: false }],
    });

  /** The `trans-date-due` slot the posting engine wrote for this invoice. */
  const storedDueSlot = (postTxnGuid: string) =>
    holder.db!.slots.rows.find(
      (s: Row) => s.obj_guid === postTxnGuid && s.name === 'trans-date-due',
    );

  /**
   * The aging report's view of the same invoice, built the way
   * loadOpenInvoices() builds it: post date + the stored slot + lot balance.
   */
  const agingRowFor = (view: { guid: string; id: string; postTxnGuid: string | null; postLotGuid: string | null }) => {
    const invoiceRow = req(holder.db!.invoices.rows.find((i: Row) => i.guid === view.guid));
    const lotBalance = holder.db!.splits.rows
      .filter((s: Row) => s.lot_guid === view.postLotGuid)
      .reduce((sum: number, s: Row) => sum + Number(s.value_num) / Number(s.value_denom), 0);
    return {
      guid: view.guid,
      id: view.id,
      ownerGuid: 'cust1',
      ownerName: 'Acme Corp',
      datePosted: invoiceRow.date_posted as Date,
      dueDate: (storedDueSlot(view.postTxnGuid ?? '')?.timespec_val ?? null) as Date | null,
      lotBalance,
      currency: 'USD',
    };
  };

  it('keeps the posted due date after the bill terms are edited', async () => {
    const draft = await net30Invoice();
    await postInvoice(BOOK_A, draft.guid, { postDate: '2026-01-05' });
    expect((await getView(draft.guid)).dueDate).toBe('2026-02-04'); // net 30

    // The vendor/customer renegotiates: Net 30 becomes Net 5. The ALREADY
    // POSTED document keeps the due date it was posted with.
    req(holder.db!.billterms.rows.find((t: Row) => t.guid === 'net30')).duedays = 5;

    const view = await getView(draft.guid);
    expect(view.dueDate).toBe('2026-02-04');
    expect(view.dueDateInferred).toBe(false);
  });

  it('honours an explicit due-date override and agrees with the aging report', async () => {
    const draft = await net30Invoice();
    // Explicit override, deliberately EARLIER than the Net 30 terms would give.
    const result = await postInvoice(BOOK_A, draft.guid, {
      postDate: '2026-01-05',
      dueDate: '2026-01-12',
    });
    expect(result.dueDate).toBe('2026-01-12');

    const view = await getView(draft.guid);
    expect(view.dueDate).toBe('2026-01-12');
    expect(view.dueDateInferred).toBe(false);

    // Same invoice, aging report's answer — the two screens must agree.
    const asOf = new Date('2026-01-20T12:00:00Z');
    const aging = buildAgingReport([agingRowFor(view)], 'ar', asOf);
    const agingInvoice = aging.owners[0].invoices[0];
    expect(agingInvoice.dueDate).toBe(view.dueDate);
    expect(agingInvoice.dueDateInferred).toBe(view.dueDateInferred);
    expect(agingInvoice.daysPastDue).toBe(8);
    // ...and so must the badge: past due on the 20th under the override, but
    // NOT under the Net 30 terms (which would have said 2026-02-04).
    expect(invoiceStatus(true, view.amountDue, new Date(view.dueDate!), asOf)).toBe('overdue');
    expect(view.status).toBe('overdue');
  });

  it('falls back to the post date, flagged inferred, when no due-date slot exists', async () => {
    const draft = await net30Invoice();
    const result = await postInvoice(BOOK_A, draft.guid, { postDate: '2026-01-05' });

    // A posting made by something that never wrote `trans-date-due` (legacy
    // import, hand-edited book).
    holder.db!.slots.rows.splice(
      holder.db!.slots.rows.indexOf(req(storedDueSlot(result.transactionGuid))),
      1,
    );

    const view = await getView(draft.guid);
    expect(view.dueDate).toBe('2026-01-05'); // the post date, not post + 30
    expect(view.dueDateInferred).toBe(true);

    const aging = buildAgingReport([agingRowFor(view)], 'ar', new Date('2026-01-20T12:00:00Z'));
    expect(aging.owners[0].invoices[0].dueDate).toBe(view.dueDate);
    expect(aging.owners[0].invoices[0].dueDateInferred).toBe(true);
  });

  it('reports drafts as neither due nor inferred', async () => {
    const draft = await net30Invoice();
    const view = await getView(draft.guid);
    expect(view.status).toBe('draft');
    expect(view.dueDate).toBeNull();
    expect(view.dueDateInferred).toBe(false);
  });

  it('listInvoices reads the same stored due date as the detail view', async () => {
    const draft = await net30Invoice();
    await postInvoice(BOOK_A, draft.guid, { postDate: '2026-01-05', dueDate: '2026-01-12' });
    req(holder.db!.billterms.rows.find((t: Row) => t.guid === 'net30')).duedays = 5;

    const [listed] = await listInvoices(BOOK_A, { type: 'invoice' });
    const detail = await getView(draft.guid);
    expect(listed.dueDate).toBe('2026-01-12');
    expect(listed.dueDate).toBe(detail.dueDate);
    expect(listed.dueDateInferred).toBe(false);
  });

  it('listInvoices flags an inferred due date in the batch path too', async () => {
    const draft = await net30Invoice();
    const result = await postInvoice(BOOK_A, draft.guid, { postDate: '2026-01-05' });
    holder.db!.slots.rows.splice(
      holder.db!.slots.rows.indexOf(req(storedDueSlot(result.transactionGuid))),
      1,
    );

    const [listed] = await listInvoices(BOOK_A, { type: 'invoice' });
    expect(listed.dueDate).toBe('2026-01-05');
    expect(listed.dueDateInferred).toBe(true);
  });
});
