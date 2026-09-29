import { describe, expect, it } from 'vitest';
import { clipFuturePoints, fitDomain, niceStep } from '../fit-domain';

describe('niceStep', () => {
    it('rounds up to 1, 2, 2.5, 5, or 10 times a power of ten', () => {
        expect(niceStep(0.8)).toBe(1);
        expect(niceStep(17_000)).toBe(20_000);
        expect(niceStep(23_000)).toBe(25_000);
        expect(niceStep(41_000)).toBe(50_000);
        expect(niceStep(73_000)).toBe(100_000);
    });
});

describe('fitDomain', () => {
    it('fits a one-year net worth move instead of starting at zero', () => {
        // The dashboard case: ~$1.37M to ~$1.58M over the year.
        const fitted = fitDomain([1_373_000, 1_400_000, 1_520_000, 1_575_438])!;
        const [lo, hi] = fitted.domain;
        expect(lo).toBeGreaterThan(1_200_000);
        expect(hi).toBeLessThan(1_700_000);
        expect(lo).toBeLessThanOrEqual(1_373_000);
        expect(hi).toBeGreaterThanOrEqual(1_575_438);
        // The movement fills most of the axis, not a sliver of it.
        expect((1_575_438 - 1_373_000) / (hi - lo)).toBeGreaterThan(0.5);
    });

    it('returns evenly spaced ticks spanning the domain', () => {
        const { domain, ticks } = fitDomain([1_373_000, 1_575_438])!;
        expect(ticks[0]).toBe(domain[0]);
        expect(ticks[ticks.length - 1]).toBe(domain[1]);
        const step = ticks[1] - ticks[0];
        ticks.slice(1).forEach((t, i) => expect(t - ticks[i]).toBeCloseTo(step));
    });

    it('gives a flat series a visible span', () => {
        const { domain } = fitDomain([500_000, 500_000, 500_000])!;
        expect(domain[1] - domain[0]).toBeGreaterThan(0);
        expect(domain[0]).toBeLessThan(500_000);
        expect(domain[1]).toBeGreaterThan(500_000);
    });

    it('never pushes a non-negative series below zero', () => {
        expect(fitDomain([0, 10_000, 1_600_000])!.domain[0]).toBe(0);
    });

    it('uses the finer step when the coarse one would waste the axis', () => {
        // Assets, net worth, and liabilities on one scale: a 600k raw step
        // rounds up to 1M (-1M..2M); 500k fits in -500k..2M.
        const { domain, ticks } = fitDomain([-216_000, 1_800_000])!;
        expect(domain).toEqual([-500_000, 2_000_000]);
        expect(ticks).toHaveLength(6);
    });

    it('includes negative values such as liabilities', () => {
        const { domain } = fitDomain([-210_000, 1_780_000])!;
        expect(domain[0]).toBeLessThanOrEqual(-210_000);
        expect(domain[1]).toBeGreaterThanOrEqual(1_780_000);
    });

    it('returns null for no finite values', () => {
        expect(fitDomain([])).toBeNull();
        expect(fitDomain([NaN])).toBeNull();
    });
});

describe('clipFuturePoints', () => {
    const months = ['2026-01-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-12-31'].map((date) => ({ date }));

    it('keeps the current period and drops later ones', () => {
        expect(clipFuturePoints(months, '2026-09-29').map((p) => p.date)).toEqual([
            '2026-01-31',
            '2026-08-31',
            '2026-09-30',
        ]);
    });

    it('keeps a period that ends today', () => {
        expect(clipFuturePoints(months, '2026-08-31').map((p) => p.date)).toEqual(['2026-01-31', '2026-08-31']);
    });

    it('leaves an entirely past range alone', () => {
        expect(clipFuturePoints(months, '2027-01-15')).toEqual(months);
    });
});
