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

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as any[]).some((w) => matches(row, w))) return false;
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

interface FakeDb {
  [table: string]: ReturnType<typeof model>;
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
          // Raw queries here are the period-lock guard's lookups
          // (gnucash_web_book_settings / account→book resolution) — return no
          // rows so engine tests run against an unlocked book.
          return async () => [];
        }
        return holder.db?.[prop];
      },
    }
  ),
}));

function seedDb(): FakeDb {
  slotAutoId = 1;
  return {
    books: model([{ guid: 'book1', root_account_guid: 'root' }]),
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
    ]),
    customers: model([
      { guid: 'cust1', name: 'Acme Corp', id: '000001', notes: '', active: 1, currency: 'usd', tax_override: 0, terms: null, discount_num: 0n, discount_denom: 1n, credit_num: 0n, credit_denom: 1n },
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
  };
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
  InvoiceValidationError,
  InvoiceStateError,
} from '../invoice-engine';

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
    const view = await createInvoice(customerInvoiceInput());
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
    const view = await createInvoice({
      ownerType: 'vendor',
      ownerGuid: 'vend1',
      dateOpened: '2026-01-05',
      bookGuid: 'book1',
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
      createInvoice({
        ownerType: 'vendor',
        ownerGuid: 'vend1',
        bookGuid: 'book1',
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
    const view = await createInvoice(customerInvoiceInput());
    expect(view.id).toBe('000043');
    const counter = req(holder.db!.slots.rows.find((s: Row) => s.name === 'counters/gncInvoice'));
    expect(counter.int64_val).toBe(43n);
  });

  it('postInvoice creates the GnuCash-native transaction, splits, lot and slots', async () => {
    const view = await createInvoice(customerInvoiceInput());
    const result = await postInvoice(view.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });

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

    const after = await getInvoiceWithStatus(view.guid);
    // Unpaid and past the 2026-02-04 due date relative to the real clock
    expect(after.status).toBe('overdue');
    expect(after.amountDue).toBe(105);
    expect(after.dueDate).toBe('2026-02-04');
  });

  it('bill posting flips signs (credit A/P, debit expense)', async () => {
    const bill = await createInvoice({
      ownerType: 'vendor',
      ownerGuid: 'vend1',
      bookGuid: 'book1',
      entries: [{ quantity: 10, price: 4, accountGuid: 'exp1', taxable: false }],
    });
    const result = await postInvoice(bill.guid, { postDate: '2026-01-10', bookRootGuid: 'root' });
    const splits = holder.db!.splits.rows.filter((s: Row) => s.tx_guid === result.transactionGuid);
    expect(req(splits.find((s: Row) => s.account_guid === 'ap1')).value_num).toBe(-4000n);
    expect(req(splits.find((s: Row) => s.account_guid === 'exp1')).value_num).toBe(4000n);
    expect(req(splits.find((s: Row) => s.account_guid === 'ap1')).lot_guid).toBe(result.lotGuid);
  });

  it('updateInvoice/deleteInvoice refuse posted invoices', async () => {
    const view = await createInvoice(customerInvoiceInput());
    await postInvoice(view.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });
    await expect(updateInvoice(view.guid, { notes: 'x' })).rejects.toBeInstanceOf(InvoiceStateError);
    await expect(deleteInvoice(view.guid)).rejects.toBeInstanceOf(InvoiceStateError);
  });

  it('applyPayment allocates oldest-first, assigns lots and closes paid lots', async () => {
    const inv1 = await createInvoice(customerInvoiceInput()); // 105 total
    await postInvoice(inv1.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });
    const inv2 = await createInvoice({
      ...customerInvoiceInput(),
      entries: [{ quantity: 4, price: 50, accountGuid: 'inc1', taxable: false }], // 200
    });
    await postInvoice(inv2.guid, { postDate: '2026-02-05', bookRootGuid: 'root' });

    const result = await applyPayment({
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
    const inv1After = await getInvoiceWithStatus(inv1.guid);
    expect(inv1After.amountDue).toBe(0);
    expect(inv1After.status).toBe('paid');
    const lot1 = req(holder.db!.lots.rows.find((l: Row) => l.guid === inv1After.postLotGuid));
    expect(lot1.is_closed).toBe(1);

    const inv2After = await getInvoiceWithStatus(inv2.guid);
    expect(inv2After.amountDue).toBe(155);

    // Payment listing
    const payments = await listPayments('customer', 'cust1');
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(150);
    expect(payments[0].allocations).toHaveLength(2);
  });

  it('rejects overpayments cleanly', async () => {
    const inv = await createInvoice(customerInvoiceInput());
    await postInvoice(inv.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });
    await expect(
      applyPayment({
        ownerType: 'customer',
        ownerGuid: 'cust1',
        transferAccountGuid: 'bank1',
        amount: 500,
        date: '2026-03-01',
      })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });

  it('rejects explicit allocations that exceed the amount due', async () => {
    const inv = await createInvoice(customerInvoiceInput());
    await postInvoice(inv.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });
    await expect(
      applyPayment({
        ownerType: 'customer',
        ownerGuid: 'cust1',
        transferAccountGuid: 'bank1',
        amount: 200,
        date: '2026-03-01',
        allocations: [{ invoiceGuid: inv.guid, amount: 200 }],
      })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });

  it('unpost removes the transaction, lot and slots; refuses when paid', async () => {
    const inv = await createInvoice(customerInvoiceInput());
    const posted = await postInvoice(inv.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });

    // With a payment attached: refuse
    await applyPayment({
      ownerType: 'customer',
      ownerGuid: 'cust1',
      transferAccountGuid: 'bank1',
      amount: 50,
      date: '2026-02-01',
    });
    await expect(unpostInvoice(inv.guid)).rejects.toBeInstanceOf(InvoiceStateError);

    // Fresh invoice with no payments: unpost cleans everything up
    const inv2 = await createInvoice(customerInvoiceInput());
    const posted2 = await postInvoice(inv2.guid, { postDate: '2026-01-06', bookRootGuid: 'root' });
    await unpostInvoice(inv2.guid);

    expect(holder.db!.transactions.rows.find((t: Row) => t.guid === posted2.transactionGuid)).toBeUndefined();
    expect(holder.db!.lots.rows.find((l: Row) => l.guid === posted2.lotGuid)).toBeUndefined();
    expect(holder.db!.splits.rows.filter((s: Row) => s.tx_guid === posted2.transactionGuid)).toHaveLength(0);
    expect(
      holder.db!.slots.rows.filter(
        (s: Row) => s.obj_guid === posted2.transactionGuid || s.obj_guid === posted2.lotGuid
      )
    ).toHaveLength(0);

    const after = await getInvoiceWithStatus(inv2.guid);
    expect(after.posted).toBe(false);
    expect(after.status).toBe('draft');
    expect(after.postTxnGuid).toBeNull();

    // The first invoice's posting remains untouched
    expect(holder.db!.transactions.rows.find((t: Row) => t.guid === posted.transactionGuid)).toBeTruthy();
  });

  it('listInvoices filters by type and status', async () => {
    const inv = await createInvoice(customerInvoiceInput());
    await createInvoice({
      ownerType: 'vendor',
      ownerGuid: 'vend1',
      bookGuid: 'book1',
      entries: [{ quantity: 1, price: 40, accountGuid: 'exp1', taxable: false }],
    });
    await postInvoice(inv.guid, { postDate: '2026-01-05', bookRootGuid: 'root' });

    const invoicesOnly = await listInvoices({ type: 'invoice' });
    expect(invoicesOnly).toHaveLength(1);
    expect(invoicesOnly[0].guid).toBe(inv.guid);

    const bills = await listInvoices({ type: 'bill' });
    expect(bills).toHaveLength(1);
    expect(bills[0].status).toBe('draft');

    // Posted Net-30 invoice from 2026-01-05 is overdue by "today" (real clock)
    const overdue = await listInvoices({ status: 'overdue' });
    expect(overdue.map((v) => v.guid)).toContain(inv.guid);

    const drafts = await listInvoices({ status: 'draft' });
    expect(drafts).toHaveLength(1);
  });
});
