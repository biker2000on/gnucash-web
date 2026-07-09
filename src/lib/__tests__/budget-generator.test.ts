import { describe, it, expect } from 'vitest';
import {
    generateFromHistory,
    applyTemplate,
    applyScenario,
    roundToNearest,
    median,
    mean,
    classifyAllocationBucket,
    trailingMonthKeys,
    type MonthlyHistoryAccount,
} from '@/lib/budget-generator';

function account(overrides: Partial<MonthlyHistoryAccount> = {}): MonthlyHistoryAccount {
    return {
        guid: 'a'.repeat(32),
        name: 'Groceries',
        fullname: 'Expenses:Groceries',
        type: 'EXPENSE',
        monthly: [],
        ...overrides,
    };
}

describe('roundToNearest', () => {
    it('rounds to the nearest multiple', () => {
        expect(roundToNearest(123, 5)).toBe(125);
        expect(roundToNearest(122.4, 5)).toBe(120);
        expect(roundToNearest(7.5, 5)).toBe(10);
        expect(roundToNearest(0, 5)).toBe(0);
    });

    it('falls back to cents for non-positive granularity', () => {
        expect(roundToNearest(1.006, 0)).toBe(1.01);
        expect(roundToNearest(1.006, -5)).toBe(1.01);
    });

    it('handles cent granularity without float noise', () => {
        expect(roundToNearest(0.1 + 0.2, 0.01)).toBe(0.3);
    });
});

describe('median / mean', () => {
    it('returns 0 for empty input', () => {
        expect(median([])).toBe(0);
        expect(mean([])).toBe(0);
    });

    it('computes odd and even medians', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
    });
});

describe('generateFromHistory', () => {
    it('median resists an outlier month while mean absorbs it', () => {
        // 5 normal months at ~$400, one blowout at $2400
        const monthly = [400, 410, 390, 2400, 400, 405];
        const acc = account({ monthly });

        const [medianLine] = generateFromHistory([acc], { statistic: 'median', roundTo: 5 });
        const [meanLine] = generateFromHistory([acc], { statistic: 'mean', roundTo: 5 });

        // median of sorted [390,400,400,405,410,2400] = (400+405)/2 = 402.5 → 405
        expect(medianLine.amount).toBe(405);
        // mean = 4405/6 ≈ 734.17 → 735
        expect(meanLine.amount).toBe(735);
        expect(meanLine.amount).toBeGreaterThan(medianLine.amount);
    });

    it('counts zero months in the window (sporadic spending suggests less)', () => {
        // Quarterly bill: 3 of 6 months at $90, others 0
        const acc = account({ monthly: [90, 0, 90, 0, 90, 0] });
        const [line] = generateFromHistory([acc], { statistic: 'median', roundTo: 5 });
        // median of [0,0,0,90,90,90] = (0+90)/2 = 45
        expect(line.amount).toBe(45);

        const [meanLine] = generateFromHistory([acc], { statistic: 'mean', roundTo: 5 });
        expect(meanLine.amount).toBe(45); // 270/6 = 45
    });

    it('rounds to the nearest $5 by default', () => {
        const acc = account({ monthly: [123, 123, 123] });
        const [line] = generateFromHistory([acc]);
        expect(line.amount).toBe(125);
        expect(line.amount % 5).toBe(0);
    });

    it('clamps net-refund accounts at 0 instead of a negative budget', () => {
        const acc = account({ monthly: [-50, -60, -55] });
        const [line] = generateFromHistory([acc]);
        expect(line.amount).toBe(0);
    });

    it('returns no lines for empty history input', () => {
        expect(generateFromHistory([])).toEqual([]);
    });

    it('an account with an all-zero window suggests 0', () => {
        const acc = account({ monthly: [0, 0, 0, 0, 0, 0] });
        const [line] = generateFromHistory([acc]);
        expect(line.amount).toBe(0);
        expect(line.avgMonthly).toBe(0);
    });

    it('reports avgMonthly as the mean regardless of statistic', () => {
        const acc = account({ monthly: [100, 200, 300] });
        const [line] = generateFromHistory([acc], { statistic: 'median' });
        expect(line.avgMonthly).toBe(200);
    });
});

describe('classifyAllocationBucket', () => {
    it('classifies savings, needs, and wants by keywords', () => {
        expect(classifyAllocationBucket('Expenses:Retirement:401k')).toBe('savings');
        expect(classifyAllocationBucket('Assets:Investments:Brokerage')).toBe('savings');
        expect(classifyAllocationBucket('Expenses:Rent')).toBe('needs');
        expect(classifyAllocationBucket('Expenses:Groceries')).toBe('needs');
        expect(classifyAllocationBucket('Expenses:Auto:Fuel')).toBe('needs');
        expect(classifyAllocationBucket('Expenses:Dining Out')).toBe('wants');
        expect(classifyAllocationBucket('Expenses:Entertainment')).toBe('wants');
    });
});

describe('applyTemplate pct-of-income', () => {
    const accounts = [
        { guid: '1'.repeat(32), name: 'Rent', fullname: 'Expenses:Rent', type: 'EXPENSE', avgMonthly: 1500 },
        { guid: '2'.repeat(32), name: 'Groceries', fullname: 'Expenses:Groceries', type: 'EXPENSE', avgMonthly: 500 },
        { guid: '3'.repeat(32), name: 'Dining', fullname: 'Expenses:Dining', type: 'EXPENSE', avgMonthly: 300 },
        { guid: '4'.repeat(32), name: 'Travel', fullname: 'Expenses:Travel', type: 'EXPENSE', avgMonthly: 100 },
        { guid: '5'.repeat(32), name: '401k', fullname: 'Expenses:Retirement:401k', type: 'EXPENSE', avgMonthly: 600 },
    ];
    const allocations = { needs: 0.5, wants: 0.3, savings: 0.2 };

    it('each bucket sums to income x pct within rounding tolerance', () => {
        const income = 6000;
        const lines = applyTemplate('pct-of-income', {
            monthlyIncome: income,
            allocations,
            accounts,
            roundTo: 5,
        });
        expect(lines).toHaveLength(accounts.length);

        const sumFor = (guids: string[]) =>
            lines.filter(l => guids.includes(l.accountGuid)).reduce((s, l) => s + l.amount, 0);

        // needs: rent + groceries share 3000 proportionally (1500:500)
        const needsSum = sumFor(['1'.repeat(32), '2'.repeat(32)]);
        expect(Math.abs(needsSum - income * allocations.needs)).toBeLessThanOrEqual(5);
        expect(lines.find(l => l.name === 'Rent')!.amount).toBe(2250); // 3000 * 0.75
        expect(lines.find(l => l.name === 'Groceries')!.amount).toBe(750); // 3000 * 0.25

        // wants: dining + travel share 1800 (300:100)
        const wantsSum = sumFor(['3'.repeat(32), '4'.repeat(32)]);
        expect(Math.abs(wantsSum - income * allocations.wants)).toBeLessThanOrEqual(5);

        // savings: single account gets the full 1200
        expect(lines.find(l => l.name === '401k')!.amount).toBe(1200);
    });

    it('splits equally when a bucket has no history', () => {
        const lines = applyTemplate('pct-of-income', {
            monthlyIncome: 1000,
            allocations,
            accounts: [
                { guid: '6'.repeat(32), name: 'Dining', fullname: 'Expenses:Dining', type: 'EXPENSE', avgMonthly: 0 },
                { guid: '7'.repeat(32), name: 'Hobbies', fullname: 'Expenses:Hobbies', type: 'EXPENSE', avgMonthly: 0 },
            ],
            roundTo: 5,
        });
        // wants bucket target = 300, split equally = 150 each
        expect(lines.map(l => l.amount)).toEqual([150, 150]);
    });

    it('treats negative history as zero weight', () => {
        const lines = applyTemplate('pct-of-income', {
            monthlyIncome: 1000,
            allocations,
            accounts: [
                { guid: '8'.repeat(32), name: 'Dining', fullname: 'Expenses:Dining', type: 'EXPENSE', avgMonthly: 300 },
                { guid: '9'.repeat(32), name: 'Refunds', fullname: 'Expenses:Refunds', type: 'EXPENSE', avgMonthly: -100 },
            ],
            roundTo: 5,
        });
        expect(lines.find(l => l.name === 'Dining')!.amount).toBe(300); // full wants target
        expect(lines.find(l => l.name === 'Refunds')!.amount).toBe(0);
    });
});

describe('applyTemplate zero-based', () => {
    it('starts every selected account at 0', () => {
        const lines = applyTemplate('zero-based', {
            accounts: [
                { guid: '1'.repeat(32), name: 'Rent', fullname: 'Expenses:Rent', type: 'EXPENSE' },
                { guid: '2'.repeat(32), name: 'Dining', fullname: 'Expenses:Dining', type: 'EXPENSE' },
            ],
        });
        expect(lines).toHaveLength(2);
        expect(lines.every(l => l.amount === 0)).toBe(true);
    });

    it('handles empty account lists', () => {
        expect(applyTemplate('zero-based', { accounts: [] })).toEqual([]);
    });
});

describe('applyScenario', () => {
    it('scales amounts by the factor (lean 0.9)', () => {
        expect(applyScenario([100, 250, 0], 0.9)).toEqual([90, 225, 0]);
    });

    it('scales up (stretch 1.1) with cent rounding', () => {
        expect(applyScenario([333.33], 1.1)).toEqual([366.66]); // 366.663 → 366.66
    });

    it('is stable: factor 1.0 returns identical amounts', () => {
        const amounts = [123.45, 0, 87.5, 1000];
        expect(applyScenario(amounts, 1.0)).toEqual(amounts);
    });

    it('supports custom rounding granularity', () => {
        expect(applyScenario([123], 0.9, 5)).toEqual([110]); // 110.7 → 110
    });

    it('handles negative amounts (income budget lines) consistently', () => {
        expect(applyScenario([-500], 1.1)).toEqual([-550]);
    });

    it('handles empty input', () => {
        expect(applyScenario([], 0.9)).toEqual([]);
    });
});

describe('trailingMonthKeys', () => {
    it('returns the N complete months before the current one, oldest first', () => {
        const now = new Date(Date.UTC(2026, 6, 8)); // 2026-07-08
        expect(trailingMonthKeys(3, now)).toEqual(['2026-04', '2026-05', '2026-06']);
    });

    it('crosses year boundaries', () => {
        const now = new Date(Date.UTC(2026, 1, 15)); // 2026-02-15
        expect(trailingMonthKeys(4, now)).toEqual(['2025-10', '2025-11', '2025-12', '2026-01']);
    });
});
