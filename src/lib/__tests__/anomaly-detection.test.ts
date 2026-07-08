import { describe, it, expect, vi } from 'vitest';

// anomaly-detection imports the prisma singleton for its DB loader and the
// notifications module (which imports redis); mock prisma so the pure detection
// core can be tested without a database or a live connection.
vi.mock('@/lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}));

import { normalizeMerchant } from '../recurring-detection';
import {
    detectAnomalies,
    anomalyDedupeKey,
    type AnomalyTransaction,
    type AnomalyType,
} from '../anomaly-detection';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const NOW = new Date('2026-07-01T00:00:00Z');

function tx(
    date: string,
    description: string,
    amount: number,
    account = 'Expenses:Shopping',
): AnomalyTransaction {
    return {
        date: new Date(date + 'T12:00:00Z'),
        normalizedMerchant: normalizeMerchant(description),
        originalDescription: description,
        amount,
        accountGuid: 'guid-' + account,
        accountName: account,
        txGuid: `tx-${description}-${date}-${amount}`,
    };
}

function typesOf(anomalies: { type: AnomalyType }[]): AnomalyType[] {
    return anomalies.map(a => a.type);
}

/* ------------------------------------------------------------------ */
/* (a) Duplicate charge window                                          */
/* ------------------------------------------------------------------ */

describe('duplicate charge detection', () => {
    it('flags the same merchant + amount within the window', () => {
        const txs = [
            tx('2026-06-10', 'Amazon Marketplace', 49.99),
            tx('2026-06-12', 'Amazon Marketplace', 49.99), // 2 days later, same amount
        ];
        const dupes = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'duplicate_charge');
        expect(dupes).toHaveLength(1);
        expect(dupes[0].amount).toBe(49.99);
        // both transactions are referenced
        expect(dupes[0].relatedRefs).toHaveLength(2);
    });

    it('does NOT flag when the two charges are outside the window', () => {
        const txs = [
            tx('2026-06-01', 'Amazon Marketplace', 49.99),
            tx('2026-06-12', 'Amazon Marketplace', 49.99), // 11 days later
        ];
        const dupes = detectAnomalies(txs, { now: NOW, duplicateWindowDays: 3 })
            .filter(a => a.type === 'duplicate_charge');
        expect(dupes).toHaveLength(0);
    });

    it('does NOT flag same-window charges with different amounts', () => {
        const txs = [
            tx('2026-06-10', 'Amazon Marketplace', 49.99),
            tx('2026-06-11', 'Amazon Marketplace', 12.50),
        ];
        const dupes = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'duplicate_charge');
        expect(dupes).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ */
/* (b) First-time merchant                                              */
/* ------------------------------------------------------------------ */

describe('first-time merchant detection', () => {
    it('flags a merchant whose first appearance is within the recent window', () => {
        const txs = [tx('2026-06-20', 'Sketchy New Store', 88.0)];
        const firsts = detectAnomalies(txs, { now: NOW, firstTimeWindowDays: 30 })
            .filter(a => a.type === 'first_time_merchant');
        expect(firsts).toHaveLength(1);
        expect(firsts[0].label).toContain('Sketchy New Store');
    });

    it('does NOT flag a merchant first seen before the recent window', () => {
        const txs = [
            tx('2026-01-05', 'Old Faithful Shop', 20.0),
            tx('2026-06-20', 'Old Faithful Shop', 22.0),
        ];
        const firsts = detectAnomalies(txs, { now: NOW, firstTimeWindowDays: 30 })
            .filter(a => a.type === 'first_time_merchant');
        expect(firsts).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ */
/* (c) Amount outlier                                                   */
/* ------------------------------------------------------------------ */

describe('amount outlier detection', () => {
    it('flags a charge far above a merchant history with enough samples', () => {
        const txs = [
            tx('2026-01-10', 'Shell Gas', 40),
            tx('2026-02-10', 'Shell Gas', 44),
            tx('2026-03-10', 'Shell Gas', 42),
            tx('2026-04-10', 'Shell Gas', 41),
            tx('2026-05-10', 'Shell Gas', 380), // outlier
        ];
        const outliers = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'amount_outlier');
        expect(outliers).toHaveLength(1);
        expect(outliers[0].amount).toBe(380);
        expect(outliers[0].context).toMatch(/×/); // e.g. "9.1× your typical ..."
    });

    it('does NOT flag an outlier without enough prior samples', () => {
        const txs = [
            tx('2026-03-10', 'Shell Gas', 40),
            tx('2026-04-10', 'Shell Gas', 44),
            tx('2026-05-10', 'Shell Gas', 380), // only 2 priors < minSamples 4
        ];
        const outliers = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'amount_outlier');
        expect(outliers).toHaveLength(0);
    });

    it('does NOT flag a modest charge within the normal range', () => {
        const txs = [
            tx('2026-01-10', 'Shell Gas', 40),
            tx('2026-02-10', 'Shell Gas', 44),
            tx('2026-03-10', 'Shell Gas', 42),
            tx('2026-04-10', 'Shell Gas', 41),
            tx('2026-05-10', 'Shell Gas', 46), // slightly high, not an outlier
        ];
        const outliers = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'amount_outlier');
        expect(outliers).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ */
/* (d) Category spike                                                   */
/* ------------------------------------------------------------------ */

describe('category spike detection', () => {
    it('flags a category whose current period spend jumps over its trailing average', () => {
        const cat = 'Expenses:Food:Dining';
        const txs = [
            // trailing periods ~ $500 each
            tx('2026-04-05', 'Diner A', 500, cat),
            tx('2026-05-05', 'Diner B', 500, cat),
            tx('2026-06-02', 'Diner C', 500, cat),
            // current period (within 30 days of NOW) ~ $1200
            tx('2026-06-20', 'Diner D', 600, cat),
            tx('2026-06-27', 'Diner E', 600, cat),
        ];
        const spikes = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'category_spike');
        expect(spikes).toHaveLength(1);
        expect(spikes[0].accountName).toBe(cat);
        expect(spikes[0].context).toMatch(/above your/);
    });

    it('does NOT flag a category with steady period-over-period spend', () => {
        const cat = 'Expenses:Utilities';
        const txs = [
            tx('2026-04-05', 'Power Co', 120, cat),
            tx('2026-05-05', 'Power Co', 120, cat),
            tx('2026-06-02', 'Power Co', 120, cat),
            tx('2026-06-25', 'Power Co', 125, cat),
        ];
        const spikes = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'category_spike');
        expect(spikes).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ */
/* Normalization grouping                                               */
/* ------------------------------------------------------------------ */

describe('merchant normalization grouping', () => {
    it('treats store numbers as the same merchant for duplicate detection', () => {
        // Different store numbers / ref codes should normalize to the same key,
        // so these count as a duplicate rather than two distinct merchants.
        const txs = [
            tx('2026-06-10', 'COSTCO WHOLESALE #1188', 75.0),
            tx('2026-06-11', 'COSTCO WHOLESALE #0421', 75.0),
        ];
        expect(txs[0].normalizedMerchant).toBe(txs[1].normalizedMerchant);
        const dupes = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'duplicate_charge');
        expect(dupes).toHaveLength(1);
    });
});

/* ------------------------------------------------------------------ */
/* No false positives on steady spend                                  */
/* ------------------------------------------------------------------ */

describe('steady spend produces no anomalies', () => {
    it('does not flag a consistent monthly subscription', () => {
        const cat = 'Expenses:Subscriptions';
        const txs = [
            tx('2025-09-15', 'Netflix', 15.49, cat),
            tx('2025-10-15', 'Netflix', 15.49, cat),
            tx('2025-11-15', 'Netflix', 15.49, cat),
            tx('2025-12-15', 'Netflix', 15.49, cat),
            tx('2026-01-15', 'Netflix', 15.49, cat),
            tx('2026-02-15', 'Netflix', 15.49, cat),
        ];
        // Use a NOW well after the last charge so nothing is "recent" either.
        const anomalies = detectAnomalies(txs, { now: new Date('2026-06-01T00:00:00Z') });
        const flagged = typesOf(anomalies);
        expect(flagged).not.toContain('duplicate_charge');
        expect(flagged).not.toContain('amount_outlier');
        expect(flagged).not.toContain('category_spike');
        expect(flagged).not.toContain('first_time_merchant');
    });
});

/* ------------------------------------------------------------------ */
/* Dedupe key stability                                                 */
/* ------------------------------------------------------------------ */

describe('dedupe key stability', () => {
    it('produces the same key for the same inputs', () => {
        const a = anomalyDedupeKey('duplicate_charge', 'amazon marketplace', '2026-06-12', 49.99);
        const b = anomalyDedupeKey('duplicate_charge', 'amazon marketplace', '2026-06-12', 49.99);
        expect(a).toBe(b);
    });

    it('produces different keys when any component changes', () => {
        const base = anomalyDedupeKey('duplicate_charge', 'amazon marketplace', '2026-06-12', 49.99);
        expect(anomalyDedupeKey('amount_outlier', 'amazon marketplace', '2026-06-12', 49.99)).not.toBe(base);
        expect(anomalyDedupeKey('duplicate_charge', 'target', '2026-06-12', 49.99)).not.toBe(base);
        expect(anomalyDedupeKey('duplicate_charge', 'amazon marketplace', '2026-06-13', 49.99)).not.toBe(base);
        expect(anomalyDedupeKey('duplicate_charge', 'amazon marketplace', '2026-06-12', 50.0)).not.toBe(base);
    });

    it('exposes a stable dedupeKey on detected anomalies', () => {
        const txs = [
            tx('2026-06-10', 'Amazon Marketplace', 49.99),
            tx('2026-06-12', 'Amazon Marketplace', 49.99),
        ];
        const first = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'duplicate_charge')[0];
        const second = detectAnomalies(txs, { now: NOW }).filter(a => a.type === 'duplicate_charge')[0];
        expect(first.dedupeKey).toBe(second.dedupeKey);
    });
});
