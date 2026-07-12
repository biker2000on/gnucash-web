import { describe, it, expect, vi } from 'vitest';

// The lib imports prisma at module scope; the pure core never touches it.
vi.mock('../prisma', () => ({
    default: {},
}));

import {
    computeAccountBreakdown,
    BreakdownAccountNode,
    BreakdownSlice,
    OTHER_SLICE_GUID,
} from '../reports/account-breakdown';

// --- Fixture tree -------------------------------------------------------------
//
// root (ROOT)
// ├── Expenses (EXPENSE)                       level 1
// │   ├── Food (EXPENSE)                       level 2
// │   │   ├── Groceries (EXPENSE)              level 3
// │   │   └── Restaurants (EXPENSE)            level 3
// │   ├── Housing (EXPENSE)                    level 2
// │   │   └── Rent (EXPENSE)                   level 3
// │   └── Misc (EXPENSE)                       level 2
// ├── Income (INCOME)                          level 1
// │   ├── Salary (INCOME)                      level 2
// │   └── Interest (INCOME)                    level 2
// ├── Assets (ASSET)                           level 1
// │   ├── Checking (BANK)                      level 2
// │   └── Savings (BANK)                       level 2
// └── Liabilities (LIABILITY)                  level 1
//     └── Credit Card (CREDIT)                 level 2

const TREE: BreakdownAccountNode[] = [
    { guid: 'root', name: 'Root Account', parent_guid: null, account_type: 'ROOT' },
    { guid: 'expenses', name: 'Expenses', parent_guid: 'root', account_type: 'EXPENSE' },
    { guid: 'food', name: 'Food', parent_guid: 'expenses', account_type: 'EXPENSE' },
    { guid: 'groceries', name: 'Groceries', parent_guid: 'food', account_type: 'EXPENSE' },
    { guid: 'restaurants', name: 'Restaurants', parent_guid: 'food', account_type: 'EXPENSE' },
    { guid: 'housing', name: 'Housing', parent_guid: 'expenses', account_type: 'EXPENSE' },
    { guid: 'rent', name: 'Rent', parent_guid: 'housing', account_type: 'EXPENSE' },
    { guid: 'misc', name: 'Misc', parent_guid: 'expenses', account_type: 'EXPENSE' },
    { guid: 'income', name: 'Income', parent_guid: 'root', account_type: 'INCOME' },
    { guid: 'salary', name: 'Salary', parent_guid: 'income', account_type: 'INCOME' },
    { guid: 'interest', name: 'Interest', parent_guid: 'income', account_type: 'INCOME' },
    { guid: 'assets', name: 'Assets', parent_guid: 'root', account_type: 'ASSET' },
    { guid: 'checking', name: 'Checking', parent_guid: 'assets', account_type: 'BANK' },
    { guid: 'savings', name: 'Savings', parent_guid: 'assets', account_type: 'BANK' },
    { guid: 'liabilities', name: 'Liabilities', parent_guid: 'root', account_type: 'LIABILITY' },
    { guid: 'cc', name: 'Credit Card', parent_guid: 'liabilities', account_type: 'CREDIT' },
];

function totals(entries: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(entries));
}

function sliceByGuid(result: { slices: BreakdownSlice[] }, guid: string): BreakdownSlice | undefined {
    return result.slices.find(s => s.accountGuid === guid);
}

describe('computeAccountBreakdown — depth rollup', () => {
    it('depth 1 rolls everything up into the top-level account', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100, restaurants: 50, rent: 900, misc: 25 }),
            { type: 'EXPENSE', depth: 1 }
        );

        expect(result.slices).toHaveLength(1);
        expect(result.slices[0].accountGuid).toBe('expenses');
        expect(result.slices[0].amount).toBeCloseTo(1075, 6);
        expect(result.total).toBeCloseTo(1075, 6);
    });

    it('depth 2 groups by the level-2 ancestor, rolling deeper accounts up', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100, restaurants: 50, rent: 900, misc: 25 }),
            { type: 'EXPENSE', depth: 2 }
        );

        const guids = result.slices.map(s => s.accountGuid).sort();
        expect(guids).toEqual(['food', 'housing', 'misc']);
        expect(sliceByGuid(result, 'food')!.amount).toBeCloseTo(150, 6); // groceries + restaurants
        expect(sliceByGuid(result, 'housing')!.amount).toBeCloseTo(900, 6);
        expect(sliceByGuid(result, 'misc')!.amount).toBeCloseTo(25, 6);
        expect(result.slices[0].accountGuid).toBe('housing'); // sorted desc
    });

    it('depth 3 keeps leaf accounts as their own slices, and a parent with own splits keeps its own slice', () => {
        const result = computeAccountBreakdown(
            TREE,
            // "food" itself has direct splits in addition to its children
            totals({ food: 10, groceries: 100, restaurants: 50, rent: 900 }),
            // minShare 0: this test is about rollup, not the Other threshold
            { type: 'EXPENSE', depth: 3, minShare: 0 }
        );

        const guids = result.slices.map(s => s.accountGuid).sort();
        expect(guids).toEqual(['food', 'groceries', 'rent', 'restaurants']);
        expect(sliceByGuid(result, 'food')!.amount).toBeCloseTo(10, 6);
        expect(sliceByGuid(result, 'groceries')!.amount).toBeCloseTo(100, 6);
        expect(result.total).toBeCloseTo(1060, 6);
    });

    it('accounts with zero totals produce no slices', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100 }),
            { type: 'EXPENSE', depth: 3 }
        );
        expect(result.slices.map(s => s.accountGuid)).toEqual(['groceries']);
    });

    it('builds full colon-separated paths (root excluded)', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100 }),
            { type: 'EXPENSE', depth: 3 }
        );
        expect(result.slices[0].path).toBe('Expenses:Food:Groceries');
    });

    it('flags drillable slices via hasChildren', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100, rent: 900, misc: 25 }),
            { type: 'EXPENSE', depth: 2 }
        );
        expect(sliceByGuid(result, 'food')!.hasChildren).toBe(true);
        expect(sliceByGuid(result, 'misc')!.hasChildren).toBe(false);
    });
});

describe('computeAccountBreakdown — drill-down root', () => {
    it('grouping descends relative to the drill-down root', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100, restaurants: 50, rent: 900 }),
            { type: 'EXPENSE', depth: 1, rootGuid: 'food' }
        );

        const guids = result.slices.map(s => s.accountGuid).sort();
        expect(guids).toEqual(['groceries', 'restaurants']);
        expect(result.root).toEqual({ guid: 'food', name: 'Food', path: 'Expenses:Food' });
        expect(result.total).toBeCloseTo(150, 6);
    });

    it("surfaces the drill-down root's own splits as a slice", () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ food: 10, groceries: 100, restaurants: 50 }),
            { type: 'EXPENSE', depth: 1, rootGuid: 'food' }
        );

        const own = sliceByGuid(result, 'food');
        expect(own).toBeDefined();
        expect(own!.amount).toBeCloseTo(10, 6);
        expect(own!.hasChildren).toBe(false); // never drill into the current root again
        expect(result.total).toBeCloseTo(160, 6);
    });

    it('returns empty for an unknown rootGuid', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ groceries: 100 }),
            { type: 'EXPENSE', depth: 1, rootGuid: 'nope' }
        );
        expect(result.slices).toEqual([]);
        expect(result.total).toBe(0);
    });
});

describe('computeAccountBreakdown — sign conventions', () => {
    it('negates income so slices are positive magnitudes', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ salary: -5000, interest: -20 }),
            { type: 'INCOME', depth: 2, minShare: 0 }
        );
        expect(sliceByGuid(result, 'salary')!.amount).toBeCloseTo(5000, 6);
        expect(sliceByGuid(result, 'interest')!.amount).toBeCloseTo(20, 6);
        expect(result.total).toBeCloseTo(5020, 6);
    });

    it('negates liabilities so slices are positive magnitudes', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ cc: -1234.56 }),
            { type: 'LIABILITY', depth: 2 }
        );
        expect(sliceByGuid(result, 'cc')!.amount).toBeCloseTo(1234.56, 6);
    });

    it('keeps asset balances as-is and only picks up asset-class accounts', () => {
        const result = computeAccountBreakdown(
            TREE,
            totals({ checking: 1500, savings: 8000, cc: -1234, salary: -5000 }),
            { type: 'ASSET', depth: 2 }
        );
        const guids = result.slices.map(s => s.accountGuid).sort();
        expect(guids).toEqual(['checking', 'savings']);
        expect(sliceByGuid(result, 'savings')!.amount).toBeCloseTo(8000, 6);
        expect(result.total).toBeCloseTo(9500, 6);
    });
});

describe('computeAccountBreakdown — Other bucket', () => {
    // A wide, flat expense tree for slice-count tests
    const flat: BreakdownAccountNode[] = [
        { guid: 'root', name: 'Root', parent_guid: null, account_type: 'ROOT' },
        { guid: 'expenses', name: 'Expenses', parent_guid: 'root', account_type: 'EXPENSE' },
        ...Array.from({ length: 8 }, (_, i) => ({
            guid: `e${i}`,
            name: `Cat ${i}`,
            parent_guid: 'expenses',
            account_type: 'EXPENSE',
        })),
    ];

    it('folds slices beyond maxSlices - 1 into an "Other" bucket with the folded slices attached', () => {
        const result = computeAccountBreakdown(
            flat,
            totals({ e0: 800, e1: 400, e2: 200, e3: 100, e4: 90, e5: 80, e6: 70, e7: 60 }),
            { type: 'EXPENSE', depth: 2, maxSlices: 4 }
        );

        expect(result.slices).toHaveLength(4);
        expect(result.slices.map(s => s.accountGuid)).toEqual(['e0', 'e1', 'e2', OTHER_SLICE_GUID]);

        const other = result.slices[3];
        expect(other.name).toBe('Other');
        expect(other.amount).toBeCloseTo(100 + 90 + 80 + 70 + 60, 6);
        expect(other.children!.map(c => c.accountGuid)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);
        expect(result.total).toBeCloseTo(1800, 6);
    });

    it('folds slices under the minimum share threshold even when the count fits', () => {
        const result = computeAccountBreakdown(
            flat,
            totals({ e0: 990, e1: 9.5, e2: 0.5 }), // e2 is 0.05% of the total
            { type: 'EXPENSE', depth: 2, maxSlices: 10, minShare: 0.01 }
        );

        expect(result.slices.map(s => s.accountGuid)).toEqual(['e0', OTHER_SLICE_GUID]);
        const other = result.slices[1];
        expect(other.children!.map(c => c.accountGuid)).toEqual(['e1', 'e2']);
        expect(other.amount).toBeCloseTo(10, 6);
    });

    it('does not create an "Other" of exactly one non-tiny slice', () => {
        const result = computeAccountBreakdown(
            flat,
            totals({ e0: 500, e1: 400, e2: 300, e3: 200 }),
            { type: 'EXPENSE', depth: 2, maxSlices: 4 }
        );
        // 4 slices, maxSlices 4, none under the share threshold → keep all four
        expect(result.slices.map(s => s.accountGuid)).toEqual(['e0', 'e1', 'e2', 'e3']);
    });

    it('creates no Other bucket when everything fits', () => {
        const result = computeAccountBreakdown(
            flat,
            totals({ e0: 500, e1: 400 }),
            { type: 'EXPENSE', depth: 2, maxSlices: 10 }
        );
        expect(result.slices.map(s => s.accountGuid)).toEqual(['e0', 'e1']);
        expect(result.slices.every(s => s.children === undefined)).toBe(true);
    });
});
