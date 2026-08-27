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
 * The same bound for a CONTINUOUSLY-TRADED instrument — one whose venue never
 * closes, crypto being the case this book actually holds.
 *
 * Three days, and the reasoning has two halves: what the market allows, and what
 * this app's own quote cadence allows.
 *
 * THE MARKET. Everything the seven above buys is room for a gap in which no
 * quote CAN exist: the exchange is shut, so nobody could have published a price
 * and a warning would be blaming the book for the calendar. Continuous venues do
 * not close. They quote every calendar day, weekends and holidays included, so
 * that unavoidable gap is zero days rather than four, and the market half of the
 * justification for seven evaporates — leaving seven days in which a position
 * that trades around the clock, and that has repeatedly moved double digits
 * inside forty-eight hours, would be carried into a total at a price nobody was
 * told was old.
 *
 * THIS APP'S CADENCE, which is not one number, because there are two populations
 * and they refresh at different rates:
 *
 *   - SCHEDULED. `worker.ts` (`recoverSchedules`) reads the per-user
 *     `refresh_enabled` / `refresh_time` preferences — settable through
 *     `api/settings/schedules` — and runs `refresh-prices` once every calendar
 *     day, defaulting to 21:00 UTC. A book on that schedule has a quote for
 *     every day, so its newest quote is between a few hours and just under two
 *     days old at any moment a page is opened.
 *
 *   - MANUAL. `refresh_enabled` defaults to false, and nothing else fetches:
 *     opening the app does not pull prices, so the newest quote on file is from
 *     whenever someone last chose "Refresh All Prices". Quote age here is
 *     literally days-since-the-user-last-asked.
 *
 * Three days is the smallest bound that is quiet for BOTH on an ordinary week.
 * For the scheduled book it absorbs two consecutive failed or skipped runs
 * before it says anything — a real outage, not a hiccup. For the manual book it
 * is what lets a Friday refresh still read clean on Monday: after the ordinary
 * weekend away, age is 3 and this is silent, so the reader is not greeted by a
 * warning that was already firing before they could act on it. That greeting is
 * precisely the cry-wolf failure the seven-day bound exists to avoid for
 * equities, and a two-day bound reproduced it for every manual crypto holder.
 *
 * What three deliberately does NOT do is stretch to cover a reader who refreshes
 * weekly. At day four this speaks, and it should: on a market that quoted
 * continuously for four days, the price in the total is genuinely out of date,
 * and no bound can make that untrue. What makes it informative rather than
 * nagging is that the disclosure states the age, the bound it was judged
 * against, and — on the live surfaces, where it is true — how to fix it. A
 * warning you can act on is not a wolf.
 *
 * The bound is NOT made conditional on whether the scheduler is enabled, though
 * that was available. Doing so inverts the risk: it would relax the disclosure
 * for exactly the population whose quotes actually go stale, and tighten it for
 * the one that is already covered. How old a price is, and how far the asset can
 * have moved since, does not depend on why nobody fetched a newer one.
 */
export const CONTINUOUS_STALENESS_DAYS = 3;

/**
 * How many COMPLETE weekends must carry fetched quotes before the price history
 * is taken as evidence that the venue does not close.
 *
 * A complete weekend means a Saturday AND the Sunday immediately following it,
 * each carrying an automatically-fetched quote (see `CONTINUOUS_EVIDENCE_SOURCE`).
 * Four of them, inside the window below.
 *
 * WHY A PAIR AND NOT A COUNT OF WEEKEND DAYS. An earlier version of this asked
 * only for three weekend-dated rows of any provenance, which is a much weaker
 * question than it looks, because a weekend-dated price row is not rare:
 *
 *   - A week-ending series imported from a spreadsheet or a custodian statement
 *     is dated Saturday or Sunday BY CONSTRUCTION. Weekly, that is about
 *     thirteen weekend-dated rows in ninety days for an ordinary listed fund.
 *   - Monthly or quarterly valuations land on a weekend roughly two times in
 *     seven, so three of them inside a year is unremarkable.
 *   - A hand-typed price, a historical backfill, or a timestamp that drifted
 *     across midnight in another zone each contribute one.
 *
 * None of those say anything about whether a venue closes, and a bare count
 * cannot tell them from a market that genuinely trades on a Saturday.
 *
 * A pair can. "The venue did not close for the weekend" means, literally, that
 * it quoted on the Saturday and again on the Sunday. A week-ending series never
 * produces that — it has one dated day per week, so zero pairs, however many
 * weekend-dated rows it accumulates. A monthly valuation needs both days of the
 * SAME weekend, which a once-a-month cadence cannot do at all. A drifting
 * timestamp gives one day, not two adjacent ones.
 *
 * Meanwhile a genuinely continuous instrument on this app's daily refresh
 * produces a quote every calendar day, so it clears twelve or thirteen complete
 * weekends in ninety. Requiring four leaves that case a factor of three of
 * headroom while putting the accidental patterns above at zero.
 */
export const CONTINUOUS_WEEKEND_EVIDENCE = 4;

/**
 * The only `prices.source` the evidence limb counts.
 *
 * Provenance matters because the evidence question is about a VENUE, and only a
 * fetched quote is a venue's own statement about a day. The rows deliberately
 * left out:
 *
 *   - `user:price` and the other `user:` sources GnuCash desktop writes — a
 *     person typing a number, which proves the person was awake on a Saturday
 *     and nothing about the market.
 *   - `user:split-register`, the implied price `implied-price.service.ts` derives
 *     from a trade's own splits. That is a record of when someone entered a
 *     transaction, and transactions get entered at weekends constantly.
 *   - NULL and empty sources, which is what an import leaves when the origin was
 *     never recorded.
 *   - Any source string this app has never seen, which is the same unknown
 *     handled the same way everywhere else in this module: excluded, so the
 *     verdict falls toward the looser bound.
 *
 * `Finance::Quote` is the label this app writes for every fetched quote
 * (`yahoo-price-service.ts`, which also keys its upsert on it) and the label
 * GnuCash desktop writes for the same thing, so an imported book's fetched
 * history carries it too. Matching one exact string rather than a deny-list is
 * the direction that fails safe: an automated source under some other name is
 * merely not counted, and the commodity keeps the seven-day bound.
 */
export const CONTINUOUS_EVIDENCE_SOURCE = 'Finance::Quote';

/**
 * How far back the weekend evidence is sampled, in days.
 *
 * Ninety: long enough to hold about thirteen weekends, so a continuous
 * instrument clears the threshold above three times over, and short enough that
 * a commodity which USED to be fetched daily and has since gone quiet is judged
 * on what its venue does now. Bounded rather than open-ended so the scan cannot
 * grow with the length of a book's price history.
 *
 * Lives here, beside the threshold it feeds, so the two query paths that gather
 * the evidence (`account-valuation.ts`, `reports/investment-portfolio.ts`) cannot
 * sample different windows and reach different verdicts about one commodity.
 */
export const WEEKEND_EVIDENCE_DAYS = 90;

/**
 * What is known about a commodity when the bound has to be chosen for it.
 *
 * All fields optional: callers supply what they have. The classification degrades
 * to the exchange-traded default rather than failing.
 */
export interface CommodityMarketInput {
    /** GnuCash `commodities.namespace`. Free text — see below. */
    namespace?: string | null;
    /** GnuCash `commodities.mnemonic`, e.g. `BTC`. */
    mnemonic?: string | null;
    /**
     * Complete weekends — a Saturday and its following Sunday, both carrying a
     * `Finance::Quote` row — inside the last `WEEKEND_EVIDENCE_DAYS`. Supplied by
     * the server paths that already query `prices`; absent in a Client Component
     * reading a payload that predates it, in which case the naming limbs decide
     * and the bound falls back to the looser one.
     *
     * Consulted ONLY for a namespace that names no known venue: see
     * `isContinuousMarket`.
     */
    continuousWeekends?: number | null;
}

/**
 * Namespaces that name a venue which CLOSES, and the AUTHORITATIVE limb of the
 * classification: matching one of these settles the bound at
 * `PRICE_STALENESS_DAYS` and nothing later is consulted.
 *
 * Authoritative because these are the only names in the whole classification
 * that are hard facts rather than inference. `NASDAQ` is not a guess about a
 * venue; it IS the venue, and that venue has a weekend. Every other limb below
 * reasons from something softer — a substring, a ticker, a pattern in a price
 * table — and none of them can be right about a market that is known by name to
 * close. This is what keeps a spot-crypto ETF (namespace NASDAQ, ticker IBIT,
 * and a custodian series that may well carry weekend-dated rows) on the
 * seven-day bound.
 */
const EXCHANGE_TRADED_NAMESPACES = new Set([
    'CURRENCY', 'ISO4217', 'NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'OTC',
    'FUND', 'MUTUAL', 'ETF', 'BOND', 'INDEX', 'TEMPLATE', 'DEMO', 'PRIVATE',
    'LSE', 'TSX', 'TSXV', 'ASX', 'XETRA', 'EURONEXT', 'SIX', 'HKEX', 'TSE',
    'NSE', 'BSE', 'JPX', 'KRX', 'SGX', 'B3',
]);

/**
 * Namespace tokens that name a continuous venue without containing "CRYPTO" or
 * "COIN". Exchanges, mostly — an importer commonly writes the venue it pulled
 * from rather than an asset class.
 */
const CONTINUOUS_NAMESPACE_TOKENS = new Set([
    'BINANCE', 'KRAKEN', 'GEMINI', 'BITSTAMP', 'BITFINEX', 'BITTREX', 'OKX',
    'BYBIT', 'HUOBI', 'UPBIT', 'DEFI', 'TOKEN', 'TOKENS', 'WEB3',
]);

/** Uppercase alphanumeric words of a free-text namespace. */
function namespaceTokens(namespace: string): string[] {
    return namespace.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/**
 * Compound namespaces that read as "continuous" only whole.
 *
 * Each one CONTAINS a word the closing-venue set matches on its own —
 * `CURRENCY`, `ASSET` — and that collision is the entire reason this list
 * exists. It is not a general "this is crypto" list and must not grow into one:
 * a namespace that names continuity without ambiguity belongs in
 * `CONTINUOUS_NAMESPACE_TOKENS`, where it does not outrank a venue.
 *
 * Matched against the namespace with its separators removed, because the phrase
 * arrives as `Digital Currency`, `DigitalCurrency` and `digital-currency`
 * indifferently.
 */
const CONTINUOUS_PHRASES = [
    /DIGITALCURRENC(?:Y|IES)?/g,
    /DIGITALASSETS?/g,
    /VIRTUALCURRENC(?:Y|IES)?/g,
    /VIRTUALASSETS?/g,
];

/**
 * The namespace with every recognised continuous phrase cut out of it, and
 * whether one was there.
 *
 * The phrase is REMOVED rather than allowed to short-circuit the classification,
 * so that it disarms only the words it actually explains. `Digital Currency`
 * leaves nothing behind and the phrase decides; `Digital Currency ETF` leaves
 * `ETF`, which is a venue with a weekend and outranks it. Short-circuiting on
 * the phrase instead would hand the tighter bound to every free-text namespace
 * that happened to contain one, which is precisely what the authoritative
 * closing-venue limb exists to prevent.
 *
 * Cut per token from a map of the joined string: a phrase may SPAN a token
 * boundary (`Digital`+`Currency`), but what survives is rebuilt token by token,
 * so removing one can never splice two neighbouring words into a third.
 */
function stripContinuousPhrases(tokens: string[]): { matched: boolean; remainder: string[] } {
    const joined = tokens.join('');
    const covered = new Array<boolean>(joined.length).fill(false);
    for (const phrase of CONTINUOUS_PHRASES) {
        for (const match of joined.matchAll(phrase)) {
            const start = match.index ?? 0;
            for (let i = start; i < start + match[0].length; i++) covered[i] = true;
        }
    }
    if (!covered.some(Boolean)) return { matched: false, remainder: tokens };

    const remainder: string[] = [];
    let at = 0;
    for (const token of tokens) {
        const kept = token.split('').filter((_, i) => !covered[at + i]).join('');
        if (kept) remainder.push(kept);
        at += token.length;
    }
    return { matched: true, remainder };
}

/**
 * Mnemonics of continuously-traded assets, consulted ONLY when the namespace
 * neither says "continuous" nor names a venue that closes.
 *
 * A convenience for imported books whose namespace is a wallet name, an account
 * label, or blank — not the authority. Deliberately short and unambiguous: every
 * entry is a major continuous-market asset whose ticker is not in use as a US
 * listed equity, so the list cannot quietly re-bound a stock.
 */
const CONTINUOUS_MNEMONICS = new Set([
    'BTC', 'XBT', 'ETH', 'LTC', 'XRP', 'BCH', 'ADA', 'SOL', 'DOT', 'DOGE',
    'USDT', 'USDC', 'DAI', 'MATIC', 'AVAX', 'LINK', 'XMR', 'XLM', 'TRX',
    'SHIB', 'BNB', 'ATOM', 'ALGO', 'ETC', 'FIL', 'UNI', 'AAVE',
]);

/**
 * Whether a commodity trades on a venue that never closes.
 *
 * The reason this is not `namespace === 'CRYPTO'`: nothing enforces that.
 * `commodities.namespace` is a 2048-character free-text column (schema.prisma),
 * `api/commodities` accepts whatever string a client sends, and the namespace
 * box in settings offers a SUGGESTION list, not an enum. Books arrive by import
 * from GnuCash desktop, from other tools, and from hand entry, so the crypto
 * actually in a book may be namespaced `Crypto`, `CRYPTOCURRENCY`, `Coinbase`,
 * `crypto:BTC`, or something nobody anticipated — and every one of those would
 * have silently kept the seven-day exchange bound, which is the defect this
 * function exists to close rather than narrow.
 *
 * So the question is asked in a fixed order, and the ordering principle is
 * SPECIFICITY OF THE NAME, not strength of evidence: a name that identifies a
 * venue outranks any pattern inferred from the price table, because the price
 * table records what this book happens to hold about a commodity, while the
 * namespace records what the commodity IS.
 *
 *   1. AN EXPLICIT CONTINUOUS PHRASE — "digital currency", "virtual asset" — is
 *      CUT OUT of the namespace before anything is asked of it. Not a verdict:
 *      each of these merely CONTAINS a word limb 2 would otherwise misread
 *      (`CURRENCY`, `ASSET`), so removing the phrase is exactly the amount of
 *      protection the ambiguity earns, and no more. See `stripContinuousPhrases`.
 *
 *   2. A NAMESPACE THAT NAMES A VENUE WHICH CLOSES — NASDAQ, NYSE, FUND, ETF,
 *      CURRENCY, ISO4217, a foreign exchange — asked of WHAT SURVIVES that cut.
 *      AUTHORITATIVE: seven days, full stop, and neither the price history nor
 *      the mnemonic is consulted. See `EXCHANGE_TRADED_NAMESPACES` for why this
 *      outranks the evidence. `Digital Currency ETF` and `NASDAQ Virtual Asset
 *      Fund` are shares in funds that trade when their exchange is open, so they
 *      land here; bare `Digital Currency`, which leaves nothing behind, does not.
 *
 *   2a. THE PHRASE ITSELF, once no closing venue survived the cut. Three days.
 *
 *   3. A NAMESPACE THAT NAMES A CONTINUOUS VENUE, read as words rather than
 *      compared whole, so `CRYPTO`, `Cryptocurrency`, `crypto:BTC`, `Coinbase`,
 *      `KRAKEN` and `BITCOIN` all answer the same. Three days.
 *
 * Only when the namespace names NO venue this module recognises — a wallet name,
 * an account label, a bare `Assets`, an empty string — is anything softer
 * consulted:
 *
 *   4. THE PRICE HISTORY, as complete weekends of fetched quotes. Not a count of
 *      weekend-dated rows: see `CONTINUOUS_WEEKEND_EVIDENCE` for the several
 *      ordinary ways a listed instrument accumulates those. One-directional —
 *      the presence of the pattern proves a venue that stayed open, its absence
 *      proves nothing, since a book with four quotes in it has no evidence
 *      either way.
 *
 *   5. THE MNEMONIC, for the imported book whose namespace is a wallet name and
 *      whose price history is too thin to show a cadence.
 *
 * WHICH WAY EACH LIMB FAILS. Uncertainty resolves toward the LOOSER seven-day
 * bound throughout: an unrecognised namespace, an unreadable source, a thin
 * history and an unlisted ticker all end at seven. That is the safe direction
 * because the two errors are not symmetric in the way an earlier version of this
 * comment assumed. A wrong THREE nags a healthy book every week — a listed fund
 * reporting a four-day-old quote as a problem, which is the cry-wolf failure the
 * seven-day figure exists to prevent, and which teaches the reader to ignore the
 * disclosure on the holdings where it is real. A wrong SEVEN merely delays a
 * disclosure by a few days on an instrument nobody could name. Losing a warning
 * late is recoverable; losing the reader's belief in the warning is not.
 */
export function isContinuousMarket(commodity: CommodityMarketInput | null | undefined): boolean {
    if (!commodity) return false;

    const tokens = namespaceTokens(commodity.namespace ?? '');

    // 1. "DIGITAL CURRENCY" and "VIRTUAL ASSET" only read as one thing once the
    // separator is gone, and each contains a word the limb below would match on
    // its own — so the phrase is cut out, and the rest of the namespace is still
    // asked the question.
    const { matched: phrase, remainder } = stripContinuousPhrases(tokens);

    // 2. A named venue with a weekend settles it, and it settles it even when a
    // phrase shared the namespace with it: `Digital Currency ETF` is an ETF.
    // Before the history, not after — this is the limb that keeps a spot-crypto
    // ETF on the exchange bound no matter what its custodian's series looks like.
    if (remainder.some(token => EXCHANGE_TRADED_NAMESPACES.has(token))) return false;

    // 2a. Nothing that closes survived, so the phrase was the whole of it.
    if (phrase) return true;

    // 3. A named venue without one.
    for (const token of remainder) {
        if (token.includes('CRYPTO')) return true;
        // COIN as a word or as either end of one: COIN, COINS, COINBASE,
        // BITCOIN, ALTCOIN, STABLECOIN, LITECOIN.
        if (token.startsWith('COIN') || token.endsWith('COIN') || token.endsWith('COINS')) return true;
        if (CONTINUOUS_NAMESPACE_TOKENS.has(token)) return true;
    }

    // 4 and 5. The namespace named nothing recognisable, so fall back.
    if ((commodity.continuousWeekends ?? 0) >= CONTINUOUS_WEEKEND_EVIDENCE) return true;

    return CONTINUOUS_MNEMONICS.has((commodity.mnemonic ?? '').toUpperCase());
}

/**
 * The bound that applies to one commodity.
 *
 * Anything not determined to be continuous gets the exchange-traded bound. That
 * is right for the namespaces that actually occur (CURRENCY, NASDAQ, NYSE, AMEX,
 * FUND, ETF, BOND …) and the safe direction for one that does not: a disclosure
 * arriving a few days late on an unknown instrument is a smaller failure than one
 * crying wolf every week on something which legitimately quotes weekly.
 */
export function stalenessDaysFor(commodity: CommodityMarketInput | null | undefined): number {
    return isContinuousMarket(commodity)
        ? CONTINUOUS_STALENESS_DAYS
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
 * The moment a quote's age should be judged against: the as-of date, capped at
 * `now`.
 *
 * The as-of date is the right reference for the PAST — a statement drawn as of
 * March 2020 is not stale for being about March 2020. It is the wrong
 * reference for the FUTURE: a valuation drawn as of a date that has not
 * happened yet (a year-to-date dashboard whose range ends December 31) is
 * priced from today's newest quote, and measuring that quote's age against the
 * future end date reported two-day-old prices as 128 days old. A quote cannot
 * be stale relative to a moment at which no newer quote could exist.
 *
 * `now` is a required parameter rather than a `Date.now()` default so this
 * module stays pure: the server passes its valuation moment, a Client
 * Component passes the payload's `generatedAt`.
 */
export function stalenessReferenceTime(
    asOf: Date | string | number,
    now: Date | string | number,
): Date | string | number {
    const asOfTime = toTime(asOf);
    const nowTime = toTime(now);
    if (asOfTime === null || nowTime === null) return asOf;
    return asOfTime <= nowTime ? asOf : now;
}

/**
 * Whole days between a quote and the moment it is being used to value
 * something. Measured against the AS-OF date rather than the wall clock: a
 * statement drawn as of March 2020 is not stale for being about March 2020.
 * Callers valuing a range that can END IN THE FUTURE must clamp the reference
 * through `stalenessReferenceTime` first.
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
 * The same disclosure compressed to fit beside a date in a table cell.
 *
 * It carries the two numbers a reader needs to make sense of a MIXED table, and
 * the reason it carries both: on one screen a three-day-old crypto quote is
 * marked and a three-day-old equity quote is not, and without the bound printed
 * on the row that difference looks arbitrary — or worse, like a bug. The word
 * "stale" alone says a verdict was reached and hides the rule that reached it.
 *
 * Purely visual; the row also carries `stalePriceMessage` for assistive
 * technology, which has room for the sentence.
 */
export function stalePriceMark(ageDays: number, maxAgeDays: number): string {
    return `stale · ${ageDays}d old, limit ${maxAgeDays}d`;
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
