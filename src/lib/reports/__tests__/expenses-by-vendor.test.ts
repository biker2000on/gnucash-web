/**
 * Expenses by Vendor — pure aggregation tests
 *
 * Exercises per-vendor rollup with mocked posted-bill rows: A/P sign
 * conventions (bills post negative, unpaid lots negative), job → vendor
 * resolution, paid/balance math, credit notes, and the empty-book case.
 */

import { describe, it, expect, vi } from 'vitest';

// The module under test imports prisma (for the loader); mock it so importing
// the pure functions doesn't require a database.
vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  buildExpensesByVendor,
  resolveVendorGuid,
  buildVendorSections,
  RawPostedBillRow,
} from '../expenses-by-vendor';
import type { JobOwnerRef } from '../sales-by-customer';
import {
  OWNER_TYPE_CUSTOMER,
  OWNER_TYPE_JOB,
  OWNER_TYPE_VENDOR,
} from '@/lib/business/business-reports';

const bill = (
  guid: string,
  ownerType: number,
  ownerGuid: string | null,
  postedTotal: number,
  lotBalance = 0,
  currency = 'USD',
): RawPostedBillRow => ({ guid, ownerType, ownerGuid, postedTotal, lotBalance, currency });

const NO_JOBS = new Map<string, JobOwnerRef>();
const NAMES = new Map([
  ['vend-a', 'Ace Supplies'],
  ['vend-b', 'Bulk Tools'],
]);

describe('resolveVendorGuid', () => {
  it('passes direct vendor owners through', () => {
    expect(resolveVendorGuid(OWNER_TYPE_VENDOR, 'vend-a', NO_JOBS)).toBe('vend-a');
  });

  it('resolves job owners to the job\'s vendor', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-1', { ownerType: OWNER_TYPE_VENDOR, ownerGuid: 'vend-a' }],
    ]);
    expect(resolveVendorGuid(OWNER_TYPE_JOB, 'job-1', jobs)).toBe('vend-a');
  });

  it('rejects customer-owned jobs and unknown owners', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-c', { ownerType: OWNER_TYPE_CUSTOMER, ownerGuid: 'cust-1' }],
    ]);
    expect(resolveVendorGuid(OWNER_TYPE_JOB, 'job-c', jobs)).toBeNull();
    expect(resolveVendorGuid(OWNER_TYPE_JOB, 'job-missing', jobs)).toBeNull();
    expect(resolveVendorGuid(OWNER_TYPE_CUSTOMER, 'cust-1', jobs)).toBeNull();
  });
});

describe('buildExpensesByVendor', () => {
  it('normalizes A/P signs: bills post negative, unpaid lot balances negative', () => {
    // Bill of 500; 200 still owed (lot balance -200) → 300 paid
    const { vendors, totals } = buildExpensesByVendor(
      [bill('bill-1', OWNER_TYPE_VENDOR, 'vend-a', -500, -200)],
      NO_JOBS,
      NAMES,
    );

    expect(vendors).toHaveLength(1);
    const ace = vendors[0];
    expect(ace.vendorName).toBe('Ace Supplies');
    expect(ace.billCount).toBe(1);
    expect(ace.totalBilled).toBe(500);
    expect(ace.balance).toBe(200);
    expect(ace.paid).toBe(300);

    expect(totals).toEqual({
      billCount: 1,
      totalBilled: 500,
      paid: 300,
      balance: 200,
    });
  });

  it('rolls multiple bills up per vendor, resolving job-owned bills', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-1', { ownerType: OWNER_TYPE_VENDOR, ownerGuid: 'vend-a' }],
    ]);
    const { vendors, totals } = buildExpensesByVendor(
      [
        bill('bill-1', OWNER_TYPE_VENDOR, 'vend-a', -100, 0),   // fully paid
        bill('bill-2', OWNER_TYPE_JOB, 'job-1', -250, -250),    // unpaid, via job
        bill('bill-3', OWNER_TYPE_VENDOR, 'vend-b', -75, 0),
      ],
      jobs,
      NAMES,
    );

    expect(vendors.map(v => v.vendorGuid)).toEqual(['vend-a', 'vend-b']); // by billed desc
    const ace = vendors[0];
    expect(ace.billCount).toBe(2);
    expect(ace.totalBilled).toBe(350);
    expect(ace.paid).toBe(100);
    expect(ace.balance).toBe(250);

    expect(totals.billCount).toBe(3);
    expect(totals.totalBilled).toBe(425);
  });

  it('skips bills whose job resolves to a customer', () => {
    const jobs = new Map<string, JobOwnerRef>([
      ['job-c', { ownerType: OWNER_TYPE_CUSTOMER, ownerGuid: 'cust-1' }],
    ]);
    const { vendors, totals } = buildExpensesByVendor(
      [bill('inv-ish', OWNER_TYPE_JOB, 'job-c', -100)],
      jobs,
      NAMES,
    );
    expect(vendors).toEqual([]);
    expect(totals.billCount).toBe(0);
  });

  it('handles vendor credit notes (positive posted totals) reducing billed totals', () => {
    const { vendors } = buildExpensesByVendor(
      [
        bill('bill-1', OWNER_TYPE_VENDOR, 'vend-a', -500, 0),
        bill('cn-1', OWNER_TYPE_VENDOR, 'vend-a', 100, 100), // unapplied vendor credit
      ],
      NO_JOBS,
      NAMES,
    );
    const ace = vendors[0];
    expect(ace.totalBilled).toBe(400);
    expect(ace.balance).toBe(-100); // vendor owes us
    expect(ace.paid).toBe(500);
  });

  it('falls back to "(unknown)" for vendors without a name row', () => {
    const { vendors } = buildExpensesByVendor(
      [bill('bill-1', OWNER_TYPE_VENDOR, 'ghost', -10)],
      NO_JOBS,
      new Map(),
    );
    expect(vendors[0].vendorName).toBe('(unknown)');
  });

  it('returns empty rows and zero totals for an empty book', () => {
    const { vendors, totals } = buildExpensesByVendor([], NO_JOBS, new Map());
    expect(vendors).toEqual([]);
    expect(totals).toEqual({
      billCount: 0,
      totalBilled: 0,
      paid: 0,
      balance: 0,
    });
  });

  it('rounds amounts to cents', () => {
    const { vendors } = buildExpensesByVendor(
      [bill('b1', OWNER_TYPE_VENDOR, 'vend-a', -(10.005 * 3))], // -30.015000000000004
      NO_JOBS,
      NAMES,
    );
    expect(vendors[0].totalBilled).toBe(30.02);
  });
});

describe('buildVendorSections', () => {
  it('projects vendors into a single-amount section (amount = total billed)', () => {
    const { vendors, totals } = buildExpensesByVendor(
      [bill('bill-1', OWNER_TYPE_VENDOR, 'vend-a', -500, -200)],
      NO_JOBS,
      NAMES,
    );
    expect(buildVendorSections(vendors, totals)).toEqual([
      {
        title: 'Expenses by Vendor',
        items: [{ guid: 'vend-a', name: 'Ace Supplies', amount: 500 }],
        total: 500,
      },
    ]);
  });
});
