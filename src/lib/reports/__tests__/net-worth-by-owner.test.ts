/**
 * Net Worth by Owner — bucketing tests
 *
 * Exercises the pure bucketing core with mocked rows: joint + unassigned
 * buckets, liability sign conventions, zero-balance and non-balance-sheet
 * filtering, and bucket ordering.
 */

import { describe, it, expect } from 'vitest';

// The module under test imports prisma (for the async generator); mock it so
// importing the pure function doesn't require a database.
import { vi } from 'vitest';
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/account-valuation', () => ({ buildAccountValuationContext: vi.fn() }));

import { bucketAccountsByOwner, OwnerBalanceInput } from '../net-worth-by-owner';
import type { AccountOwner } from '@/lib/ownership';

const row = (
  guid: string,
  account_type: string,
  balance: number,
  fullname = guid,
): OwnerBalanceInput => ({ guid, fullname, account_type, balance });

describe('bucketAccountsByOwner', () => {
  it('buckets assets and liabilities per owner with correct signs', () => {
    const ownerMap = new Map<string, AccountOwner>([
      ['checking', 'self'],
      ['mortgage', 'self'],
    ]);
    const { buckets, totals } = bucketAccountsByOwner(
      [
        row('checking', 'BANK', 5000),
        // GnuCash liabilities are credit-normal: negative raw balance when owed
        row('mortgage', 'LIABILITY', -200000),
      ],
      ownerMap,
    );

    expect(buckets).toHaveLength(1);
    const self = buckets[0];
    expect(self.owner).toBe('self');
    expect(self.label).toBe('Self');
    expect(self.totalAssets).toBe(5000);
    expect(self.totalLiabilities).toBe(200000); // displayed positive
    expect(self.netWorth).toBe(-195000);

    const mortgage = self.accounts.find(a => a.guid === 'mortgage')!;
    expect(mortgage.category).toBe('liability');
    expect(mortgage.balance).toBe(200000); // owed reads positive

    expect(totals).toEqual({
      totalAssets: 5000,
      totalLiabilities: 200000,
      netWorth: -195000,
    });
  });

  it('keeps joint as its own bucket (no 50/50 split) and routes unowned accounts to unassigned', () => {
    const ownerMap = new Map<string, AccountOwner>([
      ['his-ira', 'self'],
      ['her-brokerage', 'spouse'],
      ['joint-checking', 'joint'],
    ]);
    const { buckets, totals } = bucketAccountsByOwner(
      [
        row('his-ira', 'MUTUAL', 100),
        row('her-brokerage', 'STOCK', 200),
        row('joint-checking', 'BANK', 400),
        row('mystery-cash', 'CASH', 800), // no owner anywhere
      ],
      ownerMap,
    );

    expect(buckets.map(b => b.owner)).toEqual(['self', 'spouse', 'joint', 'unassigned']);

    const joint = buckets.find(b => b.owner === 'joint')!;
    expect(joint.totalAssets).toBe(400); // full amount, not split
    expect(joint.netWorth).toBe(400);

    const unassigned = buckets.find(b => b.owner === 'unassigned')!;
    expect(unassigned.accounts.map(a => a.guid)).toEqual(['mystery-cash']);
    expect(unassigned.netWorth).toBe(800);

    expect(totals.totalAssets).toBe(1500);
    expect(totals.totalLiabilities).toBe(0);
    expect(totals.netWorth).toBe(1500);
  });

  it('shows a contra liability (overpaid credit card) as negative owed', () => {
    const ownerMap = new Map<string, AccountOwner>([['cc', 'spouse']]);
    const { buckets } = bucketAccountsByOwner(
      [row('cc', 'CREDIT', 50)], // positive raw = debit balance = overpaid
      ownerMap,
    );
    const spouse = buckets[0];
    expect(spouse.accounts[0].balance).toBe(-50);
    expect(spouse.totalLiabilities).toBe(-50);
    expect(spouse.netWorth).toBe(50); // reduces liabilities, raises net worth
  });

  it('skips zero-balance rows (placeholders) and omits empty buckets', () => {
    const ownerMap = new Map<string, AccountOwner>([
      ['placeholder', 'self'],
      ['spouse-bank', 'spouse'],
    ]);
    const { buckets } = bucketAccountsByOwner(
      [
        row('placeholder', 'ASSET', 0),
        row('spouse-bank', 'BANK', 10),
      ],
      ownerMap,
    );
    // 'self' bucket had only a zero-balance row → omitted entirely
    expect(buckets.map(b => b.owner)).toEqual(['spouse']);
  });

  it('ignores non-balance-sheet account types', () => {
    const ownerMap = new Map<string, AccountOwner>([
      ['salary', 'self'],
      ['equity', 'self'],
      ['bank', 'self'],
    ]);
    const { buckets } = bucketAccountsByOwner(
      [
        row('salary', 'INCOME', -9000),
        row('equity', 'EQUITY', -1234),
        row('bank', 'BANK', 42),
      ],
      ownerMap,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].accounts.map(a => a.guid)).toEqual(['bank']);
  });

  it('sorts accounts within a bucket: assets first, then liabilities, alphabetical', () => {
    const ownerMap = new Map<string, AccountOwner>([
      ['z-asset', 'joint'],
      ['a-asset', 'joint'],
      ['b-liability', 'joint'],
    ]);
    const { buckets } = bucketAccountsByOwner(
      [
        row('z-asset', 'BANK', 1, 'Zeta Bank'),
        row('b-liability', 'CREDIT', -5, 'Beta Card'),
        row('a-asset', 'CASH', 2, 'Alpha Cash'),
      ],
      ownerMap,
    );
    expect(buckets[0].accounts.map(a => a.fullname)).toEqual([
      'Alpha Cash',
      'Zeta Bank',
      'Beta Card',
    ]);
  });

  it('handles RECEIVABLE as asset and PAYABLE as liability', () => {
    const ownerMap = new Map<string, AccountOwner>([
      ['ar', 'self'],
      ['ap', 'self'],
    ]);
    const { buckets } = bucketAccountsByOwner(
      [
        row('ar', 'RECEIVABLE', 300),
        row('ap', 'PAYABLE', -100),
      ],
      ownerMap,
    );
    const self = buckets[0];
    expect(self.totalAssets).toBe(300);
    expect(self.totalLiabilities).toBe(100);
    expect(self.netWorth).toBe(200);
  });

  it('rounds balances and totals to cents', () => {
    const ownerMap = new Map<string, AccountOwner>([['fund', 'self']]);
    const { buckets, totals } = bucketAccountsByOwner(
      [row('fund', 'MUTUAL', 10.005 * 3)], // 30.015000000000004 → 30.02
      ownerMap,
    );
    expect(buckets[0].accounts[0].balance).toBe(30.02);
    expect(totals.totalAssets).toBe(30.02);
  });
});
