import { describe, it, expect, vi } from 'vitest';

// Both libs import prisma at module scope; the pure cores never touch it.
vi.mock('../prisma', () => ({
    default: {},
}));

import {
    computeDayOfWeek,
    countWeekdayOccurrences,
    DayOfWeekFlowRow,
} from '../reports/day-of-week';
import { computeAverageBalance, BalanceDelta } from '../reports/average-balance';

// ─────────────────────────────────────────────────────────────────────────────
// Day of week
// ─────────────────────────────────────────────────────────────────────────────

describe('countWeekdayOccurrences', () => {
    it('counts a single-day range', () => {
        // 2026-07-01 is a Wednesday (UTC)
        expect(countWeekdayOccurrences('2026-07-01', '2026-07-01', 3)).toBe(1);
        expect(countWeekdayOccurrences('2026-07-01', '2026-07-01', 4)).toBe(0);
    });

    it('counts full weeks exactly once per weekday', () => {
        // 14 days starting Wednesday 2026-07-01
        for (let weekday = 0; weekday < 7; weekday++) {
            expect(countWeekdayOccurrences('2026-07-01', '2026-07-14', weekday)).toBe(2);
        }
    });

    it('counts partial weeks across a month boundary', () => {
        // 2026-06-29 (Mon) .. 2026-07-03 (Fri): Mon,Tue,Wed,Thu,Fri once, Sat/Sun zero
        expect(countWeekdayOccurrences('2026-06-29', '2026-07-03', 1)).toBe(1); // Monday
        expect(countWeekdayOccurrences('2026-06-29', '2026-07-03', 5)).toBe(1); // Friday
        expect(countWeekdayOccurrences('2026-06-29', '2026-07-03', 6)).toBe(0); // Saturday
        expect(countWeekdayOccurrences('2026-06-29', '2026-07-03', 0)).toBe(0); // Sunday
    });

    it('returns 0 for an inverted range', () => {
        expect(countWeekdayOccurrences('2026-07-10', '2026-07-01', 1)).toBe(0);
    });
});

describe('computeDayOfWeek', () => {
    it('buckets flows by UTC weekday across a month boundary', () => {
        // 2026-06-30 is a Tuesday, 2026-07-01 a Wednesday
        const rows: DayOfWeekFlowRow[] = [
            { postDate: '2026-06-30T12:00:00Z', accountType: 'EXPENSE', amount: 40 },
            { postDate: '2026-07-01T12:00:00Z', accountType: 'EXPENSE', amount: 60 },
            { postDate: '2026-07-07T12:00:00Z', accountType: 'EXPENSE', amount: 10 }, // Tuesday again
            { postDate: '2026-07-01T12:00:00Z', accountType: 'INCOME', amount: -500 },
        ];

        const { days, totals } = computeDayOfWeek(rows, '2026-06-30', '2026-07-13');

        const tuesday = days[2];
        const wednesday = days[3];
        expect(tuesday.expense).toBeCloseTo(50, 6); // 40 (Jun 30) + 10 (Jul 7)
        expect(wednesday.expense).toBeCloseTo(60, 6);
        expect(wednesday.income).toBeCloseTo(500, 6); // negated income
        expect(totals.expense).toBeCloseTo(110, 6);
        expect(totals.income).toBeCloseTo(500, 6);
    });

    it('handles a post date that is the previous day in local time but not UTC', () => {
        // Midnight UTC on 2026-07-06 (a Monday). In UTC-5 this is Sunday evening,
        // but the report is documented to bucket by UTC → Monday.
        const rows: DayOfWeekFlowRow[] = [
            { postDate: '2026-07-06T00:00:00Z', accountType: 'EXPENSE', amount: 25 },
        ];
        const { days } = computeDayOfWeek(rows, '2026-07-01', '2026-07-31');
        expect(days[1].expense).toBeCloseTo(25, 6); // Monday
        expect(days[0].expense).toBe(0); // not Sunday
    });

    it('computes averages per weekday occurrence in the range', () => {
        // Range 2026-07-01 (Wed) .. 2026-07-14 (Tue): every weekday occurs twice
        const rows: DayOfWeekFlowRow[] = [
            { postDate: '2026-07-03T12:00:00Z', accountType: 'EXPENSE', amount: 100 }, // Friday
            { postDate: '2026-07-10T12:00:00Z', accountType: 'EXPENSE', amount: 50 },  // Friday
        ];
        const { days } = computeDayOfWeek(rows, '2026-07-01', '2026-07-14');
        const friday = days[5];
        expect(friday.occurrences).toBe(2);
        expect(friday.expense).toBeCloseTo(150, 6);
        expect(friday.expenseAvg).toBeCloseTo(75, 6);
    });

    it('ignores account types other than INCOME/EXPENSE', () => {
        const rows: DayOfWeekFlowRow[] = [
            { postDate: '2026-07-01T12:00:00Z', accountType: 'BANK', amount: 999 },
        ];
        const { totals } = computeDayOfWeek(rows, '2026-07-01', '2026-07-31');
        expect(totals.income).toBe(0);
        expect(totals.expense).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Average balance
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAverageBalance', () => {
    it('reports a flat balance when there are no transactions', () => {
        const buckets = computeAverageBalance(1000, [], '2026-01-01', '2026-01-31');
        expect(buckets).toHaveLength(1);
        expect(buckets[0]).toMatchObject({
            month: '2026-01',
            label: 'Jan 2026',
            days: 31,
        });
        expect(buckets[0].average).toBeCloseTo(1000, 6);
        expect(buckets[0].min).toBeCloseTo(1000, 6);
        expect(buckets[0].max).toBeCloseTo(1000, 6);
        expect(buckets[0].ending).toBeCloseTo(1000, 6);
    });

    it('computes average daily balance with a mid-month transaction', () => {
        // April has 30 days. Opening 100; +200 posted on the 16th.
        // End-of-day balances: days 1-15 → 100, days 16-30 → 300.
        const deltas: BalanceDelta[] = [{ date: '2026-04-16', amount: 200 }];
        const buckets = computeAverageBalance(100, deltas, '2026-04-01', '2026-04-30');

        expect(buckets).toHaveLength(1);
        const b = buckets[0];
        expect(b.days).toBe(30);
        expect(b.average).toBeCloseTo((15 * 100 + 15 * 300) / 30, 6); // 200
        expect(b.min).toBeCloseTo(100, 6);
        expect(b.max).toBeCloseTo(300, 6);
        expect(b.ending).toBeCloseTo(300, 6);
    });

    it('tracks min/max through dips and carries balances across months', () => {
        const deltas: BalanceDelta[] = [
            { date: '2026-01-10', amount: -400 }, // dip to 600
            { date: '2026-01-20', amount: 900 },  // up to 1500
            { date: '2026-02-05', amount: -100 }, // Feb: 1400
        ];
        const buckets = computeAverageBalance(1000, deltas, '2026-01-01', '2026-02-28');

        expect(buckets.map(b => b.month)).toEqual(['2026-01', '2026-02']);
        const jan = buckets[0];
        const feb = buckets[1];
        expect(jan.min).toBeCloseTo(600, 6);
        expect(jan.max).toBeCloseTo(1500, 6);
        expect(jan.ending).toBeCloseTo(1500, 6);
        // Jan: days 1-9 → 1000 (9d), 10-19 → 600 (10d), 20-31 → 1500 (12d)
        expect(jan.average).toBeCloseTo((9 * 1000 + 10 * 600 + 12 * 1500) / 31, 6);

        // Feb opens from Jan's ending balance
        expect(feb.max).toBeCloseTo(1500, 6);
        expect(feb.min).toBeCloseTo(1400, 6);
        expect(feb.ending).toBeCloseTo(1400, 6);
        expect(feb.days).toBe(28);
        expect(feb.average).toBeCloseTo((4 * 1500 + 24 * 1400) / 28, 6);
    });

    it('sums multiple deltas on the same day', () => {
        const deltas: BalanceDelta[] = [
            { date: '2026-03-02', amount: 50 },
            { date: '2026-03-02', amount: -20 },
        ];
        const buckets = computeAverageBalance(0, deltas, '2026-03-01', '2026-03-03');
        expect(buckets[0].ending).toBeCloseTo(30, 6);
        expect(buckets[0].average).toBeCloseTo((0 + 30 + 30) / 3, 6);
    });

    it('buckets a range spanning partial months', () => {
        const buckets = computeAverageBalance(500, [], '2026-01-25', '2026-02-03');
        expect(buckets.map(b => b.month)).toEqual(['2026-01', '2026-02']);
        expect(buckets[0].days).toBe(7); // Jan 25-31
        expect(buckets[1].days).toBe(3); // Feb 1-3
    });

    it('returns [] for an inverted range', () => {
        expect(computeAverageBalance(0, [], '2026-02-01', '2026-01-01')).toEqual([]);
    });

    it('applies a delta dated on the range start to that first day (end-of-day convention)', () => {
        const deltas: BalanceDelta[] = [{ date: '2026-05-01', amount: 100 }];
        const buckets = computeAverageBalance(0, deltas, '2026-05-01', '2026-05-02');
        expect(buckets[0].min).toBeCloseTo(100, 6);
        expect(buckets[0].average).toBeCloseTo(100, 6);
    });
});
