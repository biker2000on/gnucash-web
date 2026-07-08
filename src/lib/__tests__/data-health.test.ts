/**
 * Data Health — pure-logic tests
 *
 * Exercises the database-free pieces of `data-health.ts`:
 *   - multi-currency unbalanced detection
 *   - health-score weighting and clamping
 *   - staleness / aging threshold helpers
 */

import { describe, it, expect } from 'vitest';
import {
    detectUnbalancedTransactions,
    computeHealthScore,
    scoreGrade,
    isOlderThan,
    daysBetween,
    cutoffDate,
    SEVERITY_WEIGHT,
    type RawSplitForBalance,
    type Severity,
} from '../data-health';

/* ------------------------------------------------------------------ */
/* Unbalanced detection                                                 */
/* ------------------------------------------------------------------ */

describe('detectUnbalancedTransactions', () => {
    it('treats a single-currency balanced transaction as balanced', () => {
        const splits: RawSplitForBalance[] = [
            { txGuid: 't1', currency: 'USD', valueNum: 10000n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: -10000n, valueDenom: 100n },
        ];
        expect(detectUnbalancedTransactions(splits)).toEqual([]);
    });

    it('flags a single-currency transaction that does not net to zero', () => {
        const splits: RawSplitForBalance[] = [
            { txGuid: 't1', currency: 'USD', valueNum: 10000n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: -9900n, valueDenom: 100n },
        ];
        const result = detectUnbalancedTransactions(splits);
        expect(result).toHaveLength(1);
        expect(result[0].txGuid).toBe('t1');
        expect(result[0].imbalances[0].currency).toBe('USD');
        expect(result[0].imbalances[0].sum).toBeCloseTo(1, 6);
    });

    it('treats a multi-currency transaction as balanced when each currency nets to zero', () => {
        // A cross-currency transfer: USD leg nets to zero, EUR leg nets to zero.
        const splits: RawSplitForBalance[] = [
            { txGuid: 't1', currency: 'USD', valueNum: 10000n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: -10000n, valueDenom: 100n },
            { txGuid: 't1', currency: 'EUR', valueNum: 9200n, valueDenom: 100n },
            { txGuid: 't1', currency: 'EUR', valueNum: -9200n, valueDenom: 100n },
        ];
        expect(detectUnbalancedTransactions(splits)).toEqual([]);
    });

    it('flags a multi-currency transaction when one currency leg is off', () => {
        const splits: RawSplitForBalance[] = [
            { txGuid: 't1', currency: 'USD', valueNum: 10000n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: -10000n, valueDenom: 100n },
            { txGuid: 't1', currency: 'EUR', valueNum: 9200n, valueDenom: 100n },
            { txGuid: 't1', currency: 'EUR', valueNum: -9000n, valueDenom: 100n },
        ];
        const result = detectUnbalancedTransactions(splits);
        expect(result).toHaveLength(1);
        expect(result[0].imbalances).toHaveLength(1);
        expect(result[0].imbalances[0].currency).toBe('EUR');
        expect(result[0].imbalances[0].sum).toBeCloseTo(2, 6);
    });

    it('does not flip on sub-tolerance floating point noise', () => {
        // 0.1 + 0.1 + 0.1 - 0.3 is not exactly zero in IEEE-754, but the
        // residual is far below tolerance and must not flag the transaction.
        const splits: RawSplitForBalance[] = [
            { txGuid: 't1', currency: 'USD', valueNum: 10n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: 10n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: 10n, valueDenom: 100n },
            { txGuid: 't1', currency: 'USD', valueNum: -30n, valueDenom: 100n },
        ];
        expect(detectUnbalancedTransactions(splits)).toEqual([]);
    });

    it('separates imbalances by transaction', () => {
        const splits: RawSplitForBalance[] = [
            { txGuid: 't1', currency: 'USD', valueNum: 500n, valueDenom: 100n },
            { txGuid: 't2', currency: 'USD', valueNum: 100n, valueDenom: 100n },
            { txGuid: 't2', currency: 'USD', valueNum: -100n, valueDenom: 100n },
        ];
        const result = detectUnbalancedTransactions(splits);
        expect(result.map((r) => r.txGuid)).toEqual(['t1']);
    });

    it('returns nothing for an empty split set', () => {
        expect(detectUnbalancedTransactions([])).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* Health score                                                         */
/* ------------------------------------------------------------------ */

describe('computeHealthScore', () => {
    it('scores a clean book (all counts zero) at 100', () => {
        const checks = [
            { severity: 'error' as Severity, count: 0 },
            { severity: 'warning' as Severity, count: 0 },
            { severity: 'info' as Severity, count: 0 },
        ];
        expect(computeHealthScore(checks)).toBe(100);
    });

    it('scores an empty check list at 100', () => {
        expect(computeHealthScore([])).toBe(100);
    });

    it('subtracts the full severity weight for a single offending item', () => {
        // count === 1 → log10(1) === 0 → penalty === weight.
        expect(computeHealthScore([{ severity: 'error', count: 1 }])).toBe(100 - SEVERITY_WEIGHT.error);
        expect(computeHealthScore([{ severity: 'warning', count: 1 }])).toBe(100 - SEVERITY_WEIGHT.warning);
        expect(computeHealthScore([{ severity: 'info', count: 1 }])).toBe(100 - SEVERITY_WEIGHT.info);
    });

    it('penalizes errors more than warnings more than info at equal counts', () => {
        const err = computeHealthScore([{ severity: 'error', count: 5 }]);
        const warn = computeHealthScore([{ severity: 'warning', count: 5 }]);
        const info = computeHealthScore([{ severity: 'info', count: 5 }]);
        expect(err).toBeLessThan(warn);
        expect(warn).toBeLessThan(info);
    });

    it('is monotonic — more offending items never raise the score', () => {
        const few = computeHealthScore([{ severity: 'warning', count: 3 }]);
        const many = computeHealthScore([{ severity: 'warning', count: 300 }]);
        expect(many).toBeLessThanOrEqual(few);
    });

    it('applies a diminishing (log-scaled) penalty as counts grow', () => {
        // count 10 → penalty = weight * (1 + 1); count 100 → weight * (1 + 2).
        expect(computeHealthScore([{ severity: 'error', count: 10 }])).toBe(100 - SEVERITY_WEIGHT.error * 2);
        expect(computeHealthScore([{ severity: 'error', count: 100 }])).toBe(100 - SEVERITY_WEIGHT.error * 3);
    });

    it('clamps to a floor of zero when penalties are severe', () => {
        const checks = [
            { severity: 'error' as Severity, count: 100000 },
            { severity: 'error' as Severity, count: 100000 },
            { severity: 'error' as Severity, count: 100000 },
        ];
        expect(computeHealthScore(checks)).toBe(0);
    });

    it('ignores the ok severity entirely', () => {
        expect(computeHealthScore([{ severity: 'ok', count: 999 }])).toBe(100);
    });
});

describe('scoreGrade', () => {
    it('maps score bands to labels', () => {
        expect(scoreGrade(100)).toBe('Excellent');
        expect(scoreGrade(90)).toBe('Good');
        expect(scoreGrade(75)).toBe('Fair');
        expect(scoreGrade(60)).toBe('Needs attention');
        expect(scoreGrade(10)).toBe('Poor');
    });
});

/* ------------------------------------------------------------------ */
/* Threshold helpers                                                    */
/* ------------------------------------------------------------------ */

describe('daysBetween', () => {
    it('counts whole days between two dates', () => {
        const a = new Date('2026-07-08T00:00:00Z');
        const b = new Date('2026-07-01T00:00:00Z');
        expect(daysBetween(a, b)).toBe(7);
    });
});

describe('isOlderThan', () => {
    const asOf = new Date('2026-07-08T00:00:00Z');

    it('flags a date older than the threshold', () => {
        const eightDaysAgo = new Date('2026-06-30T00:00:00Z');
        expect(isOlderThan(eightDaysAgo, 7, asOf)).toBe(true);
    });

    it('does not flag a date within the threshold', () => {
        const fiveDaysAgo = new Date('2026-07-03T00:00:00Z');
        expect(isOlderThan(fiveDaysAgo, 7, asOf)).toBe(false);
    });

    it('treats exactly the threshold age as not-yet-stale', () => {
        const sevenDaysAgo = new Date('2026-07-01T00:00:00Z');
        expect(isOlderThan(sevenDaysAgo, 7, asOf)).toBe(false);
    });

    it('returns false for a null date (absence handled elsewhere)', () => {
        expect(isOlderThan(null, 7, asOf)).toBe(false);
    });

    it('accepts ISO string dates', () => {
        expect(isOlderThan('2026-06-01T00:00:00Z', 7, asOf)).toBe(true);
    });
});

describe('cutoffDate', () => {
    it('returns the date N days before the reference', () => {
        const asOf = new Date('2026-07-08T00:00:00Z');
        expect(cutoffDate(90, asOf).toISOString().slice(0, 10)).toBe('2026-04-09');
    });
});
