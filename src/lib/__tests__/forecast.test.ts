/**
 * Cash Flow Forecast engine tests (pure projection math — no DB).
 */

import { describe, it, expect } from 'vitest';
import {
    computeForecast,
    computeDailyRunRates,
    expandScheduledEvents,
    toDateKey,
    parseLocalDate,
    COMBINED_GUID,
    type ForecastAccount,
    type ForecastEvent,
    type ScheduledTxLike,
} from '../forecast';

const START = new Date(2026, 6, 8); // Jul 8, 2026 (local)

function mkAccount(overrides: Partial<ForecastAccount> = {}): ForecastAccount {
    return {
        guid: 'acct-checking',
        name: 'Checking',
        currentBalance: 1000,
        ...overrides,
    };
}

function mkEvent(overrides: Partial<ForecastEvent> = {}): ForecastEvent {
    return {
        date: '2026-07-10',
        accountGuid: 'acct-checking',
        accountName: 'Checking',
        amount: -200,
        description: 'Rent',
        ...overrides,
    };
}

describe('computeDailyRunRates', () => {
    it('averages summed flows per account over the lookback window', () => {
        const rates = computeDailyRunRates(
            [
                { accountGuid: 'a', amount: -450 },
                { accountGuid: 'a', amount: -450 },
                { accountGuid: 'b', amount: 90 },
            ],
            90
        );
        expect(rates['a']).toBeCloseTo(-10, 10);
        expect(rates['b']).toBeCloseTo(1, 10);
    });

    it('returns empty rates for empty flows or non-positive lookback', () => {
        expect(computeDailyRunRates([], 90)).toEqual({});
        expect(computeDailyRunRates([{ accountGuid: 'a', amount: 100 }], 0)).toEqual({});
    });
});

describe('computeForecast — balance accumulation', () => {
    it('applies the daily run rate every day after day 0', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 100 })],
            events: [],
            runRates: { 'acct-checking': -10 },
            horizonDays: 5,
            startDate: START,
        });

        expect(result.series).toHaveLength(6); // day 0 + 5 days
        expect(result.series[0].combined).toBe(100);      // no run rate on day 0
        expect(result.series[1].combined).toBe(90);
        expect(result.series[5].combined).toBe(50);
        expect(result.accounts[0].endingBalance).toBe(50);
        expect(result.accounts[0].startingBalance).toBe(100);
        expect(result.accounts[0].dailyRunRate).toBe(-10);
    });

    it('combines multiple accounts into a combined series', () => {
        const result = computeForecast({
            accounts: [
                mkAccount({ guid: 'a', name: 'A', currentBalance: 100 }),
                mkAccount({ guid: 'b', name: 'B', currentBalance: 50 }),
            ],
            events: [],
            runRates: { a: 1, b: 2 },
            horizonDays: 3,
            startDate: START,
        });

        expect(result.series[0].combined).toBe(150);
        expect(result.series[3].combined).toBe(150 + 3 * 3);
        expect(result.series[3].balances['a']).toBe(103);
        expect(result.series[3].balances['b']).toBe(56);
    });

    it('handles accounts with no run rate entry (treated as 0)', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 500 })],
            events: [],
            runRates: {},
            horizonDays: 30,
            startDate: START,
        });
        expect(result.series[30].combined).toBe(500);
    });
});

describe('computeForecast — scheduled events', () => {
    it('applies events on exactly the right dates', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 1000 })],
            events: [
                mkEvent({ date: '2026-07-10', amount: -200 }),
                mkEvent({ date: '2026-07-12', amount: 300, description: 'Paycheck' }),
            ],
            runRates: {},
            horizonDays: 10,
            startDate: START,
        });

        const byDate = new Map(result.series.map(p => [p.date, p.combined]));
        expect(byDate.get('2026-07-09')).toBe(1000);
        expect(byDate.get('2026-07-10')).toBe(800);   // rent applied
        expect(byDate.get('2026-07-11')).toBe(800);
        expect(byDate.get('2026-07-12')).toBe(1100);  // paycheck applied
        expect(result.events).toHaveLength(2);
    });

    it('applies day-0 events to the starting snapshot', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 100 })],
            events: [mkEvent({ date: toDateKey(START), amount: -40 })],
            runRates: {},
            horizonDays: 2,
            startDate: START,
        });
        expect(result.series[0].combined).toBe(60);
    });

    it('ignores events outside the horizon or for unselected accounts', () => {
        const result = computeForecast({
            accounts: [mkAccount()],
            events: [
                mkEvent({ date: '2026-08-30', amount: -999 }),               // beyond 10-day horizon
                mkEvent({ date: '2026-07-01', amount: -999 }),               // in the past
                mkEvent({ date: '2026-07-10', accountGuid: 'other', amount: -999 }), // other account
            ],
            runRates: {},
            horizonDays: 10,
            startDate: START,
        });
        expect(result.events).toHaveLength(0);
        expect(result.series[10].combined).toBe(1000);
    });

    it('combines run rate and events on the same day', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 100 })],
            events: [mkEvent({ date: '2026-07-09', amount: -50 })],
            runRates: { 'acct-checking': -5 },
            horizonDays: 2,
            startDate: START,
        });
        // day1 = 100 - 5 (rate) - 50 (event) = 45; day2 = 40
        expect(result.series[1].combined).toBe(45);
        expect(result.series[2].combined).toBe(40);
    });
});

describe('computeForecast — threshold warnings', () => {
    it('detects the date a balance crosses below zero', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 25 })],
            events: [],
            runRates: { 'acct-checking': -10 },
            horizonDays: 5,
            startDate: START,
        });

        // 25, 15, 5, -5 → crosses below 0 on day 3 (Jul 11)
        const accountWarnings = result.warnings.filter(w => w.accountGuid === 'acct-checking');
        expect(accountWarnings).toHaveLength(1);
        expect(accountWarnings[0].date).toBe('2026-07-11');
        expect(accountWarnings[0].projectedBalance).toBe(-5);
        expect(accountWarnings[0].accountName).toBe('Checking');
        expect(accountWarnings[0].alreadyBelow).toBe(false);
    });

    it('respects a custom threshold', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 500 })],
            events: [],
            runRates: { 'acct-checking': -100 },
            horizonDays: 5,
            threshold: 250,
            startDate: START,
        });

        const accountWarnings = result.warnings.filter(w => w.accountGuid === 'acct-checking');
        // 500, 400, 300, 200 → below 250 on day 3
        expect(accountWarnings[0].date).toBe('2026-07-11');
        expect(accountWarnings[0].threshold).toBe(250);
    });

    it('reports each downward crossing when the balance recovers and dips again', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 10 })],
            events: [
                mkEvent({ date: '2026-07-09', amount: -20 }),  // dip 1: -10
                mkEvent({ date: '2026-07-10', amount: 100 }),  // recover: 90
                mkEvent({ date: '2026-07-12', amount: -100 }), // dip 2: -10
            ],
            runRates: {},
            horizonDays: 6,
            startDate: START,
        });

        const accountWarnings = result.warnings.filter(w => w.accountGuid === 'acct-checking');
        expect(accountWarnings.map(w => w.date)).toEqual(['2026-07-09', '2026-07-12']);
    });

    it('flags accounts already below the threshold on day 0', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: -100 })],
            events: [],
            runRates: {},
            horizonDays: 3,
            startDate: START,
        });

        const warning = result.warnings.find(w => w.accountGuid === 'acct-checking');
        expect(warning).toBeDefined();
        expect(warning!.date).toBe(toDateKey(START));
        expect(warning!.alreadyBelow).toBe(true);
    });

    it('emits a combined-total warning when the sum crosses below the threshold', () => {
        const result = computeForecast({
            accounts: [
                mkAccount({ guid: 'a', name: 'A', currentBalance: 50 }),
                mkAccount({ guid: 'b', name: 'B', currentBalance: 10 }),
            ],
            events: [],
            runRates: { a: -30 },
            horizonDays: 4,
            startDate: START,
        });

        // combined: 60, 30, 0, -30 → account 'a' goes below on day 2 (-10),
        // combined goes below on day 3 (-30)
        const combined = result.warnings.filter(w => w.accountGuid === COMBINED_GUID);
        expect(combined).toHaveLength(1);
        expect(combined[0].date).toBe('2026-07-11');
        expect(combined[0].projectedBalance).toBe(-30);
    });

    it('produces no warnings when balances stay above the threshold', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 10000 })],
            events: [mkEvent({ amount: -100 })],
            runRates: { 'acct-checking': -5 },
            horizonDays: 30,
            startDate: START,
        });
        expect(result.warnings).toHaveLength(0);
    });

    // Regression: ISSUE-001 — credit-card accounts flooded the warnings panel
    // ("already below $0.00" for every carried card balance).
    // Found by /qa on 2026-07-08
    // Report: .gstack/qa-reports/qa-report-gnucash-web-2026-07-08.md
    it('skips per-account warnings for excludeFromWarnings accounts but keeps them in the combined total', () => {
        const result = computeForecast({
            accounts: [
                mkAccount({ currentBalance: 500 }),
                mkAccount({
                    guid: 'acct-card',
                    name: 'Credit Card',
                    currentBalance: -4460,
                    excludeFromWarnings: true,
                }),
            ],
            events: [],
            runRates: {},
            horizonDays: 10,
            startDate: START,
        });

        // No warning for the credit card itself, even though it is below 0
        expect(result.warnings.filter(w => w.accountGuid === 'acct-card')).toHaveLength(0);
        // Checking stays above 0 — no warning for it either
        expect(result.warnings.filter(w => w.accountGuid === 'acct-checking')).toHaveLength(0);
        // Combined total (500 - 4460 < 0) still warns: net cash position is real
        const combined = result.warnings.filter(w => w.accountGuid === COMBINED_GUID);
        expect(combined).toHaveLength(1);
        expect(combined[0].alreadyBelow).toBe(true);
        // The card is still projected in the series
        expect(result.series[0].balances['acct-card']).toBe(-4460);
    });
});

describe('computeForecast — empty inputs', () => {
    it('handles no accounts, events, or run rates', () => {
        const result = computeForecast({
            accounts: [],
            events: [],
            runRates: {},
            horizonDays: 30,
            startDate: START,
        });

        expect(result.series).toHaveLength(31);
        expect(result.series[0].combined).toBe(0);
        expect(result.series[30].combined).toBe(0);
        expect(result.events).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
        expect(result.accounts).toHaveLength(0);
    });

    it('handles a zero-day horizon (single snapshot)', () => {
        const result = computeForecast({
            accounts: [mkAccount({ currentBalance: 42 })],
            events: [],
            runRates: { 'acct-checking': -100 },
            horizonDays: 0,
            startDate: START,
        });
        expect(result.series).toHaveLength(1);
        expect(result.series[0].combined).toBe(42);
    });
});

describe('expandScheduledEvents', () => {
    function mkSx(overrides: Partial<ScheduledTxLike> = {}): ScheduledTxLike {
        return {
            guid: 'sx-1',
            name: 'Mortgage',
            lastOccur: '2026-07-01',
            endDate: null,
            remainingOccurrences: -1,
            recurrence: {
                periodType: 'month',
                mult: 1,
                periodStart: '2025-01-01',
                weekendAdjust: 'none',
            },
            splits: [
                { accountGuid: 'acct-checking', accountName: 'Checking', amount: -1500 },
                { accountGuid: 'acct-mortgage', accountName: 'Mortgage Loan', amount: 1500 },
            ],
            ...overrides,
        };
    }

    it('expands monthly occurrences within the horizon for selected accounts only', () => {
        const events = expandScheduledEvents(
            [mkSx()],
            new Set(['acct-checking']),
            START,
            90
        );

        // lastOccur Jul 1 → next Aug 1, Sep 1, Oct 1 (within Jul 8 + 90d = Oct 6)
        expect(events.map(e => e.date)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
        expect(events.every(e => e.accountGuid === 'acct-checking')).toBe(true);
        expect(events.every(e => e.amount === -1500)).toBe(true);
        expect(events[0].description).toBe('Mortgage');
    });

    it('skips scheduled transactions with no splits on selected accounts', () => {
        const events = expandScheduledEvents(
            [mkSx()],
            new Set(['acct-savings']),
            START,
            90
        );
        expect(events).toHaveLength(0);
    });

    it('respects the scheduled transaction end date and exhausted occurrences', () => {
        const ended = mkSx({ endDate: '2026-08-15' });
        const exhausted = mkSx({ guid: 'sx-2', name: 'Old', remainingOccurrences: 0 });

        const events = expandScheduledEvents(
            [ended, exhausted],
            new Set(['acct-checking']),
            START,
            180
        );

        expect(events.map(e => e.date)).toEqual(['2026-08-01']);
    });

    it('returns nothing for scheduled transactions without recurrence', () => {
        const events = expandScheduledEvents(
            [mkSx({ recurrence: null })],
            new Set(['acct-checking']),
            START,
            90
        );
        expect(events).toHaveLength(0);
    });
});

describe('date helpers', () => {
    it('round-trips local dates without UTC drift', () => {
        expect(toDateKey(parseLocalDate('2026-07-08'))).toBe('2026-07-08');
        expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    });
});
