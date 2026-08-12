/**
 * Regression: a pasted or malformed amount must never be silently coerced.
 *
 * The old simple-mode path used `parseFloat(amount) || 0`, so "$1,234.56"
 * booked $0.00 and "1,234.56" booked $1.00 — both reported as a success.
 */

import { describe, expect, it } from 'vitest';
import { parseAmount, parseAmountStrict } from '@/lib/parse-amount';

describe('parseAmountStrict', () => {
    it('accepts pasted currency and thousands separators', () => {
        expect(parseAmountStrict('$1,234.56')).toBe(1234.56);
        expect(parseAmountStrict('1,234.56')).toBe(1234.56);
        expect(parseAmountStrict(' 1 234.56 ')).toBe(1234.56);
        expect(parseAmountStrict('25')).toBe(25);
        expect(parseAmountStrict('-12.5')).toBe(-12.5);
        expect(parseAmountStrict('.5')).toBe(0.5);
        expect(parseAmountStrict(3.25)).toBe(3.25);
    });

    it('rejects malformed input instead of parsing a prefix', () => {
        for (const bad of ['abc', '1.2.3', '', '   ', '12abc', 'NaN', 'Infinity', '1e5', '--1']) {
            expect(parseAmountStrict(bad), bad).toBeNull();
        }
        expect(parseAmountStrict(null)).toBeNull();
        expect(parseAmountStrict(undefined)).toBeNull();
        expect(parseAmountStrict(NaN)).toBeNull();
        expect(parseAmountStrict(Infinity)).toBeNull();
    });
});

describe('parseAmount (lenient wrapper)', () => {
    it('keeps the invoice-UI contract: unparseable means 0', () => {
        expect(parseAmount('1,234.50')).toBe(1234.5);
        expect(parseAmount('')).toBe(0);
        expect(parseAmount('abc')).toBe(0);
        expect(parseAmount(3.25)).toBe(3.25);
        expect(parseAmount(null)).toBe(0);
    });
});
