import { describe, it, expect } from 'vitest';
import { bucketByRanges, monthsPerPeriod, parseEstimateMethod } from '@/lib/budget-estimate';

describe('monthsPerPeriod', () => {
    it('maps the common recurrence types', () => {
        expect(monthsPerPeriod('month', 1)).toBe(1);
        expect(monthsPerPeriod('month', 3)).toBe(3); // quarterly-as-3-month-mult
        expect(monthsPerPeriod('year', 1)).toBe(12);
        expect(monthsPerPeriod('end of year', 1)).toBe(12);
    });

    it('approximates week/day periods via average month length', () => {
        expect(monthsPerPeriod('week', 1)).toBeCloseTo(7 / 30.44, 5);
        expect(monthsPerPeriod('day', 30)).toBeCloseTo(30 / 30.44, 5);
    });

    it('defaults unknown types and zero mult to monthly', () => {
        expect(monthsPerPeriod('', 0)).toBe(1);
        expect(monthsPerPeriod('nth weekday', 1)).toBe(1);
    });
});

describe('bucketByRanges', () => {
    const ranges = [
        { start: '2025-01-01', end: '2025-01-31' },
        { start: '2025-02-01', end: '2025-02-28' },
    ];

    it('sums amounts into their inclusive date range', () => {
        const items = [
            { dateKey: '2025-01-01', amount: 10 },   // first day inclusive
            { dateKey: '2025-01-31', amount: 5 },    // last day inclusive
            { dateKey: '2025-02-15', amount: -20 },  // raw income sign preserved
            { dateKey: '2025-03-01', amount: 999 },  // outside every range → dropped
        ];
        expect(bucketByRanges(items, ranges)).toEqual([15, -20]);
    });

    it('keeps raw GnuCash sign — income months stay negative', () => {
        const items = [
            { dateKey: '2025-01-10', amount: -5000 },
            { dateKey: '2025-01-20', amount: -1200.51 },
        ];
        const [jan] = bucketByRanges(items, ranges);
        expect(jan).toBeCloseTo(-6200.51, 2);
    });

    it('returns zero-filled buckets for no activity', () => {
        expect(bucketByRanges([], ranges)).toEqual([0, 0]);
    });
});

describe('parseEstimateMethod', () => {
    it('accepts the known methods and defaults everything else to average', () => {
        expect(parseEstimateMethod('seasonal')).toBe('seasonal');
        expect(parseEstimateMethod('median')).toBe('median');
        expect(parseEstimateMethod('average')).toBe('average');
        expect(parseEstimateMethod('bogus')).toBe('average');
        expect(parseEstimateMethod(null)).toBe('average');
    });
});
