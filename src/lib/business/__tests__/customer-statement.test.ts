/**
 * Customer statement — pure-math tests (DB-free).
 *
 * Covers:
 *   - opening balance (invoices/payments before the period start)
 *   - running-balance activity ordering (chronological, invoice-before-payment
 *     on the same day) and rounding
 *   - closing balance = opening + sum(activity)
 *   - null startDate semantics (opening 0, activity from the beginning)
 *   - aging buckets as of endDate incl. exact 30/60/90 boundaries and
 *     payments after endDate being ignored
 */

import { describe, it, expect } from 'vitest';
import {
  buildStatementActivity,
  computeStatementAging,
  daysBetweenIso,
  type StatementInvoiceInput,
  type StatementPaymentInput,
} from '../customer-statement';

const inv = (guid: string, id: string, date: string, total: number, dueDate: string | null = null): StatementInvoiceInput =>
  ({ guid, id, date, total, dueDate });

const pay = (
  txGuid: string,
  date: string,
  amount: number,
  allocations: Array<{ invoiceGuid: string; amount: number }>,
  ref = 'CHK',
): StatementPaymentInput => ({ txGuid, date, ref, amount, allocations });

describe('daysBetweenIso', () => {
  it('computes whole day differences', () => {
    expect(daysBetweenIso('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetweenIso('2026-01-31', '2026-01-01')).toBe(-30);
    expect(daysBetweenIso('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('buildStatementActivity', () => {
  const invoices = [
    inv('i1', '000001', '2026-01-10', 500),
    inv('i2', '000002', '2026-02-05', 250),
    inv('i3', '000003', '2026-03-01', 100),
  ];
  const payments = [
    pay('p1', '2026-01-20', 300, [{ invoiceGuid: 'i1', amount: 300 }]),
    pay('p2', '2026-02-05', 200, [{ invoiceGuid: 'i1', amount: 200 }]),
  ];

  it('carries pre-period activity into the opening balance', () => {
    const s = buildStatementActivity(invoices, payments, '2026-02-01', '2026-03-31');
    // Before Feb 1: invoice i1 (+500), payment p1 (-300) => opening 200
    expect(s.openingBalance).toBe(200);
    expect(s.activity.map((l) => [l.date, l.type, l.amount, l.balance])).toEqual([
      ['2026-02-05', 'invoice', 250, 450],
      ['2026-02-05', 'payment', -200, 250],
      ['2026-03-01', 'invoice', 100, 350],
    ]);
    expect(s.closingBalance).toBe(350);
  });

  it('orders invoices before payments on the same day', () => {
    const s = buildStatementActivity(
      [inv('i9', '000009', '2026-04-01', 100)],
      [pay('p9', '2026-04-01', 100, [{ invoiceGuid: 'i9', amount: 100 }])],
      '2026-04-01',
      '2026-04-30',
    );
    expect(s.activity[0].type).toBe('invoice');
    expect(s.activity[0].balance).toBe(100);
    expect(s.activity[1].type).toBe('payment');
    expect(s.activity[1].balance).toBe(0);
    expect(s.closingBalance).toBe(0);
  });

  it('null startDate: opening 0 and activity from the beginning', () => {
    const s = buildStatementActivity(invoices, payments, null, '2026-03-31');
    expect(s.openingBalance).toBe(0);
    expect(s.activity).toHaveLength(5);
    // closing = 500 + 250 + 100 - 300 - 200
    expect(s.closingBalance).toBe(350);
  });

  it('excludes activity after endDate', () => {
    const s = buildStatementActivity(invoices, payments, null, '2026-01-31');
    expect(s.activity.map((l) => l.ref)).toEqual(['000001', 'CHK']);
    expect(s.closingBalance).toBe(200);
  });

  it('rounds floating-point accumulation to cents', () => {
    const s = buildStatementActivity(
      [inv('a', '1', '2026-01-01', 0.1), inv('b', '2', '2026-01-02', 0.2)],
      [],
      null,
      '2026-01-31',
    );
    expect(s.activity[1].balance).toBe(0.3);
    expect(s.closingBalance).toBe(0.3);
  });
});

describe('computeStatementAging', () => {
  it('buckets open amounts by days past due as of endDate', () => {
    const end = '2026-07-10';
    const invoices = [
      inv('c', 'C', '2026-07-01', 100, '2026-07-15'), // not yet due -> current
      inv('d', 'D', '2026-06-01', 200, '2026-06-25'), // 15 days past -> 1-30
      inv('e', 'E', '2026-05-01', 300, '2026-05-20'), // 51 days past -> 31-60
      inv('f', 'F', '2026-04-01', 400, '2026-04-20'), // 81 days past -> 61-90
      inv('g', 'G', '2026-01-01', 500, '2026-01-15'), // 176 days past -> 90+
    ];
    const aging = computeStatementAging(invoices, [], end);
    expect(aging).toEqual({
      current: 100, b1_30: 200, b31_60: 300, b61_90: 400, b90plus: 500, total: 1500,
    });
  });

  it('treats exact 30/60/90-day boundaries inclusively', () => {
    const end = '2026-07-10';
    const invoices = [
      inv('x0', 'X0', '2026-01-01', 10, '2026-07-10'), // 0 days -> current
      inv('x30', 'X30', '2026-01-01', 20, '2026-06-10'), // 30 days -> 1-30
      inv('x31', 'X31', '2026-01-01', 30, '2026-06-09'), // 31 days -> 31-60
      inv('x90', 'X90', '2026-01-01', 40, '2026-04-11'), // 90 days -> 61-90
      inv('x91', 'X91', '2026-01-01', 50, '2026-04-10'), // 91 days -> 90+
    ];
    const aging = computeStatementAging(invoices, [], end);
    expect(aging.current).toBe(10);
    expect(aging.b1_30).toBe(20);
    expect(aging.b31_60).toBe(30);
    expect(aging.b61_90).toBe(40);
    expect(aging.b90plus).toBe(50);
  });

  it('nets payments dated on/before endDate and ignores later ones', () => {
    const invoices = [inv('i1', '1', '2026-01-01', 500, '2026-01-01')];
    const payments = [
      pay('p1', '2026-02-01', 200, [{ invoiceGuid: 'i1', amount: 200 }]),
      pay('p2', '2026-08-01', 300, [{ invoiceGuid: 'i1', amount: 300 }]), // after endDate
    ];
    const aging = computeStatementAging(invoices, payments, '2026-07-10');
    expect(aging.total).toBe(300);
    expect(aging.b90plus).toBe(300);
  });

  it('drops fully paid invoices and invoices posted after endDate', () => {
    const invoices = [
      inv('paid', 'P', '2026-01-01', 100, '2026-01-01'),
      inv('future', 'F', '2026-09-01', 999, '2026-09-15'),
    ];
    const payments = [pay('p', '2026-01-05', 100, [{ invoiceGuid: 'paid', amount: 100 }])];
    const aging = computeStatementAging(invoices, payments, '2026-07-10');
    expect(aging.total).toBe(0);
  });

  it('falls back to the invoice date when there is no due date', () => {
    const invoices = [inv('n', 'N', '2026-07-01', 100, null)]; // 9 days past posting
    const aging = computeStatementAging(invoices, [], '2026-07-10');
    expect(aging.b1_30).toBe(100);
  });
});
