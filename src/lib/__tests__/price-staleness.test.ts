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
    CONTINUOUS_STALENESS_DAYS,
    CONTINUOUS_WEEKEND_EVIDENCE,
    PRICE_STALENESS_DAYS,
    isContinuousMarket,
    isPriceStale,
    priceAgeDays,
    stalePriceMark,
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
 *
 * The tighter bound has to be liveable for BOTH populations this app has: books
 * on the daily worker schedule (`refresh_enabled`, default 21:00 UTC) and books
 * that only get quotes when someone presses "Refresh All Prices". Three days is
 * the smallest number that is quiet for both on an ordinary week — two missed
 * scheduled runs, or a Friday refresh still reading clean on Monday.
 */
describe('stalenessDaysFor', () => {
    it('holds a continuously-traded commodity to a tighter bound', () => {
        expect(stalenessDaysFor({ namespace: 'CRYPTO' })).toBe(CONTINUOUS_STALENESS_DAYS);
        expect(CONTINUOUS_STALENESS_DAYS).toBeLessThan(PRICE_STALENESS_DAYS);
    });

    it('reads the namespace case-insensitively, as the rest of the app does', () => {
        // `yahoo-symbol.ts` and `commodity-metadata.ts` both upper-case before
        // comparing, because namespace is free text in the GnuCash schema.
        expect(stalenessDaysFor({ namespace: 'crypto' })).toBe(CONTINUOUS_STALENESS_DAYS);
        expect(stalenessDaysFor({ namespace: 'Crypto' })).toBe(CONTINUOUS_STALENESS_DAYS);
    });

    it('keeps the exchange-traded bound for every namespace that closes', () => {
        for (const ns of ['CURRENCY', 'ISO4217', 'NASDAQ', 'NYSE', 'AMEX', 'FUND', 'ETF', 'BOND',
            'INDEX', 'DEMO', 'PRIVATE', 'template']) {
            expect(stalenessDaysFor({ namespace: ns })).toBe(PRICE_STALENESS_DAYS);
        }
    });

    it('falls back to the looser bound when nothing is known', () => {
        // Late beats crying wolf: an unrecognised instrument may legitimately
        // quote weekly, and a warning nobody believes protects nobody.
        expect(stalenessDaysFor(undefined)).toBe(PRICE_STALENESS_DAYS);
        expect(stalenessDaysFor(null)).toBe(PRICE_STALENESS_DAYS);
        expect(stalenessDaysFor({})).toBe(PRICE_STALENESS_DAYS);
        expect(stalenessDaysFor({ namespace: 'SOMETHING_NEW' })).toBe(PRICE_STALENESS_DAYS);
    });

    it('splits on a gap that only one of the two markets closed for', () => {
        // Thursday's close read the Tuesday after a long weekend. For a listed
        // security that is the newest quote that could exist and warning would
        // be noise; for a market that never shut it is four days of trading
        // nobody recorded.
        const thursdayClose = new Date('2026-08-13T20:00:00.000Z');
        const tuesday = new Date('2026-08-18T13:00:00.000Z');
        expect(priceAgeDays(thursdayClose, tuesday)).toBe(4);
        expect(isPriceStale(thursdayClose, tuesday, stalenessDaysFor({ namespace: 'NASDAQ' })))
            .toBe(false);
        expect(isPriceStale(thursdayClose, tuesday, stalenessDaysFor({ namespace: 'CRYPTO' })))
            .toBe(true);
    });

    it('stays quiet across the weekend a manual refresher is away for', () => {
        // The population without the worker schedule gets a quote only when
        // they ask for one. Friday evening's refresh read on Monday morning is
        // the ordinary case, and a warning already firing on arrival — about a
        // condition only the reader can clear — is what teaches them to ignore
        // it.
        const fridayEvening = new Date('2026-08-14T22:00:00.000Z');
        const mondayMorning = new Date('2026-08-17T15:00:00.000Z');
        const bound = stalenessDaysFor({ namespace: 'CRYPTO' });

        expect(priceAgeDays(fridayEvening, mondayMorning)).toBe(2);
        expect(isPriceStale(fridayEvening, mondayMorning, bound)).toBe(false);
    });

    it('absorbs two missed scheduled runs and speaks on the third', () => {
        // A book with refresh_enabled has a quote every calendar day, so any
        // gap past the bound means the daily job has failed repeatedly rather
        // than run late once.
        const bound = stalenessDaysFor({ namespace: 'CRYPTO' });
        const onTheBound = new Date(MONDAY.getTime() - CONTINUOUS_STALENESS_DAYS * 86_400_000);
        const pastIt = new Date(MONDAY.getTime() - (CONTINUOUS_STALENESS_DAYS + 1) * 86_400_000);

        expect(isPriceStale(onTheBound, MONDAY, bound)).toBe(false);
        expect(isPriceStale(pastIt, MONDAY, bound)).toBe(true);
    });
});

/**
 * Why the classification is not `namespace === 'CRYPTO'`.
 *
 * Nothing enforces that string. `commodities.namespace` is a 2048-character
 * free-text column, the commodities API accepts any string on creation, and the
 * namespace field in settings offers a suggestion list rather than an enum. Books
 * arrive by import and by hand, so crypto in a real book may be filed under
 * anything — and every spelling that is not exactly `CRYPTO` would otherwise
 * inherit the seven-day exchange bound, which is the defect, merely narrowed.
 */
describe('isContinuousMarket', () => {
    it('recognises the namespace however it was spelled', () => {
        for (const ns of ['CRYPTO', 'crypto', 'Cryptocurrency', 'CRYPTO:BTC', 'crypto-assets',
            'Coinbase', 'COIN', 'coins', 'BITCOIN', 'stablecoin', 'KRAKEN', 'Binance',
            'digital currency', 'Virtual Assets']) {
            expect(isContinuousMarket({ namespace: ns }), ns).toBe(true);
        }
    });

    it('is settled by the price history when the namespace names no venue', () => {
        // The limb that survives a namespace nobody has ever seen: complete
        // weekends of fetched quotes are what "never closes" MEANS.
        expect(isContinuousMarket({
            namespace: 'my-ledger-import',
            mnemonic: 'WHO-KNOWS',
            continuousWeekends: CONTINUOUS_WEEKEND_EVIDENCE,
        })).toBe(true);
    });

    it('lets a namespace that names a closing venue outrank the price history', () => {
        // The ordering that matters most here, and it runs the other way to
        // evidence-first. A commodity filed under NASDAQ IS on NASDAQ, and
        // NASDAQ has a weekend; weekend-dated rows in its history are a fact
        // about this book's price table, not about the venue. Reading them as
        // proof of a continuous market reclassifies listed equities onto the
        // three-day bound and produces a four-day warning on a healthy holding
        // every week — the cry-wolf failure the seven-day figure exists to
        // prevent, aimed at the instruments it was protecting.
        expect(isContinuousMarket({
            namespace: 'NASDAQ',
            continuousWeekends: CONTINUOUS_WEEKEND_EVIDENCE * 4,
        })).toBe(false);

        for (const ns of ['NYSE', 'AMEX', 'FUND', 'ETF', 'BOND', 'INDEX', 'CURRENCY',
            'ISO4217', 'template', 'DEMO', 'PRIVATE', 'LSE', 'XETRA', 'HKEX']) {
            expect(isContinuousMarket({
                namespace: ns,
                mnemonic: 'BTC',
                continuousWeekends: 13,
            }), ns).toBe(false);
        }
    });

    it('is not fooled by a week-ending series under an unknown namespace', () => {
        // The reachable false positive that a bare count of weekend-dated rows
        // could not see. A weekly week-ending import is dated Saturday by
        // construction — roughly thirteen weekend-dated rows in ninety days — yet
        // it has one dated day per week, so it forms no complete weekend at all.
        expect(isContinuousMarket({
            namespace: 'Custodian Import',
            mnemonic: 'ZZZZ',
            continuousWeekends: 0,
        })).toBe(false);
    });

    it('does not read a handful of weekend prices as a continuous market', () => {
        // Monthly or quarterly weekend valuations, and hand-typed Saturday
        // prices, sit below the threshold. Sub-threshold evidence decides
        // nothing, and an unknown namespace with an unlisted ticker ends at the
        // looser bound.
        expect(isContinuousMarket({
            namespace: 'my-ledger-import',
            mnemonic: 'WHO-KNOWS',
            continuousWeekends: CONTINUOUS_WEEKEND_EVIDENCE - 1,
        })).toBe(false);
    });

    it('keeps a spot-crypto ETF on the exchange bound however it is quoted', () => {
        // The case the authoritative limb exists for: namespace NASDAQ, a crypto
        // ticker, and a custodian series that may well carry weekend rows. It is
        // a share in a fund that trades when NASDAQ is open.
        expect(stalenessDaysFor({
            namespace: 'NASDAQ',
            mnemonic: 'BTC',
            continuousWeekends: 13,
        })).toBe(PRICE_STALENESS_DAYS);
        // Filed by asset class rather than venue, it is still an ETF.
        expect(stalenessDaysFor({ namespace: 'Crypto ETF', mnemonic: 'IBIT' }))
            .toBe(PRICE_STALENESS_DAYS);
    });

    it('still reaches the tighter bound for genuine crypto under an unknown namespace', () => {
        // Both routes that remain open once naming fails, since this is what the
        // reordering must not have cost.
        expect(stalenessDaysFor({
            namespace: 'Ledger Nano X',
            mnemonic: 'SOMETOKEN',
            continuousWeekends: CONTINUOUS_WEEKEND_EVIDENCE,
        })).toBe(CONTINUOUS_STALENESS_DAYS);
        expect(stalenessDaysFor({ namespace: 'Ledger Nano X', mnemonic: 'BTC' }))
            .toBe(CONTINUOUS_STALENESS_DAYS);
        // And the named-venue route, which never needed evidence.
        expect(stalenessDaysFor({ namespace: 'Coinbase', mnemonic: 'SOMETOKEN' }))
            .toBe(CONTINUOUS_STALENESS_DAYS);
    });

    it('reads a two-word continuous phrase ahead of the generic token inside it', () => {
        // "Digital Currency" contains CURRENCY, which alone names a closing
        // venue. The compound is the more specific reading of the same text, so
        // it is tested first — otherwise the authoritative limb would swallow it.
        expect(isContinuousMarket({ namespace: 'Digital Currency' })).toBe(true);
        expect(isContinuousMarket({ namespace: 'Virtual Assets' })).toBe(true);
        expect(isContinuousMarket({ namespace: 'CURRENCY' })).toBe(false);
    });

    it('falls back to the mnemonic for an imported book with a wallet namespace', () => {
        expect(isContinuousMarket({ namespace: 'Ledger Nano', mnemonic: 'BTC' })).toBe(true);
        expect(isContinuousMarket({ namespace: '', mnemonic: 'eth' })).toBe(true);
        expect(isContinuousMarket({ namespace: null, mnemonic: 'USDC' })).toBe(true);
    });

    it('does not let the mnemonic re-label something that demonstrably closes', () => {
        // A spot-crypto ETF trades on an exchange with a weekend; its ticker is
        // not the point. The namespace names a venue that closes, so the
        // mnemonic limb is never consulted.
        expect(isContinuousMarket({ namespace: 'NASDAQ', mnemonic: 'BTC' })).toBe(false);
        expect(isContinuousMarket({ namespace: 'ETF', mnemonic: 'ETH' })).toBe(false);
    });

    it('leaves an ordinary security alone', () => {
        for (const c of [
            { namespace: 'NASDAQ', mnemonic: 'AAPL' },
            { namespace: 'NYSE', mnemonic: 'BRK.B' },
            { namespace: 'FUND', mnemonic: 'VTSAX' },
            { namespace: 'CURRENCY', mnemonic: 'EUR' },
            { namespace: 'SOMETHING_NEW', mnemonic: 'ZZZZ' },
            {},
        ]) {
            expect(isContinuousMarket(c), JSON.stringify(c)).toBe(false);
        }
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
        const crypto = stalePriceMessage('BTC', '2026-08-10', 7, CONTINUOUS_STALENESS_DAYS);
        expect(crypto).toContain(`older than ${CONTINUOUS_STALENESS_DAYS} days`);
        expect(crypto).not.toContain(`older than ${PRICE_STALENESS_DAYS} days`);
    });

    it('reads as a disclosure, not an exclusion', () => {
        // The value IS in the total; refusing to value the position would be a
        // worse outcome than valuing it out loud.
        expect(stalePriceMessage('AAPL', '2026-08-01', 16)).not.toContain('excluded');
    });
});

describe('stalePriceMark', () => {
    it('carries both numbers, because one table can apply two bounds', () => {
        // The compact form for a table cell. A row marked "stale" beside an
        // unmarked row of the same age is unexplainable without the limit.
        const mark = stalePriceMark(4, CONTINUOUS_STALENESS_DAYS);
        expect(mark).toContain('4d old');
        expect(mark).toContain(`limit ${CONTINUOUS_STALENESS_DAYS}d`);
        expect(mark).toContain('stale');
    });
});
