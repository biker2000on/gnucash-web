import { describe, it, expect } from 'vitest';

// member-spending.ts imports prisma at module level via its loader; the pure
// core under test never touches it, but mock so the import is DB-free.
import { vi } from 'vitest';
vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  resolveFundingOwner,
  bucketSpendingByMember,
  type MemberSpendingTxnInput,
} from '../reports/member-spending';
import type { AccountOwner } from '../ownership';

const owners = (entries: Array<[string, AccountOwner]>) => new Map<string, AccountOwner>(entries);

const names = new Map<string, string>([
  ['exp-groceries', 'Expenses:Groceries'],
  ['exp-dining', 'Expenses:Dining'],
  ['exp-hobby', 'Expenses:Hobbies'],
]);

function txn(
  txGuid: string,
  splits: Array<{ accountGuid: string; accountType: string; amount: number }>,
): MemberSpendingTxnInput {
  return { txGuid, splits };
}

describe('member-spending', () => {
  // -------------------------------------------------------------------
  // Funding-owner resolution
  // -------------------------------------------------------------------
  describe('resolveFundingOwner', () => {
    it('attributes by the non-expense split account owner', () => {
      const ownerMap = owners([['bank-self', 'self']]);
      const owner = resolveFundingOwner(
        [
          { accountGuid: 'exp-groceries', accountType: 'EXPENSE', amount: 50 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -50 },
        ],
        ownerMap,
      );
      expect(owner).toBe('self');
    });

    it('ignores the expense split own account when resolving', () => {
      // Even if the expense account itself somehow had an owner, only the
      // funding side decides.
      const ownerMap = owners([
        ['exp-groceries', 'self'],
        ['card-spouse', 'spouse'],
      ]);
      const owner = resolveFundingOwner(
        [
          { accountGuid: 'exp-groceries', accountType: 'EXPENSE', amount: 20 },
          { accountGuid: 'card-spouse', accountType: 'CREDIT', amount: -20 },
        ],
        ownerMap,
      );
      expect(owner).toBe('spouse');
    });

    it('buckets explicitly joint accounts as joint', () => {
      const ownerMap = owners([['bank-joint', 'joint']]);
      expect(
        resolveFundingOwner(
          [
            { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 80 },
            { accountGuid: 'bank-joint', accountType: 'BANK', amount: -80 },
          ],
          ownerMap,
        ),
      ).toBe('joint');
    });

    it('buckets a self+spouse funding mix as joint', () => {
      const ownerMap = owners([
        ['bank-self', 'self'],
        ['bank-spouse', 'spouse'],
      ]);
      expect(
        resolveFundingOwner(
          [
            { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 100 },
            { accountGuid: 'bank-self', accountType: 'BANK', amount: -60 },
            { accountGuid: 'bank-spouse', accountType: 'BANK', amount: -40 },
          ],
          ownerMap,
        ),
      ).toBe('joint');
    });

    it('falls back to unassigned when no funding account has an owner', () => {
      expect(
        resolveFundingOwner(
          [
            { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 15 },
            { accountGuid: 'bank-nobody', accountType: 'BANK', amount: -15 },
          ],
          owners([]),
        ),
      ).toBe('unassigned');
    });

    it('is unassigned for expense-only transactions (reclassifications)', () => {
      expect(
        resolveFundingOwner(
          [
            { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 15 },
            { accountGuid: 'exp-groceries', accountType: 'EXPENSE', amount: -15 },
          ],
          owners([['bank-self', 'self']]),
        ),
      ).toBe('unassigned');
    });
  });

  // -------------------------------------------------------------------
  // Bucketing
  // -------------------------------------------------------------------
  describe('bucketSpendingByMember', () => {
    const ownerMap = owners([
      ['bank-self', 'self'],
      ['card-spouse', 'spouse'],
      ['bank-joint', 'joint'],
    ]);

    it('accumulates expense splits per member and category', () => {
      const txns: MemberSpendingTxnInput[] = [
        txn('t1', [
          { accountGuid: 'exp-groceries', accountType: 'EXPENSE', amount: 50 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -50 },
        ]),
        txn('t2', [
          { accountGuid: 'exp-groceries', accountType: 'EXPENSE', amount: 30 },
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 20 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -50 },
        ]),
        txn('t3', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 75 },
          { accountGuid: 'card-spouse', accountType: 'CREDIT', amount: -75 },
        ]),
      ];

      const { buckets, totals } = bucketSpendingByMember(txns, ownerMap, names);

      expect(buckets.map(b => b.owner)).toEqual(['self', 'spouse']);
      const self = buckets[0];
      expect(self.total).toBe(100);
      expect(self.categories).toEqual([
        { guid: 'exp-groceries', name: 'Expenses:Groceries', amount: 80 },
        { guid: 'exp-dining', name: 'Expenses:Dining', amount: 20 },
      ]);
      const spouse = buckets[1];
      expect(spouse.total).toBe(75);
      expect(totals.total).toBe(175);
    });

    it('handles refunds (negative expense splits) by reducing the member total', () => {
      const txns: MemberSpendingTxnInput[] = [
        txn('buy', [
          { accountGuid: 'exp-hobby', accountType: 'EXPENSE', amount: 200 },
          { accountGuid: 'card-spouse', accountType: 'CREDIT', amount: -200 },
        ]),
        txn('refund', [
          { accountGuid: 'exp-hobby', accountType: 'EXPENSE', amount: -80 },
          { accountGuid: 'card-spouse', accountType: 'CREDIT', amount: 80 },
        ]),
      ];

      const { buckets, totals } = bucketSpendingByMember(txns, ownerMap, names);
      expect(buckets).toHaveLength(1);
      expect(buckets[0].owner).toBe('spouse');
      expect(buckets[0].categories).toEqual([
        { guid: 'exp-hobby', name: 'Expenses:Hobbies', amount: 120 },
      ]);
      expect(totals.total).toBe(120);
    });

    it('drops categories that net to zero (full refund)', () => {
      const txns: MemberSpendingTxnInput[] = [
        txn('buy', [
          { accountGuid: 'exp-hobby', accountType: 'EXPENSE', amount: 60 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -60 },
        ]),
        txn('refund', [
          { accountGuid: 'exp-hobby', accountType: 'EXPENSE', amount: -60 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: 60 },
        ]),
      ];

      const { buckets, totals } = bucketSpendingByMember(txns, ownerMap, names);
      expect(buckets).toHaveLength(0);
      expect(totals.total).toBe(0);
    });

    it('routes joint and unassigned funding to their own buckets in stable order', () => {
      const txns: MemberSpendingTxnInput[] = [
        txn('t-joint', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 40 },
          { accountGuid: 'bank-joint', accountType: 'BANK', amount: -40 },
        ]),
        txn('t-unassigned', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 10 },
          { accountGuid: 'bank-mystery', accountType: 'BANK', amount: -10 },
        ]),
        txn('t-self', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 5 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -5 },
        ]),
      ];

      const { buckets } = bucketSpendingByMember(txns, ownerMap, names);
      expect(buckets.map(b => b.owner)).toEqual(['self', 'joint', 'unassigned']);
    });

    it('uses entity-profile member names for self/spouse labels', () => {
      const txns: MemberSpendingTxnInput[] = [
        txn('t1', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 12 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -12 },
        ]),
        txn('t2', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 8 },
          { accountGuid: 'card-spouse', accountType: 'CREDIT', amount: -8 },
        ]),
        txn('t3', [
          { accountGuid: 'exp-dining', accountType: 'EXPENSE', amount: 4 },
          { accountGuid: 'bank-joint', accountType: 'BANK', amount: -4 },
        ]),
      ];

      const { buckets } = bucketSpendingByMember(txns, ownerMap, names, {
        self: 'Alice',
        spouse: 'Bob',
      });
      expect(buckets.map(b => b.label)).toEqual(['Alice', 'Bob', 'Joint']);
    });

    it('falls back to the account guid when no path name is known', () => {
      const txns: MemberSpendingTxnInput[] = [
        txn('t1', [
          { accountGuid: 'exp-unknown', accountType: 'EXPENSE', amount: 9 },
          { accountGuid: 'bank-self', accountType: 'BANK', amount: -9 },
        ]),
      ];
      const { buckets } = bucketSpendingByMember(txns, ownerMap, names);
      expect(buckets[0].categories[0].name).toBe('exp-unknown');
    });
  });
});
