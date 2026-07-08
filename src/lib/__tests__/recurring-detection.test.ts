import { describe, it, expect, vi } from 'vitest';

// recurring-detection imports the prisma singleton for its DB loader; mock it
// so the pure detection core can be tested without a database.
vi.mock('@/lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}));

import {
    normalizeMerchant,
    detectRecurringSeries,
    type SpendingTransaction,
} from '../recurring-detection';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const NOW = new Date('2026-07-01T00:00:00Z');

function tx(
    date: string,
    description: string,
    amount: number,
    account = 'Expenses:Subscriptions',
): SpendingTransaction {
    return {
        date: new Date(date + 'T12:00:00Z'),
        description,
        amount,
        accountGuid: 'guid-' + account,
        accountName: account,
    };
}

/** Generate a charge on the same day-of-month for `count` months. */
function monthlySeries(
    description: string,
    amount: number,
    startYear: number,
    startMonth: number, // 1-based
    day: number,
    count: number,
    account = 'Expenses:Subscriptions',
): SpendingTransaction[] {
    const out: SpendingTransaction[] = [];
    for (let i = 0; i < count; i++) {
        const d = new Date(Date.UTC(startYear, startMonth - 1 + i, day, 12));
        out.push({
            date: d,
            description,
            amount,
            accountGuid: 'guid-' + account,
            accountName: account,
        });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                        */
/* ------------------------------------------------------------------ */

describe('normalizeMerchant', () => {
    it('lowercases and strips punctuation', () => {
        expect(normalizeMerchant('NETFLIX.COM')).toBe('netflix com');
    });

    it('strips store numbers and phone numbers', () => {
        expect(normalizeMerchant('Spotify USA #12345')).toBe('spotify usa');
        expect(normalizeMerchant('NETFLIX.COM 866-579-7172')).toBe('netflix com');
    });

    it('drops trailing reference codes containing digits', () => {
        expect(normalizeMerchant('AMZN Mktp US*2H4KL9012')).toBe('amzn mktp us');
        expect(normalizeMerchant('AMZN Mktp US*9Z3AB1234')).toBe('amzn mktp us');
    });

    it('returns empty string for all-numeric descriptions', () => {
        expect(normalizeMerchant('123456 7890')).toBe('');
    });

    it('produces the same key for varying store numbers', () => {
        expect(normalizeMerchant('COSTCO WHSE #0482')).toBe(
            normalizeMerchant('COSTCO WHSE #1191'),
        );
    });
});

/* ------------------------------------------------------------------ */
/* Detection                                                            */
/* ------------------------------------------------------------------ */

describe('detectRecurringSeries', () => {
    it('detects a monthly subscription', () => {
        const txns = monthlySeries('NETFLIX.COM', 15.49, 2025, 1, 15, 18);
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(1);
        const s = result.series[0];
        expect(s.cadence).toBe('monthly');
        expect(s.merchantKey).toBe('netflix com');
        expect(s.merchantLabel).toBe('NETFLIX.COM');
        expect(s.occurrences).toBe(18);
        expect(s.currentAmount).toBeCloseTo(15.49, 2);
        expect(s.typicalAmount).toBeCloseTo(15.49, 2);
        expect(s.amountChangePct).toBeCloseTo(0, 5);
        expect(s.status).toBe('active');
        expect(s.firstSeen).toBe('2025-01-15');
        expect(s.lastSeen).toBe('2026-06-15');
        // Last charge 2026-06-15 + ~monthly interval => mid-July
        expect(s.nextExpected.startsWith('2026-07-1')).toBe(true);
        expect(s.monthlyEquivalent).toBeCloseTo(15.49, 2);
        expect(s.accountName).toBe('Expenses:Subscriptions');
    });

    it('detects a weekly charge and normalizes it to per-month', () => {
        const txns: SpendingTransaction[] = [];
        // Every 7 days, 12 occurrences ending 2026-06-26
        for (let i = 0; i < 12; i++) {
            const d = new Date(Date.UTC(2026, 3, 10 + i * 7, 12)); // from 2026-04-10
            txns.push({
                date: d,
                description: 'BLUE APRON WEEKLY',
                amount: 25,
                accountGuid: 'guid-food',
                accountName: 'Expenses:Food',
            });
        }
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(1);
        const s = result.series[0];
        expect(s.cadence).toBe('weekly');
        expect(s.medianIntervalDays).toBe(7);
        // 25/week ~= 108.70/month (365.25 / 7 / 12 weeks per month)
        expect(s.monthlyEquivalent).toBeCloseTo(25 * (365.25 / 7 / 12), 2);
    });

    it('detects an annual subscription', () => {
        const txns = [
            tx('2024-06-10', 'AMAZON PRIME MEMBERSHIP', 99),
            tx('2025-06-10', 'AMAZON PRIME MEMBERSHIP', 99),
            tx('2026-06-10', 'AMAZON PRIME MEMBERSHIP', 99),
        ];
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(1);
        const s = result.series[0];
        expect(s.cadence).toBe('annual');
        expect(s.status).toBe('active');
        expect(s.monthlyEquivalent).toBeCloseTo(99 / 12, 2);
        expect(s.nextExpected.startsWith('2027-06')).toBe(true);
    });

    it('does not flag irregular spending with no cadence', () => {
        // Grocery-style random intervals: 3, 12, 5, 20, 9, 16 days
        const dates = ['2026-01-05', '2026-01-08', '2026-01-20', '2026-01-25', '2026-02-14', '2026-02-23', '2026-03-11'];
        const txns = dates.map(d => tx(d, 'KROGER', 80));
        const result = detectRecurringSeries(txns, { now: NOW });
        expect(result.series).toHaveLength(0);
    });

    it('does not flag spending whose median interval fits a band but is inconsistent', () => {
        // Intervals: 8, 30, 55, 90, 14 -> median 30 (monthly band) but MAD is huge
        const dates = ['2025-06-01', '2025-06-09', '2025-07-09', '2025-09-02', '2025-12-01', '2025-12-15'];
        const txns = dates.map(d => tx(d, 'HOME DEPOT', 120));
        const result = detectRecurringSeries(txns, { now: NOW });
        expect(result.series).toHaveLength(0);
    });

    it('flags a stopped subscription past the grace window', () => {
        // Monthly gym membership, last charged 2026-01-05, now = 2026-07-01
        const txns = monthlySeries('PLANET FITNESS', 24.99, 2025, 6, 5, 8); // Jun 2025 - Jan 2026
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(1);
        const s = result.series[0];
        expect(s.lastSeen).toBe('2026-01-05');
        expect(s.status).toBe('stopped');
        // Stopped series are excluded from active totals
        expect(result.totals.activeCount).toBe(0);
        expect(result.totals.activeMonthlyTotal).toBe(0);
        expect(result.totals.totalSeries).toBe(1);
    });

    it('marks a recently started series as new', () => {
        const txns = monthlySeries('HULU', 17.99, 2026, 5, 1, 3); // May, Jun, Jul 1 2026
        const result = detectRecurringSeries(txns, { now: new Date('2026-07-02T00:00:00Z') });

        expect(result.series).toHaveLength(1);
        expect(result.series[0].status).toBe('new');
        // 'new' still counts toward active totals
        expect(result.totals.activeCount).toBe(1);
    });

    it('computes a price increase from typical to current amount', () => {
        const txns = [
            ...monthlySeries('SPOTIFY USA', 9.99, 2025, 12, 20, 6), // Dec 2025 - May 2026
            tx('2026-06-20', 'SPOTIFY USA', 12.99),
        ];
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(1);
        const s = result.series[0];
        expect(s.currentAmount).toBeCloseTo(12.99, 2);
        expect(s.typicalAmount).toBeCloseTo(9.99, 2);
        expect(s.amountChangePct).toBeCloseTo(30.03, 1);
        expect(result.totals.priceIncreaseCount).toBe(1);
    });

    it('groups charges with varying reference numbers into one series', () => {
        const txns = [
            tx('2026-01-03', 'Spotify USA #10001', 9.99),
            tx('2026-02-03', 'Spotify USA #10944', 9.99),
            tx('2026-03-03', 'Spotify USA #11724', 9.99),
            tx('2026-04-03', 'Spotify USA #12490', 9.99),
            tx('2026-05-03', 'Spotify USA #13358', 9.99),
            tx('2026-06-03', 'Spotify USA #14105', 9.99),
        ];
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(1);
        expect(result.series[0].merchantKey).toBe('spotify usa');
        expect(result.series[0].occurrences).toBe(6);
    });

    it('requires the configured minimum occurrences', () => {
        const txns = monthlySeries('NETFLIX.COM', 15.49, 2026, 4, 15, 2); // only 2 charges
        const result = detectRecurringSeries(txns, { now: NOW, minOccurrences: 3 });
        expect(result.series).toHaveLength(0);
    });

    it('ignores refunds and non-positive amounts', () => {
        const txns = [
            ...monthlySeries('NETFLIX.COM', 15.49, 2026, 1, 15, 6),
            tx('2026-03-20', 'NETFLIX.COM', -15.49),
        ];
        const result = detectRecurringSeries(txns, { now: NOW });
        expect(result.series).toHaveLength(1);
        expect(result.series[0].occurrences).toBe(6);
    });

    it('merges same-day charges into a single occurrence', () => {
        const txns = [
            ...monthlySeries('ADOBE CREATIVE CLOUD', 29.99, 2026, 1, 10, 6),
            tx('2026-03-10', 'ADOBE CREATIVE CLOUD', 10.0), // second split same day
        ];
        const result = detectRecurringSeries(txns, { now: NOW });
        expect(result.series).toHaveLength(1);
        expect(result.series[0].occurrences).toBe(6);
    });

    it('computes active totals across multiple series', () => {
        const txns = [
            ...monthlySeries('NETFLIX.COM', 15, 2026, 1, 15, 6),
            ...monthlySeries('SPOTIFY USA', 10, 2026, 1, 20, 6),
        ];
        const result = detectRecurringSeries(txns, { now: NOW });

        expect(result.series).toHaveLength(2);
        expect(result.totals.activeCount).toBe(2);
        expect(result.totals.activeMonthlyTotal).toBeCloseTo(25, 2);
        expect(result.totals.activeAnnualTotal).toBeCloseTo(300, 2);
        // Sorted by monthly cost, most expensive first
        expect(result.series[0].merchantKey).toBe('netflix com');
    });
});
