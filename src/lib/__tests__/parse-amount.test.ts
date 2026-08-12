/**
 * Regression: a pasted or malformed amount must never be silently coerced.
 *
 * The original simple-mode path used `parseFloat(amount) || 0`, so
 * "$1,234.56" booked $0.00 and "1,234.56" booked $1.00 — both reported as a
 * success. An equally bad failure is "repairing" malformed input into a
 * different number, so the parser validates the ORIGINAL string's shape and
 * only then normalizes: "1,234,56" must be rejected, never read as 123456.
 */

import { describe, expect, it } from 'vitest';
import { parseAmountStrict } from '@/lib/parse-amount';

const ACCEPT: Array<[string, number]> = [
    ['1234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['1,234,567.89', 1234567.89],
    ['$1,234.56', 1234.56],
    ['$1234.56', 1234.56],
    ['£1,234.56', 1234.56],
    ['€999', 999],
    ['¥1,000', 1000],
    ['  1,234.56  ', 1234.56],   // surrounding whitespace only
    ['25', 25],
    ['0', 0],
    ['.5', 0.5],
    ['0.5', 0.5],
    ['1234.', 1234],
    ['-12.5', -12.5],
    ['+12.5', 12.5],
    ['-$5', -5],
    ['$-5', -5],
    ['0.256', 0.256],            // sub-cent precision (share prices)
];

const REJECT: string[] = [
    // malformed grouping — must NOT be normalized into a different number
    '1,234,56',                  // would become 123456
    '1,23',
    '1,2345',
    ',234',
    '1,',
    // interior whitespace — would become 123
    '1 2 3',
    '1 234.56',
    // extra / interior currency symbols — would become 1234
    '$1$234',
    '1$234',
    '$$5',
    // not a number at all, or trailing garbage
    'abc',
    '12abc',
    '$',
    '',
    '   ',
    '.',
    '-',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e5',
    // multiple decimal points / signs
    '1.2.3',
    '--1',
    '1-2',
    '5-',
];

describe('parseAmountStrict — accepts', () => {
    it.each(ACCEPT)('%s → %s', (input, expected) => {
        expect(parseAmountStrict(input)).toBe(expected);
    });

    it('passes finite numbers through', () => {
        expect(parseAmountStrict(3.25)).toBe(3.25);
        expect(parseAmountStrict(0)).toBe(0);
    });
});

describe('parseAmountStrict — rejects', () => {
    it.each(REJECT.map(v => [v]))('%j → null', (input) => {
        expect(parseAmountStrict(input)).toBeNull();
    });

    it('rejects non-finite numbers and nullish values', () => {
        expect(parseAmountStrict(NaN)).toBeNull();
        expect(parseAmountStrict(Infinity)).toBeNull();
        expect(parseAmountStrict(-Infinity)).toBeNull();
        expect(parseAmountStrict(null)).toBeNull();
        expect(parseAmountStrict(undefined)).toBeNull();
    });

    it('never repairs malformed grouping into a larger number', () => {
        // The whole point: 1,234,56 as $123,456.00 is worse than the original bug.
        expect(parseAmountStrict('1,234,56')).not.toBe(123456);
        expect(parseAmountStrict('1 2 3')).not.toBe(123);
        expect(parseAmountStrict('$1$234')).not.toBe(1234);
    });
});
