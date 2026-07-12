/**
 * Desktop-parity business features — pure-core tests:
 *
 *   1. Customer Summary math (sales/expense attribution, profit, markup,
 *      sales-only customers, sorting, totals)
 *   2. Voucher posting split construction (A/P-side balance, lot split)
 *      and voucher numbering (gncExpVoucher counter + fallback)
 *   3. Job Report rollup totals (posted invoices/bills, drafts)
 *   4. Employee voucher summary (outstanding/paid, per-month)
 *
 * Prisma is mocked out (per src/lib/business/__tests__ conventions); every
 * function under test here is either pure or takes an injected db surface.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  buildCustomerSummary,
  markupPercent,
  type RawCustomerFlowRow,
} from '@/lib/business/customer-summary';
import { buildJobReport, type RawJobDocRow } from '@/lib/business/jobs.service';
import {
  buildEmployeeVoucherSummary,
  type RawEmployeeVoucherRow,
} from '@/lib/business/employees.service';
import {
  nextVoucherId,
  VOUCHER_COUNTER,
  type VoucherCounterDb,
} from '@/lib/business/vouchers';
import {
  computeInvoiceTotals,
  buildPostingSplits,
  type EntryLineInput,
} from '@/lib/business/invoice-totals';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// 1. Customer Summary
// ---------------------------------------------------------------------------

function flow(
  customerGuid: string,
  accountType: 'INCOME' | 'EXPENSE',
  amount: number,
  customerName = customerGuid,
): RawCustomerFlowRow {
  return { customerGuid, customerName, accountType, amount };
}

describe('buildCustomerSummary', () => {
  it('negates income credits into positive sales and computes profit/markup', () => {
    const { rows } = buildCustomerSummary([
      flow('acme', 'INCOME', -1000), // credit → 1000 sales
      flow('acme', 'EXPENSE', 400), // debit → 400 expenses
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      customerGuid: 'acme',
      sales: 1000,
      expenses: 400,
      profit: 600,
      markupPercent: 150, // 600 / 400 * 100
    });
  });

  it('includes customers with sales only (markup null without expenses)', () => {
    const { rows } = buildCustomerSummary([flow('solo', 'INCOME', -250)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sales).toBe(250);
    expect(rows[0].expenses).toBe(0);
    expect(rows[0].profit).toBe(250);
    expect(rows[0].markupPercent).toBeNull();
  });

  it('merges multiple flow rows per customer and drops zero-activity rows', () => {
    const { rows } = buildCustomerSummary([
      flow('a', 'INCOME', -100),
      flow('a', 'INCOME', -50),
      flow('a', 'EXPENSE', 30),
      flow('zero', 'INCOME', 0),
      flow('zero', 'EXPENSE', 0),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customerGuid: 'a', sales: 150, expenses: 30, profit: 120 });
  });

  it('sorts by profit descending and totals across customers', () => {
    const { rows, totals } = buildCustomerSummary([
      flow('low', 'INCOME', -100),
      flow('high', 'INCOME', -900),
      flow('high', 'EXPENSE', 100),
      flow('negative', 'INCOME', -50),
      flow('negative', 'EXPENSE', 200),
    ]);
    expect(rows.map((r) => r.customerGuid)).toEqual(['high', 'low', 'negative']);
    expect(totals.sales).toBe(1050);
    expect(totals.expenses).toBe(300);
    expect(totals.profit).toBe(750);
    expect(totals.markupPercent).toBe(250);
    // Loss-making customer has a negative markup
    expect(rows[2].profit).toBe(-150);
    expect(rows[2].markupPercent).toBe(-75);
  });

  it('markupPercent guards a ~zero denominator', () => {
    expect(markupPercent(100, 0)).toBeNull();
    expect(markupPercent(100, 0.004)).toBeNull();
    expect(markupPercent(50, 200)).toBe(25);
  });

  it('credit notes reduce sales (positive income amounts subtract)', () => {
    const { rows } = buildCustomerSummary([
      flow('c', 'INCOME', -500),
      flow('c', 'INCOME', 75), // credit note reverses income
    ]);
    expect(rows[0].sales).toBe(425);
  });
});

// ---------------------------------------------------------------------------
// 2. Vouchers — posting splits (pure core) + numbering
// ---------------------------------------------------------------------------

describe('voucher posting split construction', () => {
  const lines: EntryLineInput[] = [
    { accountGuid: 'exp-travel', description: 'Flight', quantity: 1, price: 431.55 },
    { accountGuid: 'exp-meals', description: 'Meals', quantity: 3, price: 27.4 },
  ];

  it('builds an A/P-side (bill-kind) posting that balances to zero', () => {
    const totals = computeInvoiceTotals(lines, 100);
    expect(totals.total).toBe(513.75);

    const splits = buildPostingSplits('bill', totals, lines, 'ap-account', 'voucher memo');
    const sum = splits.reduce((s, sp) => s + sp.value, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-9);

    // A/P split: CREDIT (negative) for the full total, carries the lot
    const postSplit = splits.find((s) => s.isPostSplit)!;
    expect(postSplit.accountGuid).toBe('ap-account');
    expect(postSplit.value).toBe(-513.75);

    // Expense splits: DEBIT (positive) per line
    const expenseSplits = splits.filter((s) => !s.isPostSplit);
    expect(expenseSplits.map((s) => [s.accountGuid, s.value])).toEqual([
      ['exp-travel', 431.55],
      ['exp-meals', 82.2],
    ]);
  });
});

/** Tiny in-memory slots/invoices fake for the counter logic. */
function fakeCounterDb(seed: {
  slots?: Array<Record<string, any>>;
  voucherIds?: string[];
}): VoucherCounterDb & { slots_rows: Array<Record<string, any>> } {
  const slots = (seed.slots ?? []).map((s, i) => ({ id: i + 1, ...s }));
  let nextId = slots.length + 1;
  const match = (row: Record<string, any>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    slots_rows: slots,
    slots: {
      findFirst: async ({ where }) => slots.find((r) => match(r, where)) ?? null,
      create: async ({ data }) => {
        const row = { id: nextId++, ...data };
        slots.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = slots.find((r) => r.id === where.id);
        if (!row) throw new Error('slot not found');
        Object.assign(row, data);
        return row;
      },
    },
    invoices: {
      findMany: async () => (seed.voucherIds ?? []).map((id) => ({ id })),
    },
  };
}

describe('nextVoucherId', () => {
  it('increments an existing gncExpVoucher counter (frame layout)', async () => {
    const db = fakeCounterDb({
      slots: [
        { obj_guid: 'book1', name: 'counters', slot_type: 9, guid_val: 'frame1' },
        { obj_guid: 'frame1', name: `counters/${VOUCHER_COUNTER}`, slot_type: 1, int64_val: 41n },
      ],
    });
    expect(await nextVoucherId(db, 'book1')).toBe('000042');
    // Counter persisted as the last used number
    const counter = db.slots_rows.find((r) => r.name === `counters/${VOUCHER_COUNTER}`)!;
    expect(counter.int64_val).toBe(42n);
    // A second call keeps counting
    expect(await nextVoucherId(db, 'book1')).toBe('000043');
  });

  it('falls back to max numeric voucher id + 1 and bootstraps the counter', async () => {
    const db = fakeCounterDb({ voucherIds: ['000007', '000012', 'CUSTOM'] });
    expect(await nextVoucherId(db, 'book1')).toBe('000013');
    const counter = db.slots_rows.find((r) => r.name === `counters/${VOUCHER_COUNTER}`)!;
    expect(counter.int64_val).toBe(13n);
    expect(counter.slot_type).toBe(1);
    // The counters frame was created on the book
    const frame = db.slots_rows.find((r) => r.name === 'counters' && r.obj_guid === 'book1')!;
    expect(frame.guid_val).toBe(counter.obj_guid);
    // Follow-up numbering uses the freshly-bootstrapped counter
    expect(await nextVoucherId(db, 'book1')).toBe('000014');
  });

  it('starts at 000001 for an empty book', async () => {
    const db = fakeCounterDb({});
    expect(await nextVoucherId(db, 'book1')).toBe('000001');
  });
});

// ---------------------------------------------------------------------------
// 3. Job Report rollup
// ---------------------------------------------------------------------------

function jobDoc(partial: Partial<RawJobDocRow>): RawJobDocRow {
  return {
    guid: 'g',
    id: '000001',
    jobOwnerType: 2,
    posted: true,
    dateOpened: '2026-01-01',
    datePosted: '2026-01-02',
    postTotal: 0,
    lotBalance: 0,
    entryTotal: null,
    currency: 'USD',
    ...partial,
  };
}

describe('buildJobReport', () => {
  it('normalizes signs and computes total/paid/due per document', () => {
    const report = buildJobReport([
      // Customer-job invoice: positive raw sums, 200 still due
      jobDoc({ guid: 'inv1', jobOwnerType: 2, postTotal: 500, lotBalance: 200 }),
      // Vendor-job bill: negative raw sums, fully paid
      jobDoc({ guid: 'bill1', jobOwnerType: 4, postTotal: -250, lotBalance: 0 }),
    ]);
    const inv = report.documents.find((d) => d.guid === 'inv1')!;
    expect(inv).toMatchObject({ kind: 'invoice', total: 500, paid: 300, due: 200 });
    const bill = report.documents.find((d) => d.guid === 'bill1')!;
    expect(bill).toMatchObject({ kind: 'bill', total: 250, paid: 250, due: 0 });

    expect(report.totals).toEqual({ invoiced: 750, paid: 550, due: 200, draftTotal: 0 });
    expect(report.postedCount).toBe(2);
    expect(report.draftCount).toBe(0);
  });

  it('keeps drafts out of the posted totals but sums their entry values', () => {
    const report = buildJobReport([
      jobDoc({ guid: 'inv1', postTotal: 100, lotBalance: 100 }),
      jobDoc({ guid: 'draft1', posted: false, postTotal: null, lotBalance: null, entryTotal: 99.99, datePosted: null }),
    ]);
    expect(report.totals.invoiced).toBe(100);
    expect(report.totals.due).toBe(100);
    expect(report.totals.draftTotal).toBe(99.99);
    expect(report.draftCount).toBe(1);
    const draft = report.documents.find((d) => d.guid === 'draft1')!;
    expect(draft).toMatchObject({ posted: false, total: 99.99, paid: 0, due: 0 });
  });

  it('sorts documents most-recent first by posted/opened date', () => {
    const report = buildJobReport([
      jobDoc({ guid: 'old', datePosted: '2025-01-01' }),
      jobDoc({ guid: 'new', datePosted: '2026-06-01' }),
      jobDoc({ guid: 'draft', posted: false, datePosted: null, dateOpened: '2026-07-01', entryTotal: 1 }),
    ]);
    expect(report.documents.map((d) => d.guid)).toEqual(['draft', 'new', 'old']);
  });
});

// ---------------------------------------------------------------------------
// 4. Employee voucher summary
// ---------------------------------------------------------------------------

function voucherRow(partial: Partial<RawEmployeeVoucherRow>): RawEmployeeVoucherRow {
  return { guid: 'v', posted: true, month: '2026-06', postTotal: -100, lotBalance: 0, ...partial };
}

describe('buildEmployeeVoucherSummary', () => {
  it('normalizes A/P signs into positive totals and outstanding amounts', () => {
    const summary = buildEmployeeVoucherSummary([
      voucherRow({ guid: 'v1', postTotal: -120.5, lotBalance: -120.5 }), // unreimbursed
      voucherRow({ guid: 'v2', postTotal: -80, lotBalance: 0 }), // fully reimbursed
      voucherRow({ guid: 'd1', posted: false, month: null, postTotal: null, lotBalance: null }),
    ]);
    expect(summary.voucherCount).toBe(2);
    expect(summary.draftCount).toBe(1);
    expect(summary.totalPosted).toBe(200.5);
    expect(summary.outstanding).toBe(120.5);
    expect(summary.paid).toBe(80);
  });

  it('groups posted vouchers per month, most recent first', () => {
    const summary = buildEmployeeVoucherSummary([
      voucherRow({ guid: 'a', month: '2026-05', postTotal: -50, lotBalance: -10 }),
      voucherRow({ guid: 'b', month: '2026-07', postTotal: -25, lotBalance: 0 }),
      voucherRow({ guid: 'c', month: '2026-05', postTotal: -30, lotBalance: 0 }),
    ]);
    expect(summary.byMonth).toEqual([
      { month: '2026-07', total: 25, outstanding: 0 },
      { month: '2026-05', total: 80, outstanding: 10 },
    ]);
  });

  it('is empty-safe', () => {
    const summary = buildEmployeeVoucherSummary([]);
    expect(summary).toEqual({
      voucherCount: 0,
      draftCount: 0,
      totalPosted: 0,
      outstanding: 0,
      paid: 0,
      byMonth: [],
    });
  });
});
