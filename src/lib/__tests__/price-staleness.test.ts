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
    CRYPTO_STALENESS_DAYS,
    PRICE_STALENESS_DAYS,
    isPriceStale,
    priceAgeDays,
    stalePriceMessage,
    stalenessDaysFor,
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

/**
 * The seven-day bound is bought entirely by the exchange being SHUT: it is the
 * span in which no quote could have existed, so warning would blame the book
 * for the calendar. A market that never closes has no such span, and holding it
 * to seven days hands back a week of silence on the asset class most able to
 * move inside it.
 */
describe('stalenessDaysFor', () => {
    it('holds a continuously-traded commodity to a tighter bound', () => {
        expect(stalenessDaysFor('CRYPTO')).toBe(CRYPTO_STALENESS_DAYS);
        expect(CRYPTO_STALENESS_DAYS).toBeLessThan(PRICE_STALENESS_DAYS);
    });

    it('reads the namespace case-insensitively, as the rest of the app does', () => {
        // `yahoo-symbol.ts` and `commodity-metadata.ts` both upper-case before
        // comparing, because namespace is free text in the GnuCash schema.
        expect(stalenessDaysFor('crypto')).toBe(CRYPTO_STALENESS_DAYS);
        expect(stalenessDaysFor('Crypto')).toBe(CRYPTO_STALENESS_DAYS);
    });

    it('keeps the exchange-traded bound for every namespace that closes', () => {
        for (const ns of ['CURRENCY', 'NASDAQ', 'NYSE', 'AMEX', 'FUND', 'ETF', 'BOND']) {
            expect(stalenessDaysFor(ns)).toBe(PRICE_STALENESS_DAYS);
        }
    });

    it('falls back to the looser bound when the namespace is unknown or absent', () => {
        // Late beats crying wolf: an unrecognised instrument may legitimately
        // quote weekly, and a warning nobody believes protects nobody.
        expect(stalenessDaysFor(undefined)).toBe(PRICE_STALENESS_DAYS);
        expect(stalenessDaysFor(null)).toBe(PRICE_STALENESS_DAYS);
        expect(stalenessDaysFor('SOMETHING_NEW')).toBe(PRICE_STALENESS_DAYS);
    });

    it('splits on a gap that spans a weekend, which only one of the two closed for', () => {
        // Friday's close read on Tuesday. For a listed security that is the
        // newest quote that could exist and warning would be noise; for crypto
        // it is three days of trading nobody recorded.
        const fridayClose = new Date('2026-08-14T20:00:00.000Z');
        const tuesday = new Date('2026-08-18T13:00:00.000Z');
        expect(priceAgeDays(fridayClose, tuesday)).toBe(3);
        expect(isPriceStale(fridayClose, tuesday, stalenessDaysFor('NASDAQ'))).toBe(false);
        expect(isPriceStale(fridayClose, tuesday, stalenessDaysFor('CRYPTO'))).toBe(true);
    });

    it('gives crypto one day of margin for a fetch that ran late, and no more', () => {
        const bound = stalenessDaysFor('CRYPTO');
        const onTheBound = new Date(MONDAY.getTime() - CRYPTO_STALENESS_DAYS * 86_400_000);
        const pastIt = new Date(MONDAY.getTime() - (CRYPTO_STALENESS_DAYS + 1) * 86_400_000);

        expect(isPriceStale(onTheBound, MONDAY, bound)).toBe(false);
        expect(isPriceStale(pastIt, MONDAY, bound)).toBe(true);
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

    it('states the bound it was judged against, since that is not one number', () => {
        // Two commodities in one statement can be held to different bounds, so
        // the line has to carry its own rather than lean on a shared heading.
        const crypto = stalePriceMessage('BTC', '2026-08-10', 7, CRYPTO_STALENESS_DAYS);
        expect(crypto).toContain(`older than ${CRYPTO_STALENESS_DAYS} days`);
        expect(crypto).not.toContain(`older than ${PRICE_STALENESS_DAYS} days`);
    });

    it('reads as a disclosure, not an exclusion', () => {
        // The value IS in the total; refusing to value the position would be a
        // worse outcome than valuing it out loud.
        expect(stalePriceMessage('AAPL', '2026-08-01', 16)).not.toContain('excluded');
    });
});
