/**
 * Price and exchange-rate staleness — one bound, one age calculation.
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
 * Maximum age, in whole days, of a quote that may be presented as current.
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
 * its default from here so the app has ONE definition of a stale price.
 *
 * Callers that need a different bound pass one explicitly — the Data Health
 * route already exposes it as a request parameter. There is deliberately no
 * new persisted setting: the valuation path runs in request-less contexts
 * (startup, scheduled reports, cross-book jobs) that have no user to read a
 * preference for, and a bound that silently varies by who is looking is worse
 * than a documented constant.
 */
export const PRICE_STALENESS_DAYS = 7;

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
