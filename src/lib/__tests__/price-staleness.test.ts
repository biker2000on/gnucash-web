/**
 * The staleness bound itself.
 *
 * The threshold has to tolerate the ordinary shape of a market week — a quote
 * from Friday is the newest quote that exists on Monday, and a long weekend
 * pushes that to four days — while still catching a quote that has genuinely
 * stopped being updated. Everything below tests that boundary, not the
 * formatting around it.
 */
import { describe, expect, it } from 'vitest';
import {
    PRICE_STALENESS_DAYS,
    isPriceStale,
    priceAgeDays,
    stalePriceMessage,
} from '../price-staleness';

const MONDAY = new Date('2026-08-17T13:00:00.000Z');

describe('priceAgeDays', () => {
    it('counts whole elapsed days, not calendar boundaries', () => {
        // 6 days and 23 hours is still 6 whole days old.
        expect(priceAgeDays(new Date('2026-08-10T14:00:00.000Z'), MONDAY)).toBe(6);
        expect(priceAgeDays(new Date('2026-08-10T13:00:00.000Z'), MONDAY)).toBe(7);
    });

    it('treats a quote dated after the as-of moment as zero days old', () => {
        expect(priceAgeDays(new Date('2026-09-01T00:00:00.000Z'), MONDAY)).toBe(0);
    });

    it('measures against the as-of date, so a historical report is not stale by construction', () => {
        const asOf = new Date('2020-03-31T00:00:00.000Z');
        expect(priceAgeDays(new Date('2020-03-30T00:00:00.000Z'), asOf)).toBe(1);
        expect(isPriceStale(new Date('2020-03-30T00:00:00.000Z'), asOf)).toBe(false);
    });
});

describe('isPriceStale', () => {
    it('accepts a fresh quote', () => {
        expect(isPriceStale(new Date('2026-08-16T00:00:00.000Z'), MONDAY)).toBe(false);
    });

    it('does not warn on a weekend gap', () => {
        // Friday close, read on Monday: the newest quote that can exist.
        expect(isPriceStale(new Date('2026-08-14T20:00:00.000Z'), MONDAY)).toBe(false);
    });

    it('does not warn on a long-weekend / holiday gap', () => {
        // Thursday close before a Friday holiday, read the following Tuesday.
        const tuesday = new Date('2026-08-18T13:00:00.000Z');
        expect(isPriceStale(new Date('2026-08-13T20:00:00.000Z'), tuesday)).toBe(false);
    });

    it('accepts a quote sitting exactly on the bound', () => {
        const exactly = new Date(MONDAY.getTime() - PRICE_STALENESS_DAYS * 86_400_000);
        expect(priceAgeDays(exactly, MONDAY)).toBe(PRICE_STALENESS_DAYS);
        expect(isPriceStale(exactly, MONDAY)).toBe(false);
    });

    it('flags the first quote past the bound', () => {
        const past = new Date(MONDAY.getTime() - (PRICE_STALENESS_DAYS + 1) * 86_400_000);
        expect(isPriceStale(past, MONDAY)).toBe(true);
    });

    it('honours an explicit bound over the default', () => {
        const sixDays = new Date('2026-08-11T13:00:00.000Z');
        expect(isPriceStale(sixDays, MONDAY)).toBe(false);
        expect(isPriceStale(sixDays, MONDAY, 3)).toBe(true);
    });

    it('says nothing about a quote that does not exist', () => {
        // Absence is the "no price at all" problem, which is already disclosed
        // as a valuation gap. Reporting it here too would double-count it.
        expect(isPriceStale(null, MONDAY)).toBe(false);
        expect(isPriceStale(undefined, MONDAY)).toBe(false);
    });

    it('does not treat an unparseable date as stale', () => {
        expect(isPriceStale('not-a-date', MONDAY)).toBe(false);
    });
});

describe('stalePriceMessage', () => {
    it('names the holding, the quote it used, and the age', () => {
        const message = stalePriceMessage('AAPL', '2026-08-01', 16);
        expect(message).toContain('AAPL');
        expect(message).toContain('2026-08-01');
        expect(message).toContain('16 days old');
        expect(message).toContain(String(PRICE_STALENESS_DAYS));
    });

    it('reads as a disclosure, not an exclusion', () => {
        // The value IS in the total; refusing to value the position would be a
        // worse outcome than valuing it out loud.
        expect(stalePriceMessage('AAPL', '2026-08-01', 16)).not.toContain('excluded');
    });
});
