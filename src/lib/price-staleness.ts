/**
 * Price and exchange-rate staleness — one age calculation, one bound per
 * instrument class.
 *
 * Every price lookup in this app selects the newest quote dated at or before
 * the as-of date and stops there. That rule is right; what was missing is that
 * it says nothing about HOW old the winning quote is, so a rate last updated
 * years ago presents itself exactly like this morning's. The numbers built on
 * it — net worth, holdings valuation, gains — inherit that silence.
 *
 * The response is disclosure, never refusal: a portfolio valued from an old
 * quote and labelled as such is more useful than a portfolio the app declines
 * to value. Nothing in this module removes a figure from a total.
 *
 * This module is PURE and imports nothing, so both server valuation code and
 * Client Components can share the same bound (see the note at the top of
 * `holdings-coverage.ts` for why that matters to the browser bundle).
 */

/**
 * Maximum age, in whole days, of an EXCHANGE-TRADED instrument's quote that may
 * be presented as current. Also the bound for currency pairs, and the fallback
 * for a commodity whose namespace says nothing useful.
 *
 * Seven days, chosen so that the ordinary shape of a market week never trips
 * it. Exchanges close for weekends and holidays, so on any given morning the
 * newest quote that CAN exist is routinely two to four days old — Friday's
 * close read on Monday, or Thursday's close read the Tuesday after a long
 * weekend. A bound at or below four days would fire on healthy books every
 * week and train the reader to ignore it; a month-long bound waves through a
 * feed that stopped updating three weeks ago. Seven clears the longest normal
 * market gap with room to spare while still catching a quote that has actually
 * stopped arriving.
 *
 * It is also the number this project already uses for the same judgement in
 * the Data Health tool's "Stale prices" check (`data-health.ts`), which reads
 * its default from here.
 */
export const PRICE_STALENESS_DAYS = 7;

/**
 * The same bound for a CONTINUOUSLY-TRADED instrument — GnuCash namespace
 * `CRYPTO`.
 *
 * Two days. Everything the seven above buys is room for a gap in which no quote
 * CAN exist: the exchange is shut, so nobody could have published a price and a
 * warning would be blaming the book for the calendar. Crypto venues do not
 * close. They quote every calendar day, weekends and holidays included, so that
 * unavoidable gap is zero days rather than four, and the entire justification
 * for seven evaporates — leaving seven days in which a position that trades
 * around the clock, and that has repeatedly moved double digits inside
 * forty-eight hours, would be carried into a total at a price nobody was told
 * was old.
 *
 * What is left to absorb is this app's own quote cadence, not the market's.
 * Prices land one calendar day at a time and are fetched on demand rather than
 * by a scheduler, so on a book whose quotes are arriving normally the newest one
 * on file is yesterday's: a bound of one day would already be silent. Two adds
 * exactly one day of margin — enough for a refresh that ran late or was skipped
 * once, and for a quote stamped at a venue's UTC day boundary being read late in
 * the following day — and no more. A crypto quote from yesterday or the day
 * before is therefore silent; the third day is disclosed.
 */
export const CRYPTO_STALENESS_DAYS = 2;

/**
 * The bound that applies to one commodity, decided from its GnuCash namespace.
 *
 * The namespace is the classification this codebase ALREADY uses to tell crypto
 * apart from everything else — `yahoo-symbol.ts` routes namespace `CRYPTO` to
 * Yahoo's `{MNEMONIC}-USD` pair form, and `commodity-metadata.ts` skips the
 * sector-profile refresh on the same test — so staleness asks the same question
 * the same way instead of introducing a second scheme that could disagree with
 * those two. Compared case-insensitively for the reason they do it: namespace is
 * free text in the GnuCash schema.
 *
 * Anything unrecognised falls back to the exchange-traded bound. That is the
 * right answer for the namespaces that actually occur (CURRENCY, NASDAQ, NYSE,
 * AMEX, FUND, ETF, BOND — see the namespace list in settings/commodities), and
 * the safe direction for one that does not: a disclosure that arrives a few days
 * late on an unknown instrument is a smaller failure than one that cries wolf
 * every week on something which legitimately quotes weekly.
 */
export function stalenessDaysFor(namespace?: string | null): number {
    return (namespace ?? '').toUpperCase() === 'CRYPTO'
        ? CRYPTO_STALENESS_DAYS
        : PRICE_STALENESS_DAYS;
}

/**
 * Why the bounds above are constants rather than stored configuration.
 *
 * Not for want of a mechanism. `gnucash_web_book_settings`, behind
 * `services/book-settings.service.ts`, is exactly a non-user configuration
 * store — keyed per BOOK, not per user — and the request-less callers that
 * motivated this note (scheduled reports, cross-book jobs) do carry a book
 * identity, so a stored threshold could in fact be read on every path that
 * needs one. An earlier version of this comment claimed otherwise. It was
 * wrong.
 *
 * The reason to keep it in code is what the number MEANS. It is not a
 * preference about how much staleness a reader is willing to tolerate; it is a
 * claim about the market — how long an instrument can go without producing a
 * quote before silence stops being normal. That is a property of the venue, and
 * no book changes it. What an override would actually buy is the ability to turn
 * the disclosure DOWN: set it to 3650 and a holding priced in 2019 reports as
 * current, in a statement that no longer says anything is wrong. A disclosure
 * whose own threshold is adjustable by the party being disclosed to is not much
 * of a disclosure, and the adjustment would be invisible in the report it
 * silenced.
 *
 * There is a mechanical cost too, though it is the smaller argument: the bound
 * is applied in the browser as well as on the server (`PortfolioTable` marks
 * individual rows), so a per-book value would have to be threaded into every
 * report payload and every Client Component that renders one, and a payload
 * cached before a change would go on applying the old bound with nothing to
 * show that it had.
 *
 * None of which locks a caller in: the functions below all take an explicit
 * `maxAgeDays`, and the Data Health route already exposes it as a request
 * parameter for the operator who wants a different window on a diagnostic.
 */

const MS_PER_DAY = 86_400_000;

function toTime(value: Date | string | number | null | undefined): number | null {
    if (value === null || value === undefined || value === '') return null;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
}

/**
 * Whole days between a quote and the moment it is being used to value
 * something. Measured against the AS-OF date rather than the wall clock: a
 * statement drawn as of March 2020 is not stale for being about March 2020.
 *
 * A quote dated after the as-of moment counts as zero days old rather than a
 * negative age, so nothing downstream has to defend against a negative.
 */
export function priceAgeDays(
    priceDate: Date | string | number,
    asOf: Date | string | number,
): number {
    const priceTime = toTime(priceDate);
    const asOfTime = toTime(asOf);
    if (priceTime === null || asOfTime === null) return 0;
    return Math.max(0, Math.floor((asOfTime - priceTime) / MS_PER_DAY));
}

/**
 * True when a quote is strictly OLDER than the bound.
 *
 * Strictly: a quote sitting exactly on the bound is still acceptable, matching
 * `isOlderThan` in the Data Health checks so both surfaces agree about the same
 * price on the same day.
 *
 * A missing or unparseable date is NOT stale. Absence of a price is a different
 * failure with its own disclosure (a valuation gap — the holding is left out of
 * the total entirely); reporting it here as well would double-count it and
 * describe an excluded balance as merely old.
 */
export function isPriceStale(
    priceDate: Date | string | number | null | undefined,
    asOf: Date | string | number,
    maxAgeDays: number = PRICE_STALENESS_DAYS,
): boolean {
    const priceTime = toTime(priceDate);
    const asOfTime = toTime(asOf);
    if (priceTime === null || asOfTime === null) return false;
    return priceAgeDays(priceTime, asOfTime) > maxAgeDays;
}

/** The `yyyy-mm-dd` label for a quote date, in UTC. */
export function priceDateLabel(priceDate: Date | string | number): string {
    const time = toTime(priceDate);
    return time === null ? '' : new Date(time).toISOString().slice(0, 10);
}

/**
 * One line of user-facing disclosure for a stale quote.
 *
 * Deliberately phrased as "valued from" rather than "excluded": the figure IS
 * in the total, and a reader who confuses the two draws the wrong conclusion
 * about which numbers they can trust.
 */
export function stalePriceMessage(
    label: string,
    priceDateText: string,
    ageDays: number,
    maxAgeDays: number = PRICE_STALENESS_DAYS,
): string {
    return `${label} valued from a quote ${ageDays} days old (${priceDateText}); `
        + `prices older than ${maxAgeDays} days may not reflect current value.`;
}

/**
 * One commodity whose value in the report currency rests on a quote older than
 * the bound. Unlike a `ValuationGap`, the balance IS included in the total —
 * this states what it was priced from, so the total can be read for what it is.
 *
 * Fields are JSON-safe because this record travels to Client Components inside
 * report payloads.
 */
export interface StalePriceDisclosure {
    commodityGuid: string;
    /** Commodity mnemonic when it is known, otherwise the raw GUID. */
    label: string;
    /** `yyyy-mm-dd` of the quote actually used. */
    priceDate: string;
    ageDays: number;
    /** User-facing sentence describing what was priced from what. */
    message: string;
}

/**
 * Builds the disclosure for one commodity, or null when its quote is current.
 * Centralised so every surface reports the same age from the same rule.
 */
export function describeStalePrice(
    commodityGuid: string,
    label: string,
    priceDate: Date | string | number | null | undefined,
    asOf: Date | string | number,
    maxAgeDays: number = PRICE_STALENESS_DAYS,
): StalePriceDisclosure | null {
    if (!isPriceStale(priceDate, asOf, maxAgeDays)) return null;
    const dateText = priceDateLabel(priceDate as Date | string | number);
    const ageDays = priceAgeDays(priceDate as Date | string | number, asOf);
    return {
        commodityGuid,
        label,
        priceDate: dateText,
        ageDays,
        message: stalePriceMessage(label, dateText, ageDays, maxAgeDays),
    };
}
