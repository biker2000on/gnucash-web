/**
 * `utcMonthKey` is the shared `YYYY-MM` bucket key. Six modules had grown a
 * private copy; the dashboard income/expense series now uses this one, and the
 * point of the test is the UTC reading — a local-time key silently reassigns
 * every 1st-of-the-month transaction for users west of Greenwich, because the
 * SQL rollups group by `date_trunc('month', post_date)` in UTC.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../prisma', () => ({ default: {} }));

const { utcMonthKey } = await import('../date-utils');

describe('utcMonthKey', () => {
    it('zero-pads single-digit months', () => {
        expect(utcMonthKey(new Date('2026-01-15T00:00:00Z'))).toBe('2026-01');
        expect(utcMonthKey(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09');
        expect(utcMonthKey(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
    });

    it('reads the instant in UTC, not the runner local zone', () => {
        // 2026-03-01T00:30Z is still February in any zone behind UTC. The key
        // must follow the stored UTC timestamp, which is what the SQL bucket
        // that produced the row used.
        expect(utcMonthKey(new Date(Date.UTC(2026, 2, 1, 0, 30)))).toBe('2026-03');
        // ...and the last instant of a month stays in that month.
        expect(utcMonthKey(new Date(Date.UTC(2026, 1, 28, 23, 59, 59)))).toBe('2026-02');
    });
});
