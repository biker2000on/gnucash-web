import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('../prisma', () => ({
    default: {
        accounts: {
            findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
        },
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

import {
    BLS_CATEGORIES,
    BLS_SIZE_MULTIPLIERS,
    getBlsAverage,
    clampHouseholdSize,
    mapAccountToBlsCategory,
    computeBlsComparison,
    compareToBls,
} from '../bls-comparison';

// ─────────────────────────────────────────────────────────────────────────────
// Dataset integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('BLS dataset integrity', () => {
    it('has unique category ids', () => {
        const ids = BLS_CATEGORIES.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('has ~12 major categories', () => {
        expect(BLS_CATEGORIES.length).toBe(12);
    });

    it('has positive annual averages for every category', () => {
        for (const category of BLS_CATEGORIES) {
            expect(category.annualAllUnits).toBeGreaterThan(0);
            expect(Number.isFinite(category.annualAllUnits)).toBe(true);
            expect(category.label.length).toBeGreaterThan(0);
        }
    });

    it('has positive multipliers for all household sizes 1-5', () => {
        for (const size of [1, 2, 3, 4, 5] as const) {
            expect(BLS_SIZE_MULTIPLIERS[size]).toBeGreaterThan(0);
        }
    });

    it('produces positive averages for every category × size combination', () => {
        for (const category of BLS_CATEGORIES) {
            for (const size of [1, 2, 3, 4, 5]) {
                expect(getBlsAverage(category.id, size)).toBeGreaterThan(0);
            }
        }
    });

    it('scales averages by household size', () => {
        const single = getBlsAverage('food_at_home', 1);
        const family = getBlsAverage('food_at_home', 4);
        expect(family).toBeGreaterThan(single);
    });
});

describe('clampHouseholdSize', () => {
    it('clamps to 1..5', () => {
        expect(clampHouseholdSize(0)).toBe(1);
        expect(clampHouseholdSize(1)).toBe(1);
        expect(clampHouseholdSize(3)).toBe(3);
        expect(clampHouseholdSize(9)).toBe(5);
    });

    it('defaults to 2 for non-finite input', () => {
        expect(clampHouseholdSize(NaN)).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Category mapping heuristic
// ─────────────────────────────────────────────────────────────────────────────

describe('mapAccountToBlsCategory', () => {
    it('maps common expense paths', () => {
        expect(mapAccountToBlsCategory('Expenses:Groceries')).toBe('food_at_home');
        expect(mapAccountToBlsCategory('Expenses:Dining:Restaurants')).toBe('food_away');
        expect(mapAccountToBlsCategory('Expenses:Rent')).toBe('housing');
        expect(mapAccountToBlsCategory('Expenses:Mortgage Interest')).toBe('housing');
        expect(mapAccountToBlsCategory('Expenses:Utilities:Electric')).toBe('utilities');
        expect(mapAccountToBlsCategory('Expenses:Medical:Dentist')).toBe('healthcare');
        expect(mapAccountToBlsCategory('Expenses:Clothing')).toBe('apparel');
        expect(mapAccountToBlsCategory('Expenses:Charity:Church')).toBe('cash_contributions');
        expect(mapAccountToBlsCategory('Expenses:Education:Tuition')).toBe('education');
        expect(mapAccountToBlsCategory('Expenses:Haircuts')).toBe('personal_care');
        expect(mapAccountToBlsCategory('Expenses:Entertainment:Streaming')).toBe('entertainment');
        expect(mapAccountToBlsCategory('Expenses:Auto:Repairs')).toBe('transportation');
    });

    it('maps bare "Gas" under an auto path to gasoline, not utilities', () => {
        expect(mapAccountToBlsCategory('Expenses:Auto:Gas')).toBe('gasoline');
        expect(mapAccountToBlsCategory('Expenses:Car:Gas')).toBe('gasoline');
    });

    it('maps natural gas to utilities', () => {
        expect(mapAccountToBlsCategory('Expenses:Utilities:Natural Gas')).toBe('utilities');
    });

    it('maps gasoline keywords ahead of transportation', () => {
        expect(mapAccountToBlsCategory('Expenses:Transportation:Gasoline')).toBe('gasoline');
    });

    it('prefers food_away for dining even though "food" is a food_at_home keyword', () => {
        expect(mapAccountToBlsCategory('Expenses:Food:Fast Food')).toBe('food_away');
        expect(mapAccountToBlsCategory('Expenses:Food')).toBe('food_at_home');
    });

    it('is case-insensitive', () => {
        expect(mapAccountToBlsCategory('EXPENSES:GROCERIES')).toBe('food_at_home');
    });

    it('returns null for unrecognized and empty paths', () => {
        expect(mapAccountToBlsCategory('Expenses:Miscellaneous')).toBeNull();
        expect(mapAccountToBlsCategory('')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ratio / delta math
// ─────────────────────────────────────────────────────────────────────────────

describe('computeBlsComparison', () => {
    it('computes ratio and delta per category', () => {
        const rows = computeBlsComparison({ food_at_home: 8000 }, 2);
        const food = rows.find((r) => r.category === 'food_at_home')!;
        const expectedAvg = getBlsAverage('food_at_home', 2);
        expect(food.yourSpend).toBe(8000);
        expect(food.blsAverage).toBe(expectedAvg);
        expect(food.delta).toBeCloseTo(8000 - expectedAvg, 9);
        expect(food.ratio).toBeCloseTo(8000 / expectedAvg, 9);
    });

    it('includes all categories even with zero spend', () => {
        const rows = computeBlsComparison({}, 2);
        expect(rows).toHaveLength(BLS_CATEGORIES.length);
        for (const row of rows) {
            expect(row.yourSpend).toBe(0);
            expect(row.delta).toBe(-row.blsAverage);
            expect(row.ratio).toBe(0);
        }
    });

    it('sorts by absolute delta descending', () => {
        const rows = computeBlsComparison({ food_at_home: 100_000 }, 2);
        expect(rows[0].category).toBe('food_at_home');
        for (let i = 1; i < rows.length; i++) {
            expect(Math.abs(rows[i - 1].delta)).toBeGreaterThanOrEqual(Math.abs(rows[i].delta));
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// compareToBls (mocked prisma)
// ─────────────────────────────────────────────────────────────────────────────

describe('compareToBls', () => {
    beforeEach(() => {
        mockAccountsFindMany.mockReset();
        mockQueryRaw.mockReset();
    });

    it('aggregates spend by mapped category and reports unmapped separately', async () => {
        mockAccountsFindMany.mockResolvedValue([
            { guid: 'root', name: 'Root Account', parent_guid: null, account_type: 'ROOT' },
            { guid: 'exp', name: 'Expenses', parent_guid: 'root', account_type: 'EXPENSE' },
            { guid: 'groc', name: 'Groceries', parent_guid: 'exp', account_type: 'EXPENSE' },
            { guid: 'misc', name: 'Miscellaneous', parent_guid: 'exp', account_type: 'EXPENSE' },
        ]);
        mockQueryRaw.mockResolvedValue([
            { account_guid: 'groc', amount: 6200 },
            { account_guid: 'misc', amount: 1500 },
        ]);

        const report = await compareToBls(['root', 'exp', 'groc', 'misc'], 2025, 2);

        const food = report.rows.find((r) => r.category === 'food_at_home')!;
        expect(food.yourSpend).toBeCloseTo(6200, 9);
        expect(report.unmapped.total).toBeCloseTo(1500, 9);
        expect(report.unmapped.accounts[0].path).toBe('Expenses:Miscellaneous');
        expect(report.year).toBe(2025);
        expect(report.householdSize).toBe(2);
        expect(report.vintage).toMatch(/approximate/i);
        expect(report.totals.yourSpend).toBeCloseTo(6200, 9);
    });

    it('returns a full zero-spend report when there are no expense accounts', async () => {
        mockAccountsFindMany.mockResolvedValue([
            { guid: 'root', name: 'Root Account', parent_guid: null, account_type: 'ROOT' },
            { guid: 'bank', name: 'Checking', parent_guid: 'root', account_type: 'BANK' },
        ]);

        const report = await compareToBls(['root', 'bank'], 2025, 3);
        expect(report.rows).toHaveLength(BLS_CATEGORIES.length);
        expect(report.totals.yourSpend).toBe(0);
        expect(report.totals.blsAverage).toBeGreaterThan(0);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('handles an empty account list without querying', async () => {
        const report = await compareToBls([], 2025, 2);
        expect(report.rows).toHaveLength(BLS_CATEGORIES.length);
        expect(mockAccountsFindMany).not.toHaveBeenCalled();
    });

    it('clamps out-of-range household sizes', async () => {
        const report = await compareToBls([], 2025, 12);
        expect(report.householdSize).toBe(5);
    });
});
