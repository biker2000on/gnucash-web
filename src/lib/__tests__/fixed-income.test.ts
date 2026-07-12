import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
        accounts: { findMany: vi.fn() },
    },
}));

import {
    bondPriceFromYield,
    computeYTM,
    currentYield,
    yearsToMaturity,
    computePosition,
    buildLadder,
    weightedAverageMaturity,
    weightedAverageYield,
    upcomingMaturities,
    estimateCouponPayments,
    summarizeFixedIncome,
    validateFixedIncomeInput,
    FixedIncomeValidationError,
    type FixedIncomePosition,
} from '@/lib/fixed-income';

const ASOF = new Date(2026, 6, 1); // 2026-07-01 local

function position(over: Partial<FixedIncomePosition>): FixedIncomePosition {
    return {
        accountGuid: 'a'.repeat(32),
        accountName: 'Test Bond',
        accountPath: 'Assets:Fixed Income:Test Bond',
        kind: 'bond',
        faceValue: 10000,
        couponRate: 4,
        purchaseDate: '2024-07-01',
        maturityDate: '2031-07-01',
        callable: false,
        currentValue: 10000,
        ...over,
    };
}

describe('bond math', () => {
    describe('bondPriceFromYield', () => {
        it('prices a par bond at face when yield equals the coupon', () => {
            const price = bondPriceFromYield({
                faceValue: 1000, couponRatePct: 5, annualYieldPct: 5, years: 10,
            });
            expect(price).toBeCloseTo(1000, 6);
        });

        it('prices a zero-coupon bond as pure discount', () => {
            // 1000 / 1.03^10 with semiannual compounding at 6%
            const price = bondPriceFromYield({
                faceValue: 1000, couponRatePct: 0, annualYieldPct: 6, years: 5,
            });
            expect(price).toBeCloseTo(1000 / Math.pow(1.03, 10), 6);
        });

        it('handles a zero yield as undiscounted cash flows', () => {
            const price = bondPriceFromYield({
                faceValue: 1000, couponRatePct: 4, annualYieldPct: 0, years: 3,
            });
            // 6 coupons of 20 + face
            expect(price).toBeCloseTo(1120, 6);
        });
    });

    describe('computeYTM (Newton solve)', () => {
        it('par bond: YTM equals the coupon rate', () => {
            const ytm = computeYTM({
                price: 1000, faceValue: 1000, couponRatePct: 5, yearsToMaturity: 10,
            });
            expect(ytm).not.toBeNull();
            expect(ytm!).toBeCloseTo(5, 4);
        });

        it('discount bond: YTM exceeds the coupon rate and round-trips the price', () => {
            const ytm = computeYTM({
                price: 950, faceValue: 1000, couponRatePct: 4, yearsToMaturity: 5,
            });
            expect(ytm).not.toBeNull();
            expect(ytm!).toBeGreaterThan(4);
            const roundTrip = bondPriceFromYield({
                faceValue: 1000, couponRatePct: 4, annualYieldPct: ytm!, years: 5,
            });
            expect(roundTrip).toBeCloseTo(950, 3);
        });

        it('premium bond: YTM is below the coupon rate', () => {
            const ytm = computeYTM({
                price: 1080, faceValue: 1000, couponRatePct: 6, yearsToMaturity: 7,
            });
            expect(ytm).not.toBeNull();
            expect(ytm!).toBeLessThan(6);
        });

        it('zero-coupon bond solves the exact closed-form yield', () => {
            // price = F / (1 + y/2)^(2T) with y = 6%, T = 5
            const price = 1000 / Math.pow(1.03, 10);
            const ytm = computeYTM({
                price, faceValue: 1000, couponRatePct: 0, yearsToMaturity: 5,
            });
            expect(ytm).not.toBeNull();
            expect(ytm!).toBeCloseTo(6, 4);
        });

        it('converges on a deep-discount long bond', () => {
            const ytm = computeYTM({
                price: 500, faceValue: 1000, couponRatePct: 10, yearsToMaturity: 20,
            });
            expect(ytm).not.toBeNull();
            expect(Number.isFinite(ytm!)).toBe(true);
            const roundTrip = bondPriceFromYield({
                faceValue: 1000, couponRatePct: 10, annualYieldPct: ytm!, years: 20,
            });
            expect(roundTrip).toBeCloseTo(500, 2);
        });

        it('returns null for matured or degenerate inputs', () => {
            expect(computeYTM({ price: 1000, faceValue: 1000, couponRatePct: 5, yearsToMaturity: 0 })).toBeNull();
            expect(computeYTM({ price: 1000, faceValue: 1000, couponRatePct: 5, yearsToMaturity: -1 })).toBeNull();
            expect(computeYTM({ price: 0, faceValue: 1000, couponRatePct: 5, yearsToMaturity: 5 })).toBeNull();
            expect(computeYTM({ price: 1000, faceValue: 0, couponRatePct: 5, yearsToMaturity: 5 })).toBeNull();
        });
    });

    describe('currentYield', () => {
        it('is annual coupon over price', () => {
            expect(currentYield(1000, 5, 950)).toBeCloseTo(5.263, 3);
        });
        it('is 0 for zero-coupon and null for zero price', () => {
            expect(currentYield(1000, 0, 900)).toBe(0);
            expect(currentYield(1000, 5, 0)).toBeNull();
        });
    });

    describe('yearsToMaturity', () => {
        it('computes fractional years from the as-of date', () => {
            expect(yearsToMaturity('2031-07-01', ASOF)).toBeCloseTo(5, 1);
            expect(yearsToMaturity('2026-01-01', ASOF)).toBeLessThan(0);
        });
    });
});

describe('computePosition', () => {
    it('marks past-maturity positions matured with no yield', () => {
        const p = computePosition(position({ maturityDate: '2025-01-01' }), ASOF);
        expect(p.matured).toBe(true);
        expect(p.yearsToMaturity).toBe(0);
        expect(p.ytm).toBeNull();
        expect(p.currentYield).toBeNull();
    });

    it('computes YTM and current yield for active positions', () => {
        const p = computePosition(
            position({ faceValue: 10000, couponRate: 4, currentValue: 10000, maturityDate: '2031-07-01' }),
            ASOF,
        );
        expect(p.matured).toBe(false);
        expect(p.annualCoupon).toBe(400);
        expect(p.ytm).toBeCloseTo(4, 1);
        expect(p.currentYield).toBeCloseTo(4, 5);
    });
});

describe('ladder bucketing', () => {
    it('buckets face and current value per maturity year, filling gaps', () => {
        const positions = [
            position({ accountGuid: 'a'.repeat(32), maturityDate: '2027-03-15', faceValue: 5000, currentValue: 4900 }),
            position({ accountGuid: 'b'.repeat(32), maturityDate: '2027-11-01', faceValue: 3000, currentValue: 3050 }),
            position({ accountGuid: 'c'.repeat(32), maturityDate: '2029-06-30', faceValue: 8000, currentValue: 7800 }),
        ].map(p => computePosition(p, ASOF));

        const ladder = buildLadder(positions, ASOF);
        expect(ladder.map(b => b.year)).toEqual([2026, 2027, 2028, 2029]);

        const y2027 = ladder.find(b => b.year === 2027)!;
        expect(y2027.faceValue).toBe(8000);
        expect(y2027.currentValue).toBe(7950);
        expect(y2027.count).toBe(2);

        const y2028 = ladder.find(b => b.year === 2028)!;
        expect(y2028.faceValue).toBe(0);
        expect(y2028.count).toBe(0);
    });

    it('excludes matured positions and returns [] when nothing is active', () => {
        const matured = [computePosition(position({ maturityDate: '2024-01-01' }), ASOF)];
        expect(buildLadder(matured, ASOF)).toEqual([]);
    });
});

describe('weighted averages', () => {
    it('weights maturity and yield by current value', () => {
        const positions = [
            // ~1 year out, value 10000
            position({ accountGuid: 'a'.repeat(32), maturityDate: '2027-07-01', faceValue: 10000, currentValue: 10000, couponRate: 4 }),
            // ~3 years out, value 30000
            position({ accountGuid: 'b'.repeat(32), maturityDate: '2029-07-01', faceValue: 30000, currentValue: 30000, couponRate: 6 }),
        ].map(p => computePosition(p, ASOF));

        const wam = weightedAverageMaturity(positions);
        // (1*10000 + 3*30000) / 40000 = 2.5
        expect(wam).toBeCloseTo(2.5, 1);

        const way = weightedAverageYield(positions);
        // Par bonds: YTM == coupon. (4*10000 + 6*30000)/40000 = 5.5
        expect(way).toBeCloseTo(5.5, 1);
    });

    it('returns null when no active positions carry weight', () => {
        expect(weightedAverageMaturity([])).toBeNull();
        expect(weightedAverageYield([])).toBeNull();
        const matured = [computePosition(position({ maturityDate: '2020-01-01' }), ASOF)];
        expect(weightedAverageMaturity(matured)).toBeNull();
        expect(weightedAverageYield(matured)).toBeNull();
    });
});

describe('upcoming maturities', () => {
    it('lists only maturities within the next 12 months, soonest first', () => {
        const positions = [
            position({ accountGuid: 'a'.repeat(32), maturityDate: '2026-09-15', faceValue: 1000 }),
            position({ accountGuid: 'b'.repeat(32), maturityDate: '2027-06-30', faceValue: 2000 }),
            position({ accountGuid: 'c'.repeat(32), maturityDate: '2027-08-01', faceValue: 3000 }), // beyond horizon
            position({ accountGuid: 'd'.repeat(32), maturityDate: '2026-01-01', faceValue: 4000 }), // already matured
        ].map(p => computePosition(p, ASOF));

        const upcoming = upcomingMaturities(positions, ASOF);
        expect(upcoming.map(u => u.maturityDate)).toEqual(['2026-09-15', '2027-06-30']);
        expect(upcoming[0].daysUntil).toBe(76);
    });
});

describe('coupon payment estimates', () => {
    it('generates semiannual payments of face x rate / 2 within the horizon', () => {
        const positions = [
            position({
                accountGuid: 'a'.repeat(32),
                maturityDate: '2028-01-15',
                faceValue: 10000,
                couponRate: 5,
                purchaseDate: '2023-01-15',
            }),
        ].map(p => computePosition(p, ASOF));

        const coupons = estimateCouponPayments(positions, ASOF);
        // Payments stepped back from 2028-01-15: 2026-07-15, 2027-01-15 inside (2026-07-01, 2027-07-01]
        expect(coupons.map(c => c.date)).toEqual(['2026-07-15', '2027-01-15']);
        expect(coupons.every(c => c.amount === 250)).toBe(true);
    });

    it('skips zero-coupon positions, ibonds, and matured positions', () => {
        const positions = [
            position({ accountGuid: 'a'.repeat(32), couponRate: 0 }),
            position({ accountGuid: 'b'.repeat(32), kind: 'ibond', couponRate: 5 }),
            position({ accountGuid: 'c'.repeat(32), couponRate: 5, maturityDate: '2024-01-01' }),
        ].map(p => computePosition(p, ASOF));

        expect(estimateCouponPayments(positions, ASOF)).toEqual([]);
    });
});

describe('summarizeFixedIncome', () => {
    it('assembles stats over active positions only', () => {
        const summary = summarizeFixedIncome([
            position({ accountGuid: 'a'.repeat(32), maturityDate: '2027-07-01', faceValue: 10000, currentValue: 9900, couponRate: 4 }),
            position({ accountGuid: 'b'.repeat(32), maturityDate: '2024-07-01', faceValue: 5000, currentValue: 0, couponRate: 3 }),
        ], ASOF);

        expect(summary.stats.activeCount).toBe(1);
        expect(summary.stats.maturedCount).toBe(1);
        expect(summary.stats.totalFace).toBe(10000);
        expect(summary.stats.totalCurrentValue).toBe(9900);
        expect(summary.stats.maturingNext12moFace).toBe(10000);
        expect(summary.stats.weightedAvgMaturityYears).toBeCloseTo(1, 1);
        // Two semiannual coupons of 200 within 12 months
        expect(summary.stats.couponIncomeNext12mo).toBe(400);
        expect(summary.positions).toHaveLength(2);
        expect(summary.ladder.some(b => b.year === 2027 && b.faceValue === 10000)).toBe(true);
    });
});

describe('validateFixedIncomeInput', () => {
    it('accepts a valid payload and normalizes it', () => {
        const v = validateFixedIncomeInput({
            kind: 'cd', faceValue: 5000, couponRate: 4.5,
            purchaseDate: '2025-01-01', maturityDate: '2027-01-01', callable: false,
        });
        expect(v.kind).toBe('cd');
        expect(v.faceValue).toBe(5000);
        expect(v.callable).toBe(false);
    });

    it('rejects bad kinds, non-positive face, bad dates, and inverted date order', () => {
        expect(() => validateFixedIncomeInput({ kind: 'stock', faceValue: 1, maturityDate: '2027-01-01' }))
            .toThrow(FixedIncomeValidationError);
        expect(() => validateFixedIncomeInput({ kind: 'bond', faceValue: 0, maturityDate: '2027-01-01' }))
            .toThrow(FixedIncomeValidationError);
        expect(() => validateFixedIncomeInput({ kind: 'bond', faceValue: 1, maturityDate: 'not-a-date' }))
            .toThrow(FixedIncomeValidationError);
        expect(() => validateFixedIncomeInput({
            kind: 'bond', faceValue: 1, maturityDate: '2027-01-01', purchaseDate: '2028-01-01',
        })).toThrow(FixedIncomeValidationError);
    });
});
