/**
 * Equity Compensation — pure-core tests
 *
 * Covers computeVestSplits / computeEsppSplits from the DB-free computation
 * core: balancing, FMV cost basis, compensation income, sell-to-cover,
 * ESPP discounts, rounding against fromDecimal, and validation failures.
 */

import { describe, it, expect, vi } from 'vitest';

// gnucash.ts (fromDecimal) imports the prisma client at module scope;
// stub it out so the test never instantiates a DB connection.
vi.mock('../prisma', () => ({ default: {} }));

import {
    computeVestSplits,
    computeEsppSplits,
    validateVestInput,
    validateEsppInput,
    esppPurchasePriceFromDiscount,
    EquityCompValidationError,
    type EquityCompSplitSpec,
} from '@/lib/equity-comp-core';
import { fromDecimal } from '@/lib/gnucash';

function sumValue(splits: EquityCompSplitSpec[]): number {
    // All value denominators are the currency fraction, so numerators sum directly.
    return splits.reduce((acc, s) => acc + s.valueNum, 0);
}

function byRole(splits: EquityCompSplitSpec[], role: EquityCompSplitSpec['role']) {
    return splits.find(s => s.role === role);
}

describe('computeVestSplits', () => {
    it('vest with sell-to-cover balances to zero', () => {
        const splits = computeVestSplits({
            sharesVested: 100,
            fmvPerShare: 52.37,
            sharesWithheldForTax: 37,
        });
        expect(splits).toHaveLength(3);
        expect(sumValue(splits)).toBe(0);
        // All denominators consistent with defaults
        for (const s of splits) expect(s.valueDenom).toBe(100);
    });

    it('net shares land in the stock account at basis = FMV', () => {
        const splits = computeVestSplits({
            sharesVested: 100,
            fmvPerShare: 50,
            sharesWithheldForTax: 30,
        });
        const stock = byRole(splits, 'stock')!;
        // Net shares = 70, at the default 1/10000 share fraction
        expect(stock.quantityNum).toBe(70 * 10000);
        expect(stock.quantityDenom).toBe(10000);
        // Basis = net shares × FMV = 3500.00
        expect(stock.valueNum).toBe(3500 * 100);
        // Per-share basis equals FMV exactly
        const basisPerShare =
            (stock.valueNum / stock.valueDenom) / (stock.quantityNum / stock.quantityDenom);
        expect(basisPerShare).toBeCloseTo(50, 10);
    });

    it('compensation income is credited (negative) for the gross vest value', () => {
        const splits = computeVestSplits({
            sharesVested: 100,
            fmvPerShare: 50,
            sharesWithheldForTax: 30,
        });
        const income = byRole(splits, 'income')!;
        // Gross = 100 × 50 = 5000.00, credited
        expect(income.valueNum).toBe(-5000 * 100);
        // Currency split: quantity mirrors value
        expect(income.quantityNum).toBe(income.valueNum);
        expect(income.quantityDenom).toBe(income.valueDenom);
    });

    it('withheld-share value is debited to the tax account', () => {
        const splits = computeVestSplits({
            sharesVested: 100,
            fmvPerShare: 50,
            sharesWithheldForTax: 30,
        });
        const tax = byRole(splits, 'tax')!;
        expect(tax.valueNum).toBe(1500 * 100);
        expect(tax.quantityNum).toBe(tax.valueNum);
    });

    it('omits the tax split when nothing is withheld', () => {
        const splits = computeVestSplits({ sharesVested: 10, fmvPerShare: 25 });
        expect(splits).toHaveLength(2);
        expect(byRole(splits, 'tax')).toBeUndefined();
        expect(sumValue(splits)).toBe(0);
        expect(byRole(splits, 'income')!.valueNum).toBe(-250 * 100);
    });

    it('rounds via fromDecimal-compatible denominators and still balances exactly', () => {
        const input = {
            sharesVested: 10.5555,
            fmvPerShare: 33.333333,
            sharesWithheldForTax: 3.2101,
            shareFraction: 1000000,
            currencyFraction: 100,
        };
        const splits = computeVestSplits(input);
        const stock = byRole(splits, 'stock')!;
        const tax = byRole(splits, 'tax')!;
        const income = byRole(splits, 'income')!;

        const netShares = input.sharesVested - input.sharesWithheldForTax;

        // Numerators match fromDecimal's rounding rule for the same denominators
        expect(stock.quantityNum).toBe(Number(fromDecimal(netShares, input.shareFraction).num));
        expect(stock.quantityDenom).toBe(input.shareFraction);
        expect(stock.valueNum).toBe(
            Number(fromDecimal(netShares * input.fmvPerShare, input.currencyFraction).num)
        );
        expect(tax.valueNum).toBe(
            Number(fromDecimal(input.sharesWithheldForTax * input.fmvPerShare, input.currencyFraction).num)
        );

        // Income is the exact residual → guaranteed integer balance
        expect(income.valueNum).toBe(-(stock.valueNum + tax.valueNum));
        expect(sumValue(splits)).toBe(0);
        for (const s of splits) {
            expect(Number.isInteger(s.valueNum)).toBe(true);
            expect(Number.isInteger(s.quantityNum)).toBe(true);
        }
    });

    it('rejects invalid inputs', () => {
        expect(() => computeVestSplits({ sharesVested: 0, fmvPerShare: 10 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeVestSplits({ sharesVested: -5, fmvPerShare: 10 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeVestSplits({ sharesVested: 10, fmvPerShare: 0 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeVestSplits({ sharesVested: 10, fmvPerShare: 10, sharesWithheldForTax: -1 }))
            .toThrow(EquityCompValidationError);
        // Withholding everything (or more) is invalid — no shares would remain
        expect(() => computeVestSplits({ sharesVested: 10, fmvPerShare: 10, sharesWithheldForTax: 10 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeVestSplits({ sharesVested: 10, fmvPerShare: 10, sharesWithheldForTax: 12 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeVestSplits({ sharesVested: 10, fmvPerShare: 10, shareFraction: 0 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeVestSplits({ sharesVested: NaN, fmvPerShare: 10 }))
            .toThrow(EquityCompValidationError);

        const errors = validateVestInput({ sharesVested: -1, fmvPerShare: 0, sharesWithheldForTax: -2 });
        expect(errors.length).toBeGreaterThanOrEqual(3);
    });
});

describe('computeEsppSplits', () => {
    it('books FMV basis, actual-cost cash outflow, and discount as income', () => {
        // 15% discount: FMV 20.00, price 17.00, 50 shares
        const splits = computeEsppSplits({
            shares: 50,
            fmvPerShare: 20,
            purchasePricePerShare: 17,
            discountPercent: 15,
        });
        expect(splits).toHaveLength(3);
        expect(sumValue(splits)).toBe(0);

        const stock = byRole(splits, 'stock')!;
        const cash = byRole(splits, 'cash')!;
        const income = byRole(splits, 'income')!;

        // Basis = FMV, not the discounted price
        expect(stock.valueNum).toBe(1000 * 100);
        expect(stock.quantityNum).toBe(50 * 10000);
        // Cash outflow = actual purchase cost only
        expect(cash.valueNum).toBe(-850 * 100);
        expect(cash.quantityNum).toBe(cash.valueNum);
        // Discount portion credited as compensation income
        expect(income.valueNum).toBe(-150 * 100);
    });

    it('per-share basis equals FMV', () => {
        const splits = computeEsppSplits({
            shares: 12,
            fmvPerShare: 87.65,
            purchasePricePerShare: esppPurchasePriceFromDiscount(87.65, 15),
        });
        const stock = byRole(splits, 'stock')!;
        const basisPerShare =
            (stock.valueNum / stock.valueDenom) / (stock.quantityNum / stock.quantityDenom);
        expect(basisPerShare).toBeCloseTo(87.65, 2);
    });

    it('omits the income split when there is no discount', () => {
        const splits = computeEsppSplits({
            shares: 10,
            fmvPerShare: 30,
            purchasePricePerShare: 30,
        });
        expect(splits).toHaveLength(2);
        expect(byRole(splits, 'income')).toBeUndefined();
        expect(sumValue(splits)).toBe(0);
        expect(byRole(splits, 'cash')!.valueNum).toBe(-300 * 100);
    });

    it('rounds via fromDecimal-compatible denominators and balances exactly', () => {
        const input = {
            shares: 7.3333,
            fmvPerShare: 41.117,
            purchasePricePerShare: 34.94945,
            shareFraction: 10000,
            currencyFraction: 100,
        };
        const splits = computeEsppSplits(input);
        const stock = byRole(splits, 'stock')!;
        const cash = byRole(splits, 'cash')!;
        const income = byRole(splits, 'income')!;

        expect(stock.valueNum).toBe(
            Number(fromDecimal(input.shares * input.fmvPerShare, input.currencyFraction).num)
        );
        expect(stock.quantityNum).toBe(
            Number(fromDecimal(input.shares, input.shareFraction).num)
        );
        expect(cash.valueNum).toBe(
            -Number(fromDecimal(input.shares * input.purchasePricePerShare, input.currencyFraction).num)
        );
        // Income is the residual of the two rounded numerators
        expect(income.valueNum).toBe(-(stock.valueNum + cash.valueNum));
        expect(sumValue(splits)).toBe(0);
        for (const s of splits) {
            expect(Number.isInteger(s.valueNum)).toBe(true);
            expect(Number.isInteger(s.quantityNum)).toBe(true);
        }
    });

    it('derives purchase price from a discount percent', () => {
        expect(esppPurchasePriceFromDiscount(20, 15)).toBeCloseTo(17, 10);
        expect(esppPurchasePriceFromDiscount(100, 0)).toBe(100);
    });

    it('rejects invalid inputs', () => {
        expect(() => computeEsppSplits({ shares: 0, fmvPerShare: 10, purchasePricePerShare: 8 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeEsppSplits({ shares: 10, fmvPerShare: 0, purchasePricePerShare: 8 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeEsppSplits({ shares: 10, fmvPerShare: 10, purchasePricePerShare: 0 }))
            .toThrow(EquityCompValidationError);
        // Price above FMV = negative discount → rejected
        expect(() => computeEsppSplits({ shares: 10, fmvPerShare: 10, purchasePricePerShare: 11 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeEsppSplits({ shares: 10, fmvPerShare: 10, purchasePricePerShare: 8, discountPercent: 100 }))
            .toThrow(EquityCompValidationError);
        expect(() => computeEsppSplits({ shares: 10, fmvPerShare: 10, purchasePricePerShare: 8, currencyFraction: -100 }))
            .toThrow(EquityCompValidationError);

        const errors = validateEsppInput({ shares: -1, fmvPerShare: -1, purchasePricePerShare: -1 });
        expect(errors.length).toBeGreaterThanOrEqual(3);
    });

    it('exposes structured errors on the thrown validation error', () => {
        try {
            computeEsppSplits({ shares: -1, fmvPerShare: 10, purchasePricePerShare: 20 });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(EquityCompValidationError);
            const e = err as EquityCompValidationError;
            expect(e.errors).toContain('shares must be a positive number');
            expect(e.errors.some(m => m.includes('cannot exceed fmvPerShare'))).toBe(true);
        }
    });
});
