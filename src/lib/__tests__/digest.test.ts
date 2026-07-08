/**
 * Monthly Digest pure-transform tests (no DB).
 *
 * Covers the assembly/formatting pieces that can be isolated: MoM delta math,
 * top-category ranking, subscription-change classification, upcoming-bill
 * reduction, budget status, month boundaries, and the summary text renderer.
 */

import { describe, it, expect } from 'vitest';
import {
    momDelta,
    monthBounds,
    normalizeMonth,
    rankTopCategories,
    classifySubscriptionChanges,
    summarizeUpcomingBills,
    computeBudgetStatus,
    digestToSummaryText,
    type MonthlyDigest,
} from '../digest';
import type { RecurringSeries } from '../recurring-detection';
import type { ForecastEvent } from '../forecast';

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

function mkSeries(overrides: Partial<RecurringSeries> = {}): RecurringSeries {
    return {
        merchantKey: 'spotify',
        merchantLabel: 'Spotify',
        cadence: 'monthly',
        medianIntervalDays: 30,
        occurrences: 6,
        currentAmount: 10.99,
        typicalAmount: 10.99,
        amountChangePct: 0,
        firstSeen: '2025-01-05',
        lastSeen: '2026-06-05',
        nextExpected: '2026-07-05',
        status: 'active',
        monthlyEquivalent: 10.99,
        accountGuid: 'acct-music',
        accountName: 'Expenses:Subscriptions',
        ...overrides,
    };
}

function mkEvent(overrides: Partial<ForecastEvent> = {}): ForecastEvent {
    return {
        date: '2026-07-15',
        accountGuid: 'acct-checking',
        accountName: 'Checking',
        amount: -100,
        description: 'Rent',
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/* momDelta                                                            */
/* ------------------------------------------------------------------ */

describe('momDelta', () => {
    it('computes delta and percent against a positive base', () => {
        expect(momDelta(120, 100)).toEqual({ delta: 20, percent: 20 });
        expect(momDelta(80, 100)).toEqual({ delta: -20, percent: -20 });
    });

    it('uses the magnitude of the base so sign follows the delta', () => {
        // Net worth can move from a negative base; percent sign tracks delta.
        expect(momDelta(-50, -100)).toEqual({ delta: 50, percent: 50 });
    });

    it('returns 0 percent when the prior value is 0', () => {
        expect(momDelta(500, 0)).toEqual({ delta: 500, percent: 0 });
        expect(momDelta(0, 0)).toEqual({ delta: 0, percent: 0 });
    });

    it('rounds to 2 decimals', () => {
        const r = momDelta(10.005, 3.334);
        expect(r.delta).toBeCloseTo(6.67, 5);
    });
});

/* ------------------------------------------------------------------ */
/* normalizeMonth + monthBounds                                        */
/* ------------------------------------------------------------------ */

describe('normalizeMonth', () => {
    it('passes through a valid YYYY-MM', () => {
        expect(normalizeMonth('2026-07')).toBe('2026-07');
    });

    it('defaults to the current UTC month when undefined', () => {
        const now = new Date();
        const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        expect(normalizeMonth()).toBe(expected);
    });

    it('rejects malformed or out-of-range months', () => {
        expect(() => normalizeMonth('2026-13')).toThrow();
        expect(() => normalizeMonth('2026-00')).toThrow();
        expect(() => normalizeMonth('26-7')).toThrow();
        expect(() => normalizeMonth('not-a-month')).toThrow();
    });
});

describe('monthBounds', () => {
    it('computes month and prior-month UTC boundaries', () => {
        const b = monthBounds('2026-07');
        expect(b.monthKeyStart).toBe('2026-07-01');
        expect(b.monthKeyEnd).toBe('2026-07-31');
        expect(b.monthStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
        expect(b.priorMonthStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
        expect(b.priorMonthEnd.toISOString()).toBe('2026-06-30T23:59:59.999Z');
        expect(b.label).toBe('July 2026');
        expect(b.year).toBe(2026);
        expect(b.monthNumber).toBe(7);
    });

    it('handles the January boundary (prior month is December of prior year)', () => {
        const b = monthBounds('2026-01');
        expect(b.monthKeyStart).toBe('2026-01-01');
        expect(b.monthKeyEnd).toBe('2026-01-31');
        expect(b.priorMonthStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
        expect(b.priorMonthEnd.toISOString()).toBe('2025-12-31T23:59:59.999Z');
    });

    it('computes February length correctly in a leap year', () => {
        const b = monthBounds('2024-02');
        expect(b.monthKeyEnd).toBe('2024-02-29');
    });
});

/* ------------------------------------------------------------------ */
/* rankTopCategories                                                   */
/* ------------------------------------------------------------------ */

describe('rankTopCategories', () => {
    it('ranks by current-month spend and attaches MoM deltas', () => {
        const current = { Food: 500, Auto: 300, Utilities: 200 };
        const prior = { Food: 400, Auto: 350, Utilities: 200 };
        const ranked = rankTopCategories(current, prior, 5);

        expect(ranked.map(c => c.name)).toEqual(['Food', 'Auto', 'Utilities']);
        expect(ranked[0]).toMatchObject({ amount: 500, priorAmount: 400, delta: 100, percent: 25 });
        expect(ranked[1]).toMatchObject({ amount: 300, priorAmount: 350, delta: -50 });
        expect(ranked[2]).toMatchObject({ delta: 0, percent: 0 });
    });

    it('limits the number of returned categories', () => {
        const current = { A: 5, B: 4, C: 3, D: 2, E: 1 };
        expect(rankTopCategories(current, {}, 3).map(c => c.name)).toEqual(['A', 'B', 'C']);
    });

    it('treats missing prior categories as 0 (new category)', () => {
        const ranked = rankTopCategories({ Streaming: 30 }, {}, 5);
        expect(ranked[0]).toMatchObject({ amount: 30, priorAmount: 0, delta: 30, percent: 0 });
    });

    it('accepts Map inputs and skips zero/negative rows', () => {
        const current = new Map([['Food', 100], ['Refund', 0]]);
        const ranked = rankTopCategories(current, new Map(), 5);
        expect(ranked.map(c => c.name)).toEqual(['Food']);
    });

    it('returns an empty list for an empty month', () => {
        expect(rankTopCategories({}, {}, 5)).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* classifySubscriptionChanges                                         */
/* ------------------------------------------------------------------ */

describe('classifySubscriptionChanges', () => {
    const monthOpts = { monthStart: '2026-07-01', monthEnd: '2026-07-31' };

    it('flags a subscription whose first charge landed this month as new', () => {
        const s = mkSeries({ merchantLabel: 'NewSaaS', firstSeen: '2026-07-03', lastSeen: '2026-07-03' });
        const result = classifySubscriptionChanges([s], monthOpts);
        expect(result.new.map(x => x.label)).toEqual(['NewSaaS']);
        expect(result.changed).toEqual([]);
        expect(result.stopped).toEqual([]);
    });

    it('flags a price increase charged this month as changed (direction up)', () => {
        const s = mkSeries({
            merchantLabel: 'Netflix',
            firstSeen: '2024-01-10',
            lastSeen: '2026-07-10',
            currentAmount: 17.99,
            typicalAmount: 15.49,
            amountChangePct: 16.1,
        });
        const result = classifySubscriptionChanges([s], monthOpts);
        expect(result.changed).toHaveLength(1);
        expect(result.changed[0]).toMatchObject({ label: 'Netflix', direction: 'up', currentAmount: 17.99 });
        expect(result.new).toEqual([]);
    });

    it('flags a price decrease as changed (direction down)', () => {
        const s = mkSeries({
            firstSeen: '2024-01-10',
            lastSeen: '2026-07-10',
            amountChangePct: -12,
        });
        const result = classifySubscriptionChanges([s], monthOpts);
        expect(result.changed[0].direction).toBe('down');
    });

    it('ignores sub-threshold price wobble', () => {
        const s = mkSeries({ firstSeen: '2024-01-10', lastSeen: '2026-07-10', amountChangePct: 2 });
        const result = classifySubscriptionChanges([s], monthOpts);
        expect(result.changed).toEqual([]);
    });

    it('flags an expected-but-missing renewal as stopped', () => {
        const s = mkSeries({
            merchantLabel: 'Gym',
            firstSeen: '2023-05-01',
            lastSeen: '2026-06-02', // last charge before the month
            nextExpected: '2026-07-02', // was due this month, never arrived
        });
        const result = classifySubscriptionChanges([s], monthOpts);
        expect(result.stopped.map(x => x.label)).toEqual(['Gym']);
    });

    it('leaves an unchanged mid-life subscription in no bucket', () => {
        const s = mkSeries({
            firstSeen: '2024-01-05',
            lastSeen: '2026-08-05',
            nextExpected: '2026-09-05',
            amountChangePct: 0,
        });
        const result = classifySubscriptionChanges([s], monthOpts);
        expect(result.new).toEqual([]);
        expect(result.changed).toEqual([]);
        expect(result.stopped).toEqual([]);
    });

    it('sorts each bucket by current amount descending', () => {
        const cheap = mkSeries({ merchantLabel: 'Cheap', firstSeen: '2026-07-01', lastSeen: '2026-07-01', currentAmount: 3 });
        const pricey = mkSeries({ merchantLabel: 'Pricey', firstSeen: '2026-07-02', lastSeen: '2026-07-02', currentAmount: 30 });
        const result = classifySubscriptionChanges([cheap, pricey], monthOpts);
        expect(result.new.map(x => x.label)).toEqual(['Pricey', 'Cheap']);
    });

    it('returns empty buckets for an empty input', () => {
        expect(classifySubscriptionChanges([], monthOpts)).toEqual({ new: [], changed: [], stopped: [] });
    });
});

/* ------------------------------------------------------------------ */
/* summarizeUpcomingBills                                              */
/* ------------------------------------------------------------------ */

describe('summarizeUpcomingBills', () => {
    it('keeps only outflows, sorted by date then size', () => {
        const events = [
            mkEvent({ date: '2026-07-20', amount: -50, description: 'Internet' }),
            mkEvent({ date: '2026-07-10', amount: 2000, description: 'Paycheck' }), // inflow, dropped
            mkEvent({ date: '2026-07-10', amount: -1200, description: 'Rent' }),
            mkEvent({ date: '2026-07-10', amount: -80, description: 'Phone' }),
        ];
        const bills = summarizeUpcomingBills(events);
        expect(bills.map(b => b.description)).toEqual(['Rent', 'Phone', 'Internet']);
        expect(bills.every(b => b.amount < 0)).toBe(true);
    });

    it('respects the limit', () => {
        const events = Array.from({ length: 10 }, (_, i) =>
            mkEvent({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, amount: -(i + 1) })
        );
        expect(summarizeUpcomingBills(events, 3)).toHaveLength(3);
    });

    it('returns an empty list when there are no outflows', () => {
        expect(summarizeUpcomingBills([mkEvent({ amount: 100 })])).toEqual([]);
        expect(summarizeUpcomingBills([])).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* computeBudgetStatus                                                 */
/* ------------------------------------------------------------------ */

describe('computeBudgetStatus', () => {
    const budgeted = [
        { accountGuid: 'g-food', accountName: 'Food', amount: 400 },
        { accountGuid: 'g-auto', accountName: 'Auto', amount: 200 },
        { accountGuid: 'g-fun', accountName: 'Fun', amount: 100 },
    ];

    it('classifies over / under / on_track and sorts most-over first', () => {
        const actual = new Map([
            ['g-food', 520], // over by 120
            ['g-auto', 150], // under by 50
            ['g-fun', 100], // on track
        ]);
        const rows = computeBudgetStatus(budgeted, actual);

        // Sorted by variance ascending (most over first): Food -120, Fun 0, Auto 50.
        expect(rows.map(r => r.accountName)).toEqual(['Food', 'Fun', 'Auto']);
        expect(rows[0]).toMatchObject({ status: 'over', variance: -120 });
        expect(rows[2]).toMatchObject({ status: 'under', variance: 50 });
        const fun = rows.find(r => r.accountName === 'Fun');
        expect(fun).toMatchObject({ status: 'on_track', variance: 0 });
    });

    it('treats a missing actual as 0 spend (fully under)', () => {
        const rows = computeBudgetStatus(budgeted, {});
        expect(rows.every(r => r.status === 'under')).toBe(true);
    });

    it('returns an empty list when there are no budget lines', () => {
        expect(computeBudgetStatus([], new Map())).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* digestToSummaryText                                                 */
/* ------------------------------------------------------------------ */

function mkDigest(overrides: Partial<MonthlyDigest> = {}): MonthlyDigest {
    return {
        month: '2026-07',
        monthLabel: 'July 2026',
        generatedAt: '2026-07-08T00:00:00.000Z',
        currency: 'USD',
        netWorth: { end: 250000, change: 5000, changePercent: 2.04 },
        cashFlow: { income: 8000, expenses: 5200, savingsRate: 35 },
        topCategories: [
            { name: 'Food', amount: 900, priorAmount: 800, delta: 100, percent: 12.5 },
            { name: 'Auto', amount: 400, priorAmount: 500, delta: -100, percent: -20 },
        ],
        subscriptions: {
            new: [
                {
                    label: 'NewSaaS',
                    accountName: 'Expenses:Subscriptions',
                    cadence: 'monthly',
                    currentAmount: 12,
                    previousAmount: 12,
                    changePercent: 0,
                    lastSeen: '2026-07-03',
                    nextExpected: '2026-08-03',
                },
            ],
            changed: [
                {
                    label: 'Netflix',
                    accountName: 'Expenses:Subscriptions',
                    cadence: 'monthly',
                    currentAmount: 17.99,
                    previousAmount: 15.49,
                    changePercent: 16.1,
                    direction: 'up',
                    lastSeen: '2026-07-10',
                    nextExpected: '2026-08-10',
                },
            ],
            stopped: [],
        },
        upcomingBills: [
            { date: '2026-07-15', description: 'Rent', accountName: 'Checking', amount: -1200 },
            { date: '2026-07-20', description: 'Internet', accountName: 'Checking', amount: -80 },
        ],
        budget: {
            budgetName: '2026 Budget',
            periodNum: 6,
            outOfRange: false,
            totalBudgeted: 5000,
            totalActual: 5200,
            rows: [
                { accountGuid: 'g-food', accountName: 'Food', budgeted: 800, actual: 900, variance: -100, status: 'over' },
                { accountGuid: 'g-auto', accountName: 'Auto', budgeted: 500, actual: 400, variance: 100, status: 'under' },
            ],
        },
        ...overrides,
    };
}

describe('digestToSummaryText', () => {
    it('renders a markdown summary with the headline sections', () => {
        const text = digestToSummaryText(mkDigest());
        expect(text).toContain('## Monthly Financial Digest — July 2026');
        expect(text).toContain('**Net worth:**');
        expect(text).toContain('▲');
        expect(text).toContain('+2.0% vs prior month');
        expect(text).toContain('**Savings rate:** 35.0%');
        expect(text).toContain('**Top categories**');
        expect(text).toContain('- Food:');
        expect(text).toContain('**Subscriptions:** 1 new, 1 changed, 0 stopped');
        expect(text).toContain('Netflix price up');
        expect(text).toContain('**Upcoming bills (next 30 days):** 2');
        expect(text).toContain('**Budget (2026 Budget):** over on 1, under on 1');
    });

    it('uses a down arrow for a net-worth decline', () => {
        const text = digestToSummaryText(
            mkDigest({ netWorth: { end: 100, change: -2000, changePercent: -5 } })
        );
        expect(text).toContain('▼');
        expect(text).toContain('-5.0% vs prior month');
    });

    it('omits optional sections for an empty month', () => {
        const text = digestToSummaryText(
            mkDigest({
                topCategories: [],
                subscriptions: { new: [], changed: [], stopped: [] },
                upcomingBills: [],
                budget: null,
            })
        );
        expect(text).toContain('## Monthly Financial Digest');
        expect(text).not.toContain('**Top categories**');
        expect(text).not.toContain('**Subscriptions:**');
        expect(text).not.toContain('**Upcoming bills');
        expect(text).not.toContain('**Budget');
    });
});
