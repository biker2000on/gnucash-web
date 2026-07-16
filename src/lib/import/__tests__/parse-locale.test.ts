import { describe, it, expect } from 'vitest';
import {
    parseLocaleNumber,
    parseLocaleDate,
    couldBeDayFirst,
    resolveImportLocale,
    IMPORT_LOCALES,
} from '../parse-locale';

describe('parseLocaleNumber (US, decimal point)', () => {
    it('parses plain and comma-thousands amounts', () => {
        expect(parseLocaleNumber('45.99')).toBe(45.99);
        expect(parseLocaleNumber('1,234.56')).toBe(1234.56);
        expect(parseLocaleNumber('12,345,678.90')).toBe(12345678.9);
    });

    it('treats blank / dash cells as zero', () => {
        expect(parseLocaleNumber('')).toBe(0);
        expect(parseLocaleNumber('  ')).toBe(0);
        expect(parseLocaleNumber('-')).toBe(0);
        expect(parseLocaleNumber('--')).toBe(0);
    });

    it('parses parentheses and leading minus as negative', () => {
        expect(parseLocaleNumber('(45.10)')).toBe(-45.1);
        expect(parseLocaleNumber('($1,000.00)')).toBe(-1000);
        expect(parseLocaleNumber('-12.5')).toBe(-12.5);
    });

    it('strips currency symbols and spaces', () => {
        expect(parseLocaleNumber('$3,000.00')).toBe(3000);
        expect(parseLocaleNumber('$ 42')).toBe(42);
        expect(parseLocaleNumber('€1,250.00')).toBe(1250);
    });

    it('returns null for unparseable text', () => {
        expect(parseLocaleNumber('abc')).toBeNull();
        expect(parseLocaleNumber('N/A')).toBeNull();
        expect(parseLocaleNumber('1.2.3')).toBeNull();
    });
});

describe('parseLocaleNumber (EU, decimal comma)', () => {
    const eu = { decimal: ',' as const };

    it('parses dot-thousands + comma-decimal amounts', () => {
        expect(parseLocaleNumber('1.234,56', eu)).toBe(1234.56);
        expect(parseLocaleNumber('12.345.678,90', eu)).toBe(12345678.9);
        expect(parseLocaleNumber('45,99', eu)).toBe(45.99);
        expect(parseLocaleNumber('45', eu)).toBe(45);
    });

    it('handles negatives and currency symbols', () => {
        expect(parseLocaleNumber('(1.000,00)', eu)).toBe(-1000);
        expect(parseLocaleNumber('-12,5', eu)).toBe(-12.5);
        expect(parseLocaleNumber('1.250,00 €', eu)).toBe(1250);
    });

    it('returns null for unparseable text and zero for blanks', () => {
        expect(parseLocaleNumber('abc', eu)).toBeNull();
        expect(parseLocaleNumber('', eu)).toBe(0);
        expect(parseLocaleNumber('1,2,3', eu)).toBeNull();
    });
});

describe('parseLocaleDate (month-first, US default)', () => {
    it('parses MM/DD/YYYY', () => {
        expect(parseLocaleDate('01/15/2025')).toBe('2025-01-15');
        expect(parseLocaleDate('1/5/2025')).toBe('2025-01-05');
        expect(parseLocaleDate('12/31/2024')).toBe('2024-12-31');
    });

    it('parses ISO regardless of locale', () => {
        expect(parseLocaleDate('2025-03-05')).toBe('2025-03-05');
        expect(parseLocaleDate('2025/03/05')).toBe('2025-03-05');
        expect(parseLocaleDate('2025-03-05', { dayFirst: true })).toBe('2025-03-05');
    });

    it('expands 2-digit years with a 1970 pivot', () => {
        expect(parseLocaleDate('01/15/25')).toBe('2025-01-15');
        expect(parseLocaleDate('01/15/99')).toBe('1999-01-15');
    });

    it('is strict: no silent day-first fallback', () => {
        expect(parseLocaleDate('13/12/2025')).toBeNull(); // month 13
        expect(parseLocaleDate('02/29/2023')).toBeNull(); // not a leap year
        expect(parseLocaleDate('02/29/2024')).toBe('2024-02-29');
        expect(parseLocaleDate('not a date')).toBeNull();
        expect(parseLocaleDate('')).toBeNull();
    });

    it('parses month-name forms', () => {
        expect(parseLocaleDate('5 Jan 2025')).toBe('2025-01-05');
        expect(parseLocaleDate('05 January 2025')).toBe('2025-01-05');
        expect(parseLocaleDate('Jan 5, 2025')).toBe('2025-01-05');
        expect(parseLocaleDate('January 5 2025')).toBe('2025-01-05');
        expect(parseLocaleDate('5 Foo 2025')).toBeNull();
    });
});

describe('parseLocaleDate (day-first, EU)', () => {
    const eu = { dayFirst: true };

    it('parses DD/MM/YYYY', () => {
        expect(parseLocaleDate('15/01/2025', eu)).toBe('2025-01-15');
        expect(parseLocaleDate('5/1/2025', eu)).toBe('2025-01-05');
        expect(parseLocaleDate('31/12/2024', eu)).toBe('2024-12-31');
        expect(parseLocaleDate('31.12.2024', eu)).toBe('2024-12-31');
    });

    it('is strict for the day-first order', () => {
        expect(parseLocaleDate('12/13/2025', eu)).toBeNull(); // month 13 day-first
    });

    it('interprets ambiguous dates day-first', () => {
        expect(parseLocaleDate('03/04/2025', eu)).toBe('2025-04-03');
        expect(parseLocaleDate('03/04/2025')).toBe('2025-03-04');
    });
});

describe('couldBeDayFirst', () => {
    it('flags dates valid in BOTH orders with different results', () => {
        expect(couldBeDayFirst('03/04/2025')).toBe(true);
        expect(couldBeDayFirst('1/2/25')).toBe(true);
    });

    it('does not flag unambiguous or identical dates', () => {
        expect(couldBeDayFirst('15/04/2025')).toBe(false); // only day-first valid
        expect(couldBeDayFirst('04/15/2025')).toBe(false); // only month-first valid
        expect(couldBeDayFirst('04/04/2025')).toBe(false); // same either way
        expect(couldBeDayFirst('2025-03-04')).toBe(false); // ISO
        expect(couldBeDayFirst('Jan 5, 2025')).toBe(false);
        expect(couldBeDayFirst('')).toBe(false);
    });
});

describe('resolveImportLocale', () => {
    it('maps ids and falls back to US', () => {
        expect(resolveImportLocale('eu')).toEqual(IMPORT_LOCALES.eu);
        expect(resolveImportLocale('us')).toEqual(IMPORT_LOCALES.us);
        expect(resolveImportLocale('nonsense')).toEqual(IMPORT_LOCALES.us);
        expect(resolveImportLocale(null)).toEqual(IMPORT_LOCALES.us);
        expect(resolveImportLocale(undefined)).toEqual(IMPORT_LOCALES.us);
    });
});
