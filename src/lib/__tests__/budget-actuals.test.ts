/**
 * Unit tests for the pure budget-vs-actuals math in src/lib/budget-actuals.ts:
 * period → calendar mapping, pctUsed, pacing (elapsed-fraction edges),
 * projected overspend, status transitions, income handling, and YoY deltas.
 */

import { describe, it, expect } from 'vitest';
import {
    computePeriodRanges,
    findCurrentPeriodNum,
    computeElapsedFraction,
    computePacing,
    computeBudgetProgress,
    computeYoY,
    signCorrectAmount,
    shiftDateKeyOneYearBack,
    type BudgetRecurrence,
    type ProgressAccountInput,
} from '@/lib/budget-actuals';

const monthly: BudgetRecurrence = { periodType: 'month', mult: 1, periodStart: '2026-01-01' };

function account(overrides: Partial<ProgressAccountInput> = {}): ProgressAccountInput {
    return {
        guid: 'acc1',
        name: 'Groceries',
        type: 'EXPENSE',
        budgeted: [],
        actual: [],
        ...overrides,
    };
}

describe('computePeriodRanges', () => {
    it('maps 12 monthly periods to calendar months', () => {
        const ranges = computePeriodRanges(monthly, 12);
        expect(ranges).toHaveLength(12);
        expect(ranges[0]).toMatchObject({ periodNum: 0, start: '2026-01-01', end: '2026-01-31', label: 'Jan 2026' });
        expect(ranges[1]).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
        expect(ranges[11]).toMatchObject({ start: '2026-12-01', end: '2026-12-31', label: 'Dec 2026' });
    });

    it('handles leap-year February', () => {
        const ranges = computePeriodRanges({ ...monthly, periodStart: '2028-01-01' }, 3);
        expect(ranges[1]).toMatchObject({ start: '2028-02-01', end: '2028-02-29' });
    });

    it('ignores the day component of period_start for monthly periods (digest parity)', () => {
        // The digest maps months by (year, month) offset only — a mid-month
        // period_start must still produce whole calendar months.
        const ranges = computePeriodRanges({ ...monthly, periodStart: '2026-01-15' }, 2);
        expect(ranges[0]).toMatchObject({ start: '2026-01-01', end: '2026-01-31' });
        expect(ranges[1]).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
    });

    it('maps quarterly budgets (month type, mult 3)', () => {
        const ranges = computePeriodRanges({ periodType: 'month', mult: 3, periodStart: '2026-01-01' }, 4);
        expect(ranges[0]).toMatchObject({ start: '2026-01-01', end: '2026-03-31', label: 'Jan–Mar 2026' });
        expect(ranges[3]).toMatchObject({ start: '2026-10-01', end: '2026-12-31' });
    });

    it('maps yearly budgets to 12-month blocks', () => {
        const ranges = computePeriodRanges({ periodType: 'year', mult: 1, periodStart: '2025-01-01' }, 2);
        expect(ranges[0]).toMatchObject({ start: '2025-01-01', end: '2025-12-31', label: '2025' });
        expect(ranges[1]).toMatchObject({ start: '2026-01-01', end: '2026-12-31', label: '2026' });
    });

    it('maps weekly budgets to 7-day blocks anchored at period_start', () => {
        const ranges = computePeriodRanges({ periodType: 'week', mult: 1, periodStart: '2026-01-05' }, 2);
        expect(ranges[0]).toMatchObject({ start: '2026-01-05', end: '2026-01-11' });
        expect(ranges[1]).toMatchObject({ start: '2026-01-12', end: '2026-01-18' });
    });
});

describe('findCurrentPeriodNum', () => {
    const ranges = computePeriodRanges(monthly, 12);

    it('finds the containing period', () => {
        expect(findCurrentPeriodNum(ranges, '2026-07-08')).toBe(6);
        expect(findCurrentPeriodNum(ranges, '2026-01-01')).toBe(0);
        expect(findCurrentPeriodNum(ranges, '2026-12-31')).toBe(11);
    });

    it('returns null outside the budget span', () => {
        expect(findCurrentPeriodNum(ranges, '2025-12-31')).toBeNull();
        expect(findCurrentPeriodNum(ranges, '2027-01-01')).toBeNull();
    });
});

describe('computeElapsedFraction', () => {
    const jan = { start: '2026-01-01', end: '2026-01-31' };

    it('is 1/totalDays on the first day (never zero inside the range)', () => {
        expect(computeElapsedFraction(jan, '2026-01-01')).toBeCloseTo(1 / 31, 10);
    });

    it('is 1 on the last day', () => {
        expect(computeElapsedFraction(jan, '2026-01-31')).toBe(1);
    });

    it('is proportional mid-period', () => {
        expect(computeElapsedFraction(jan, '2026-01-16')).toBeCloseTo(16 / 31, 10);
    });

    it('clamps outside the range', () => {
        expect(computeElapsedFraction(jan, '2025-12-31')).toBe(0);
        expect(computeElapsedFraction(jan, '2026-02-05')).toBe(1);
    });

    it('guards degenerate single-day periods', () => {
        expect(computeElapsedFraction({ start: '2026-01-01', end: '2026-01-01' }, '2026-01-01')).toBe(1);
    });
});

describe('computePacing', () => {
    it('projects straight-line end-of-period spend', () => {
        // Halfway through the period, spent 60 of 100.
        const p = computePacing(100, 60, 0, 0.5);
        expect(p.projected).toBe(120);
        expect(p.projectedOver).toBe(20);
        expect(p.pctUsed).toBe(60);
        expect(p.paceRatio).toBeCloseTo(1.2, 4);
        expect(p.status).toBe('warning');
    });

    it('is on-track when projected spend stays within budget', () => {
        const p = computePacing(100, 40, 0, 0.5);
        expect(p.projected).toBe(80);
        expect(p.projectedOver).toBe(0);
        expect(p.status).toBe('on-track');
    });

    it('is over when actual already exceeds budget', () => {
        const p = computePacing(100, 110, 0, 0.5);
        expect(p.status).toBe('over');
        expect(p.projected).toBe(220);
        expect(p.projectedOver).toBe(120);
    });

    it('transitions on-track → warning → over as spend grows', () => {
        expect(computePacing(100, 45, 0, 0.5).status).toBe('on-track');
        expect(computePacing(100, 55, 0, 0.5).status).toBe('warning');
        expect(computePacing(100, 100.01, 0, 0.5).status).toBe('over');
    });

    it('guards division at elapsedFraction 0 (falls back to actual)', () => {
        const p = computePacing(100, 30, 0, 0);
        expect(p.projected).toBe(30);
        expect(p.paceRatio).toBeNull();
        expect(p.status).toBe('on-track');
    });

    it('handles zero budget: pctUsed null, spend flagged over', () => {
        const p = computePacing(0, 25, 0, 0.5);
        expect(p.pctUsed).toBeNull();
        expect(p.paceRatio).toBeNull();
        expect(p.status).toBe('over');
        const idle = computePacing(0, 0, 0, 0.5);
        expect(idle.status).toBe('on-track');
    });

    it('does not flag as over within the rounding epsilon', () => {
        expect(computePacing(100, 100.004, 0, 1).status).toBe('on-track');
    });
});

describe('computeBudgetProgress', () => {
    const ranges = computePeriodRanges(monthly, 3);

    it('computes budgeted, actual, remaining, pctUsed per period and totals', () => {
        const result = computeBudgetProgress({
            ranges,
            accounts: [account({ budgeted: [100, 100, 100], actual: [80, 120, 0] })],
            asOf: '2026-02-14',
        });

        const acc = result.accounts[0];
        expect(acc.periods[0]).toMatchObject({ budgeted: 100, actual: 80, remaining: 20, pctUsed: 80 });
        expect(acc.periods[1]).toMatchObject({ budgeted: 100, actual: 120, remaining: -20, pctUsed: 120 });
        expect(acc.total).toMatchObject({ budgeted: 300, actual: 200, remaining: 100 });
        expect(acc.total.pctUsed).toBeCloseTo(66.67, 1);
    });

    it('attaches pacing only for the current period', () => {
        const result = computeBudgetProgress({
            ranges,
            accounts: [account({ budgeted: [100, 100, 100], actual: [80, 70, 0] })],
            asOf: '2026-02-14', // Feb: 14/28 elapsed = 0.5
        });
        expect(result.currentPeriod).toBe(1);
        expect(result.elapsedFraction).toBeCloseTo(0.5, 4);
        const pacing = result.accounts[0].pacing!;
        expect(pacing.periodNum).toBe(1);
        expect(pacing.actual).toBe(70);
        expect(pacing.projected).toBe(140);
        expect(pacing.status).toBe('warning');
    });

    it('yields null pacing when asOf is outside the budget', () => {
        const result = computeBudgetProgress({
            ranges,
            accounts: [account({ budgeted: [100, 100, 100], actual: [80, 0, 0] })],
            asOf: '2027-06-01',
        });
        expect(result.currentPeriod).toBeNull();
        expect(result.elapsedFraction).toBeNull();
        expect(result.accounts[0].pacing).toBeNull();
        expect(result.pacing).toBeNull();
    });

    it('rolls up periodTotals/totals/pacing over EXPENSE accounts only', () => {
        const result = computeBudgetProgress({
            ranges,
            accounts: [
                account({ guid: 'e1', budgeted: [100, 100, 100], actual: [50, 60, 0] }),
                account({ guid: 'e2', name: 'Dining', budgeted: [50, 50, 50], actual: [20, 30, 0] }),
                account({ guid: 'i1', name: 'Salary', type: 'INCOME', budgeted: [5000, 5000, 5000], actual: [5000, 2500, 0] }),
            ],
            asOf: '2026-02-14',
        });
        expect(result.periodTotals[0]).toMatchObject({ budgeted: 150, actual: 70 });
        expect(result.totals).toMatchObject({ budgeted: 450, actual: 160 });
        expect(result.pacing!.budgeted).toBe(150);
        expect(result.pacing!.actual).toBe(90);
        // Income account still gets its own row with pacing math.
        const income = result.accounts.find(a => a.guid === 'i1')!;
        expect(income.periods[0].pctUsed).toBe(100);
    });

    it('handles an empty budget (no accounts)', () => {
        const result = computeBudgetProgress({ ranges, accounts: [], asOf: '2026-02-14' });
        expect(result.accounts).toEqual([]);
        expect(result.totals).toMatchObject({ budgeted: 0, actual: 0, remaining: 0, pctUsed: null });
        expect(result.pacing!.status).toBe('on-track');
    });
});

describe('signCorrectAmount', () => {
    it('negates INCOME (stored negative in GnuCash)', () => {
        expect(signCorrectAmount('INCOME', -5000)).toBe(5000);
    });

    it('passes EXPENSE and other types through', () => {
        expect(signCorrectAmount('EXPENSE', 123.45)).toBe(123.45);
        expect(signCorrectAmount('ASSET', -10)).toBe(-10);
    });
});

describe('shiftDateKeyOneYearBack', () => {
    it('shifts a plain date back one year', () => {
        expect(shiftDateKeyOneYearBack('2026-07-08')).toBe('2025-07-08');
    });

    it('clamps Feb 29 to Feb 28 in non-leap prior years', () => {
        expect(shiftDateKeyOneYearBack('2028-02-29')).toBe('2027-02-28');
    });
});

describe('computeYoY', () => {
    it('computes per-account and total deltas (absolute + %)', () => {
        const result = computeYoY(
            [
                { guid: 'e1', name: 'Groceries', type: 'EXPENSE', current: [100, 120], prior: [90, 100] },
                { guid: 'e2', name: 'Dining', type: 'EXPENSE', current: [40, 40], prior: [60, 60] },
            ],
            [0, 1]
        );
        const groceries = result.accounts.find(a => a.guid === 'e1')!;
        expect(groceries).toMatchObject({ current: 220, prior: 190, delta: 30 });
        expect(groceries.percent).toBeCloseTo(15.79, 1);
        const dining = result.accounts.find(a => a.guid === 'e2')!;
        expect(dining).toMatchObject({ current: 80, prior: 120, delta: -40 });
        expect(result.totals.expense).toMatchObject({ current: 300, prior: 310, delta: -10 });
        expect(result.hasPriorData).toBe(true);
        // Sorted biggest increase first.
        expect(result.accounts[0].guid).toBe('e1');
    });

    it('only sums the requested (elapsed) periods', () => {
        const result = computeYoY(
            [{ guid: 'e1', name: 'Groceries', type: 'EXPENSE', current: [100, 100, 999], prior: [50, 50, 999] }],
            [0, 1]
        );
        expect(result.accounts[0]).toMatchObject({ current: 200, prior: 100, delta: 100, percent: 100 });
    });

    it('handles a missing prior year: percent null, hasPriorData false', () => {
        const result = computeYoY(
            [{ guid: 'e1', name: 'Groceries', type: 'EXPENSE', current: [100], prior: [0] }],
            [0]
        );
        expect(result.accounts[0].percent).toBeNull();
        expect(result.hasPriorData).toBe(false);
        expect(result.totals.expense.percent).toBeNull();
    });

    it('splits totals between expense and income accounts', () => {
        const result = computeYoY(
            [
                { guid: 'e1', name: 'Groceries', type: 'EXPENSE', current: [100], prior: [80] },
                { guid: 'i1', name: 'Salary', type: 'INCOME', current: [5000], prior: [4800] },
            ],
            [0]
        );
        expect(result.totals.expense).toMatchObject({ current: 100, prior: 80 });
        expect(result.totals.income).toMatchObject({ current: 5000, prior: 4800, delta: 200 });
    });

    it('reports income totals as null when the budget has no income accounts', () => {
        const result = computeYoY(
            [{ guid: 'e1', name: 'Groceries', type: 'EXPENSE', current: [100], prior: [80] }],
            [0]
        );
        expect(result.totals.income).toBeNull();
    });

    it('handles an empty budget', () => {
        const result = computeYoY([], [0, 1]);
        expect(result.accounts).toEqual([]);
        expect(result.hasPriorData).toBe(false);
        expect(result.totals.expense).toMatchObject({ current: 0, prior: 0, delta: 0, percent: null });
    });
});
