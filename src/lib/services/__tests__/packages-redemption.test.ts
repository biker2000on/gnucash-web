import { describe, it, expect, vi } from 'vitest';

// packages.service imports prisma + book-scope; the pure math under test
// doesn't touch either, so stub them out.
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => []) }));

import { computeRedemptionAmount, roundToFraction } from '../packages.service';

describe('roundToFraction', () => {
    it('rounds to cents by default', () => {
        expect(roundToFraction(33.333333)).toBe(33.33);
        expect(roundToFraction(33.335)).toBe(33.34);
    });

    it('rounds half away from zero for negatives', () => {
        expect(roundToFraction(-33.335)).toBe(-33.34);
    });

    it('honors non-cent fractions', () => {
        expect(roundToFraction(1.2345, 1000)).toBe(1.235);
    });
});

describe('computeRedemptionAmount', () => {
    it('recognizes the per-session slice for a normal redemption', () => {
        // $500 / 10 sessions = $50 each
        expect(computeRedemptionAmount(500, 10, 1, 0, [])).toBe(50);
        expect(computeRedemptionAmount(500, 10, 3, 2, [50, 50])).toBe(150);
    });

    it('rounds the per-session slice to cents', () => {
        // $100 / 3 sessions = 33.333... → 33.33
        expect(computeRedemptionAmount(100, 3, 1, 0, [])).toBe(33.33);
    });

    it('final redemption absorbs the rounding remainder so the liability zeroes', () => {
        // $100 / 3: 33.33 + 33.33 + FINAL. Final must be 33.34.
        const first = computeRedemptionAmount(100, 3, 1, 0, []);
        const second = computeRedemptionAmount(100, 3, 1, 1, [first]);
        const final = computeRedemptionAmount(100, 3, 1, 2, [first, second]);
        expect(first).toBe(33.33);
        expect(second).toBe(33.33);
        expect(final).toBe(33.34);
        expect(roundToFraction(first + second + final)).toBe(100);
    });

    it('zeroes the liability across many awkward per-session amounts', () => {
        // $199.99 / 7 sessions = 28.57 per session; drift must vanish.
        const price = 199.99;
        const total = 7;
        const amounts: number[] = [];
        for (let i = 0; i < total; i++) {
            amounts.push(computeRedemptionAmount(price, total, 1, i, amounts));
        }
        const sum = roundToFraction(amounts.reduce((s, v) => s + v, 0));
        expect(sum).toBe(price);
        // Every redemption stays within a cent of the ideal per-session price.
        for (const a of amounts) {
            expect(Math.abs(a - price / total)).toBeLessThan(0.02);
        }
    });

    it('multi-session final redemption also zeroes the liability', () => {
        // $100 / 3: one session, then a 2-session final redemption.
        const first = computeRedemptionAmount(100, 3, 1, 0, []);
        const final = computeRedemptionAmount(100, 3, 2, 1, [first]);
        expect(roundToFraction(first + final)).toBe(100);
        expect(final).toBe(66.67);
    });

    it('single-session package recognizes the full price at once', () => {
        expect(computeRedemptionAmount(149.5, 1, 1, 0, [])).toBe(149.5);
    });

    it('final amount accounts for prior amounts that drifted (e.g. after deletes)', () => {
        // Priors recorded 40 instead of the ideal 33.33 — final still zeroes.
        const final = computeRedemptionAmount(100, 3, 1, 2, [40, 33.33]);
        expect(final).toBe(26.67);
    });

    it('returns 0 for a degenerate zero-session package', () => {
        expect(computeRedemptionAmount(100, 0, 1, 0, [])).toBe(0);
    });
});
