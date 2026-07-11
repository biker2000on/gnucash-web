/**
 * Sales by Customer — pure aggregation tests
 *
 * Exercises per-customer rollup with mocked posted-invoice rows: job → owner
 * resolution, subtotal/tax split, payments derived from lot balances, credit
 * notes, sorting, and the empty-book case.
 */

import { describe, it, expect, vi } from 'vitest';

// The module under test imports prisma (for the loader); mock it so importing
// the pure functions doesn't require a database.
vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  buildSalesByCustomer,
  resolveCustomerGuid,
  dominantCurrency,
  buildSalesSections,
  RawPostedInvoiceRow,
  JobOwnerRef,
} from '../sales-by-customer';
import {
  OWNER_TYPE_CUSTOMER,
  OWNER_TYPE_JOB,
  OWNER_TYPE_VENDOR,
} from '@/lib/business/business-reports';

const invoice = (
  guid: string,
  ownerType: number,
  ownerGuid: string | null,
  postedTotal: number,
  taxTotal = 0,
  lotBalance = 0,
  currency = 'USD',
): RawPostedInvoiceRow => ({ guid, ownerType, ownerGuid, postedTotal, taxTotal, lotBalance, currency });

const NO_JOBS = new Map<string, JobOwnerRef>();
const NAMES = new Map([
  ['cust-a', 'Acme Corp'],
  ['cust-b', 'Bolt Inc'],
]);

describe('resolveCustomerGuid', () => {
  it('passes direct customer owners through', () => {
    expect(resolveCustomerGuid(OWNER_TYPE_CUSTOMER, 'cust-a', NO_JOBS)).toBe('cust-a');
  });

  it('resolves job owners to the job\'s customer', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-1', { ownerType: OWNER_TYPE_CUSTOMER, ownerGuid: 'cust-a' }],
    ]);
    expect(resolveCustomerGuid(OWNER_TYPE_JOB, 'job-1', jobs)).toBe('cust-a');
  });

  it('rejects vendor-owned jobs and unknown owners', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-v', { ownerType: OWNER_TYPE_VENDOR, ownerGuid: 'vend-1' }],
    ]);
    expect(resolveCustomerGuid(OWNER_TYPE_JOB, 'job-v', jobs)).toBeNull();
    expect(resolveCustomerGuid(OWNER_TYPE_JOB, 'job-missing', jobs)).toBeNull();
    expect(resolveCustomerGuid(OWNER_TYPE_VENDOR, 'vend-1', jobs)).toBeNull();
  });
});

describe('buildSalesByCustomer', () => {
  it('splits totals into subtotal + tax and derives payments from the lot balance', () => {
    // Invoice of 108 total incl. 8 tax; 30 still owed → 78 paid... total-balance = 78
    const { customers, totals } = buildSalesByCustomer(
      [invoice('inv-1', OWNER_TYPE_CUSTOMER, 'cust-a', 108, -8, 30)],
      NO_JOBS,
      NAMES,
    );

    expect(customers).toHaveLength(1);
    const acme = customers[0];
    expect(acme.customerName).toBe('Acme Corp');
    expect(acme.invoiceCount).toBe(1);
    expect(acme.total).toBe(108);
    expect(acme.tax).toBe(8); // tax split is a credit (-8) → reads +8
    expect(acme.subtotal).toBe(100);
    expect(acme.balance).toBe(30); // AR lot balance positive = still owed
    expect(acme.payments).toBe(78);

    expect(totals).toEqual({
      invoiceCount: 1,
      subtotal: 100,
      tax: 8,
      total: 108,
      payments: 78,
      balance: 30,
    });
  });

  it('rolls multiple invoices up per customer, resolving job-owned invoices', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-1', { ownerType: OWNER_TYPE_CUSTOMER, ownerGuid: 'cust-a' }],
    ]);
    const { customers, totals } = buildSalesByCustomer(
      [
        invoice('inv-1', OWNER_TYPE_CUSTOMER, 'cust-a', 100, 0, 0), // fully paid
        invoice('inv-2', OWNER_TYPE_JOB, 'job-1', 200, 0, 200),     // unpaid, via job
        invoice('inv-3', OWNER_TYPE_CUSTOMER, 'cust-b', 50, 0, 0),
      ],
      jobs,
      NAMES,
    );

    expect(customers.map(c => c.customerGuid)).toEqual(['cust-a', 'cust-b']); // by total desc
    const acme = customers[0];
    expect(acme.invoiceCount).toBe(2);
    expect(acme.total).toBe(300);
    expect(acme.payments).toBe(100);
    expect(acme.balance).toBe(200);

    expect(totals.invoiceCount).toBe(3);
    expect(totals.total).toBe(350);
  });

  it('skips invoices whose job resolves to a vendor', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-v', { ownerType: OWNER_TYPE_VENDOR, ownerGuid: 'vend-1' }],
    ]);
    const { customers, totals } = buildSalesByCustomer(
      [invoice('bill-ish', OWNER_TYPE_JOB, 'job-v', 100)],
      jobs,
      NAMES,
    );
    expect(customers).toEqual([]);
    expect(totals.invoiceCount).toBe(0);
  });

  it('handles credit notes (negative posted totals) reducing customer totals', () => {
    const { customers } = buildSalesByCustomer(
      [
        invoice('inv-1', OWNER_TYPE_CUSTOMER, 'cust-a', 100, 0, 0),
        invoice('cn-1', OWNER_TYPE_CUSTOMER, 'cust-a', -25, 0, -25), // unapplied credit note
      ],
      NO_JOBS,
      NAMES,
    );
    const acme = customers[0];
    expect(acme.total).toBe(75);
    expect(acme.balance).toBe(-25); // customer is owed money
    expect(acme.payments).toBe(100);
  });

  it('falls back to "(unknown)" for customers without a name row', () => {
    const { customers } = buildSalesByCustomer(
      [invoice('inv-1', OWNER_TYPE_CUSTOMER, 'ghost', 10)],
      NO_JOBS,
      new Map(),
    );
    expect(customers[0].customerName).toBe('(unknown)');
  });

  it('returns empty rows and zero totals for an empty book', () => {
    const { customers, totals } = buildSalesByCustomer([], NO_JOBS, new Map());
    expect(customers).toEqual([]);
    expect(totals).toEqual({
      invoiceCount: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      payments: 0,
      balance: 0,
    });
  });

  it('rounds amounts to cents', () => {
    const { customers } = buildSalesByCustomer(
      [invoice('i1', OWNER_TYPE_CUSTOMER, 'cust-a', 10.005 * 3, 0, 0)], // 30.015000000000004
      NO_JOBS,
      NAMES,
    );
    expect(customers[0].total).toBe(30.02);
    expect(customers[0].subtotal).toBe(30.02);
  });
});

describe('dominantCurrency', () => {
  it('picks the most frequent currency, defaulting to USD when empty', () => {
    expect(dominantCurrency([])).toBe('USD');
    expect(
      dominantCurrency([{ currency: 'EUR' }, { currency: 'EUR' }, { currency: 'USD' }]),
    ).toBe('EUR');
  });
});

describe('buildSalesSections', () => {
  it('projects customers into a single-amount section (amount = total)', () => {
    const { customers, totals } = buildSalesByCustomer(
      [invoice('inv-1', OWNER_TYPE_CUSTOMER, 'cust-a', 108, -8, 0)],
      NO_JOBS,
      NAMES,
    );
    expect(buildSalesSections(customers, totals)).toEqual([
      {
        title: 'Sales by Customer',
        items: [{ guid: 'cust-a', name: 'Acme Corp', amount: 108 }],
        total: 108,
      },
    ]);
  });
});
