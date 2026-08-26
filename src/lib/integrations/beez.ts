/**
 * beez-trackz sync contract, v1 — the pure half.
 *
 * Everything here is total, synchronous, and database-free: request-body
 * validation, the exact cents ⇄ GnuCash-fraction conversion, and the opaque
 * change-feed cursor codec. The database orchestration lives in
 * src/lib/services/beez-sync.service.ts and the HTTP shell in
 * src/app/api/integrations/beez/*.
 *
 * Splitting it this way is not decoration: these are the rules a caller can
 * violate, so they are the rules that need exhaustive unit tests, and none of
 * them should need a Postgres server to assert.
 *
 * ## Why integer cents, and why only integer cents
 *
 * GnuCash stores every amount as a `num/denom` rational, and the denominator is
 * NOT always a power of ten — `impliedPriceFraction()` writes GCD-reduced
 * fractions, so a split can legitimately carry 1/3. There is no lossless
 * decimal string for such a value, and rounding one into cents would silently
 * invent money.
 *
 * v1 therefore refuses to guess in either direction:
 *
 *  - WRITES take integer `amountCents` and store the exact fraction
 *    `amountCents/100`. Nothing is parsed from a decimal string, so nothing can
 *    be misparsed.
 *  - READS (the change feed) convert a stored fraction to cents ONLY when the
 *    conversion is exact. Anything else is reported as `unrepresentable`, with
 *    no splits, so beez surfaces it as a conflict for a human instead of
 *    receiving a rounded number it would then write back as truth.
 *
 * Never reconstruct a decimal here by string-padding against the denominator's
 * digit count — see the numeric-handling note in CLAUDE.md.
 */

import { isValidGuid } from '@/lib/guid';

/** `gnucash_web_external_links.source` for every row this integration owns. */
export const BEEZ_SOURCE = 'beez-trackz';

/** `gnucash_web_transaction_meta.source` stamped on transactions we write. */
export const BEEZ_META_SOURCE = 'beez-trackz';

/** Matches the `external_id VARCHAR(200)` column. */
export const MAX_EXTERNAL_ID_LENGTH = 200;

/** `transactions.description` / `transactions.num` are VARCHAR(2048). */
const MAX_TEXT_LENGTH = 2048;

/** `splits.memo` is VARCHAR(2048) too. */
const MAX_MEMO_LENGTH = 2048;

/**
 * A ceiling on splits per transaction. Not an accounting rule — a bound on how
 * much work one unauthenticated-shaped request can queue inside a single
 * database transaction. Real beez records are two- to five-sided.
 */
export const MAX_SPLITS = 200;

/** v1 writes cents, so every stored value carries this denominator. */
export const CENTS_DENOM = 100n;

export const DEFAULT_CHANGES_LIMIT = 100;
export const MAX_CHANGES_LIMIT = 500;

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface BeezSplitInput {
    accountGuid: string;
    /** Signed integer cents. Debits positive, credits negative, sum exactly 0. */
    amountCents: number;
    memo: string;
}

export interface BeezTransactionInput {
    /** Present on POST (where the caller names the record), absent on PUT. */
    externalId: string | null;
    /** Calendar date, `YYYY-MM-DD`. */
    postDate: string;
    description: string;
    num: string;
    splits: BeezSplitInput[];
}

export type BeezParseResult =
    | { ok: true; data: BeezTransactionInput }
    /** `error` is the machine code; `detail` is the sentence a human reads. */
    | { ok: false; error: 'validation' | 'unbalanced'; detail: string };

function fail(detail: string, error: 'validation' | 'unbalanced' = 'validation'): BeezParseResult {
    return { ok: false, error, detail };
}

/**
 * `YYYY-MM-DD` that names a real calendar day.
 *
 * The round-trip through Date is the point: `2026-02-30` matches the regexp and
 * parses without throwing, but comes back as March 2nd. Accepting it would post
 * a transaction to a date the caller never asked for.
 */
export function isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.toISOString().slice(0, 10) === value;
}

/**
 * Midday UTC for a calendar date, matching the inbound-webhook convention.
 * Noon keeps the stored timestamp on the intended day under any server or
 * client timezone offset, which midnight does not.
 */
export function postDateToTimestamp(postDate: string): Date {
    return new Date(`${postDate}T12:00:00Z`);
}

/** `YYYY-MM-DD` for a stored post_date timestamp, read in UTC. */
export function timestampToPostDate(value: Date | null): string | null {
    if (!value || Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
}

function readOptionalText(raw: unknown, field: string, max: number): { ok: true; value: string } | { ok: false; detail: string } {
    if (raw === undefined || raw === null) return { ok: true, value: '' };
    if (typeof raw !== 'string') return { ok: false, detail: `${field}: must be a string` };
    if (raw.length > max) return { ok: false, detail: `${field}: must be at most ${max} characters` };
    return { ok: true, value: raw };
}

/**
 * Validate a POST/PUT body against the v1 contract.
 *
 * `requireExternalId` is the only difference between the two verbs: POST names
 * the record in the body, PUT names it in the path. A PUT body that carries an
 * `externalId` anyway is rejected rather than ignored — silently dropping it
 * would let a caller believe it had renamed a link.
 */
export function parseBeezTransactionInput(
    body: unknown,
    options: { requireExternalId: boolean },
): BeezParseResult {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return fail('body: must be a JSON object');
    }
    const raw = body as Record<string, unknown>;

    let externalId: string | null = null;
    if (options.requireExternalId) {
        if (typeof raw.externalId !== 'string') {
            return fail('externalId: required, must be a string');
        }
        externalId = raw.externalId.trim();
        if (externalId.length === 0) {
            return fail('externalId: must not be empty');
        }
        if (externalId.length > MAX_EXTERNAL_ID_LENGTH) {
            return fail(`externalId: must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`);
        }
    } else if (raw.externalId !== undefined) {
        return fail('externalId: not accepted here — the external id is the path segment');
    }

    if (typeof raw.postDate !== 'string' || !isCalendarDate(raw.postDate)) {
        return fail('postDate: required, must be a YYYY-MM-DD calendar date');
    }
    const postDate = raw.postDate;

    if (typeof raw.description !== 'string') {
        return fail('description: required, must be a string');
    }
    if (raw.description.length > MAX_TEXT_LENGTH) {
        return fail(`description: must be at most ${MAX_TEXT_LENGTH} characters`);
    }
    const description = raw.description;

    const num = readOptionalText(raw.num, 'num', MAX_TEXT_LENGTH);
    if (!num.ok) return fail(num.detail);

    if (!Array.isArray(raw.splits)) {
        return fail('splits: required, must be an array');
    }
    if (raw.splits.length < 2) {
        return fail('splits: a balanced transaction needs at least 2 splits');
    }
    if (raw.splits.length > MAX_SPLITS) {
        return fail(`splits: at most ${MAX_SPLITS} splits per transaction`);
    }

    const splits: BeezSplitInput[] = [];
    for (const [index, entry] of raw.splits.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return fail(`splits[${index}]: must be an object`);
        }
        const split = entry as Record<string, unknown>;

        if (typeof split.accountGuid !== 'string' || !isValidGuid(split.accountGuid)) {
            return fail(`splits[${index}].accountGuid: must be a 32-character hex GUID`);
        }
        if (typeof split.amountCents !== 'number' || !Number.isSafeInteger(split.amountCents)) {
            return fail(`splits[${index}].amountCents: must be an integer number of cents`);
        }
        const memo = readOptionalText(split.memo, `splits[${index}].memo`, MAX_MEMO_LENGTH);
        if (!memo.ok) return fail(memo.detail);

        splits.push({
            // GnuCash guids are stored lowercase; normalizing here means the
            // book-membership check and the insert agree on one spelling.
            accountGuid: split.accountGuid.toLowerCase(),
            amountCents: split.amountCents,
            memo: memo.value,
        });
    }

    // Sum in BigInt, never in a plain number. Every TERM is a safe integer, but
    // the running TOTAL is not bounded by that: with 200 splits allowed, the
    // intermediate can leave the safe-integer range and round, and a rounded
    // total can land on 0 for a set whose exact sum is not 0. Concretely,
    //   [9007199254740991, 9007199254740990, -9007199254740991, -9007199254740989]
    // float-reduces to 0 while the exact sum is 1 — an off-by-one-cent
    // unbalanced transaction that would persist as if it balanced. BigInt has
    // no such range, so the check is exact for every input the loop above
    // accepted.
    let total = 0n;
    for (const split of splits) total += BigInt(split.amountCents);
    if (total !== 0n) {
        return fail(`splits: must sum to exactly 0 cents, got ${total}`, 'unbalanced');
    }

    return { ok: true, data: { externalId, postDate, description, num: num.value, splits } };
}

// ---------------------------------------------------------------------------
// Cents ⇄ GnuCash fractions
// ---------------------------------------------------------------------------

/**
 * A stored `num/denom` value in exact integer cents, or null when no such
 * integer exists.
 *
 * The test is `denom` divides 100 — deliberately conservative, and deliberately
 * NOT "is the value a whole number of cents". 1234/1000 (1.234) has no cents
 * representation and must be refused; 1000/1000 (1.000) does, but is refused
 * too. Accepting the second case means asking whether `num × 100` is divisible
 * by `denom`, which admits a whole family of denominators whose OTHER values
 * are not representable, and the feed would then flip an account between
 * "syncable" and "conflict" from one transaction to the next. One fixed rule
 * per denominator is the property worth having; a book that genuinely uses
 * milli-unit denominators is out of scope for v1 and is told so.
 *
 * A zero or negative denominator is undefined rather than merely coarse, and is
 * rejected by the same gate.
 */
export function splitValueToCents(num: bigint, denom: bigint): number | null {
    if (denom <= 0n) return null;
    if (CENTS_DENOM % denom !== 0n) return null;
    const cents = num * (CENTS_DENOM / denom);
    // Beyond 2^53 the caller's JSON number would no longer be the value we
    // read, so report it as unrepresentable rather than hand back a lie.
    if (cents > 9007199254740991n || cents < -9007199254740991n) return null;
    return Number(cents);
}

/** True when every split of a transaction can be stated exactly in cents. */
export function allSplitsRepresentable(
    splits: Array<{ value_num: bigint; value_denom: bigint }>,
): boolean {
    return splits.every(split => splitValueToCents(split.value_num, split.value_denom) !== null);
}

// ---------------------------------------------------------------------------
// Change-feed cursor
// ---------------------------------------------------------------------------

/**
 * The `to_char` format the feed reads `enter_date` with, and the only spelling
 * a cursor ever carries: `YYYY-MM-DDTHH:MM:SS.uuuuuu`, microseconds included.
 *
 * The precision is the whole point. `transactions.enter_date` is
 * `TIMESTAMP(6)`, so a row can sit at `…:56.123456`. A cursor that round-tripped
 * through a JavaScript `Date` would truncate to `…:56.123`, and the row would
 * then satisfy `enter_date > cursor` on every single poll — an item that
 * re-emits forever. Reading and writing the raw database string keeps the
 * comparison exact, so a row is delivered once and then falls behind the
 * watermark for good.
 */
export const ENTER_DATE_PG_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';

/**
 * `2026-08-25T12:34:56.123456` — exactly what {@link ENTER_DATE_PG_FORMAT}
 * emits, captured so the calendar fields can be range-checked individually.
 */
const ENTER_DATE_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}$/;

/** Days in a month, proleptic-Gregorian, which is the calendar PostgreSQL uses. */
function daysInMonth(year: number, month: number): number {
    if (month === 2) {
        const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leap ? 29 : 28;
    }
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * True for a microsecond timestamp string in the feed's own spelling AND a real
 * instant on the calendar.
 *
 * Shape alone is not enough. `2026-99-99T99:99:99.999999` matches the digit
 * layout perfectly, and a shape-only gate handed it straight to the
 * `::timestamp` cast in the feed query, where PostgreSQL raised
 * `date/time field value out of range` and the caller got a 500 for what is
 * plainly a malformed cursor. So the fields are range-checked here, arithmetic
 * only — deliberately NOT by round-tripping through `new Date()`, which would
 * both accept the rollover spellings JavaScript tolerates and truncate the
 * microseconds this format exists to preserve.
 *
 * Year 0 is rejected because PostgreSQL has no year zero either.
 */
export function isEnterDateStamp(value: string): boolean {
    const match = ENTER_DATE_PATTERN.exec(value);
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    if (year < 1 || month < 1 || month > 12) return false;
    if (day < 1 || day > daysInMonth(year, month)) return false;
    // No leap seconds: PostgreSQL rejects :60 in a timestamp literal too.
    return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Position in the change feed: a HIGH WATERMARK and a SWEEP POSITION in the
 * `(enter_date, guid)` stream, plus a separate watermark in the guid-ordered
 * set of NULL-`enter_date` rows.
 *
 * TWO FIELDS FOR ONE STREAM, because the feed does not scan strictly forward.
 * Most writers in this repository stamp a bare clock and can land below an
 * already-issued watermark, so a drained sweep restarts `BEEZ_FEED_OVERLAP`
 * below the high watermark and re-reads that band (see src/lib/enter-date.ts).
 * Doing that with ONE field would deadlock the moment the band held more rows
 * than `limit`: every poll would re-read the same first page, re-issue the same
 * position, and never reach the rest. So the high watermark records what has
 * been SEEN (monotone, never rewinds) while the sweep position records where
 * the current pass has READ (advances within a pass, cleared when it drains).
 * Progress is then guaranteed — a pass strictly advances and therefore
 * terminates — while the pass after it still starts low enough to catch a
 * late-landing write.
 *
 * TWO STREAMS, because there are genuinely two. `enter_date` is nullable in
 * GnuCash, and a row without one has no position in a time order at all. The
 * original design seated it in the time watermark anyway — a cursor that said
 * "NULL tail" — and that lost data: once a client consumed a NULL row, every
 * subsequent transaction with a normal `enter_date` sorted BEFORE that cursor
 * and was skipped forever. The second design made the NULL set always-emitted
 * and unpaged, which lost data too, just more quietly: with more NULL rows than
 * `limit`, the same guid-ordered prefix came back on every poll and the tail was
 * never reachable.
 *
 * So both streams page, independently:
 *
 * - `enterDate`/`guid` — the time watermark. Both are set, or both are null,
 *   and null means "the ordered stream has not started yet", NOT "the NULL
 *   tail". They move forward only.
 * - `nullGuid` — how far into the guid-ordered NULL set this client has read.
 *   It advances while that set has more, and RESETS to null the moment the set
 *   drains.
 *
 * WHY THE RESET. A NULL row carries no time information, so when one appears
 * later its guid is as likely to sort below an advanced watermark as above it —
 * there is no "after" to scan from. Restarting the set on every drained pass is
 * what makes such a row reachable: the watermark strictly advances while rows
 * remain, so the drain always terminates, and the pass after it starts from the
 * beginning and sees whatever arrived behind it. The cost is that a fully
 * drained NULL set is re-emitted on the next poll — bounded repetition, exactly
 * the deal the deletion tombstones already make, and the reason the endpoint
 * requires idempotent apply by `transactionGuid`.
 */
export interface ChangesCursor {
    /**
     * The HIGH WATERMARK: the greatest `(enter_date, guid)` this client has ever
     * been sent. Monotone — it never moves backwards, even when a sweep
     * re-emits rows below it. Null before the stream starts.
     */
    enterDate: string | null;
    /** Tie-break guid at {@link ChangesCursor.enterDate}; null exactly when that is null. */
    guid: string | null;
    /** Position in the guid-ordered NULL-`enter_date` set, or null for its start. */
    nullGuid: string | null;
    /**
     * The SWEEP POSITION: how far the current pass has read, or null when the
     * last pass drained and the next one starts fresh from
     * `enterDate - BEEZ_FEED_OVERLAP`.
     *
     * Paired with {@link ChangesCursor.sweepGuid} exactly as `enterDate` is
     * with `guid`.
     */
    sweepEnterDate: string | null;
    /** Tie-break guid at {@link ChangesCursor.sweepEnterDate}; null exactly when that is null. */
    sweepGuid: string | null;
}

/**
 * Encode a cursor as base64url JSON.
 *
 * Opaque by contract: the client stores it and hands it back, and the encoding
 * is free to change. It is deliberately NOT signed — it names a position in a
 * feed the caller is already authorized to read in full, so forging one buys
 * nothing that a different `since` value would not.
 *
 * All five keys are always written, so an unchanged position re-encodes to a
 * byte-identical string and a client can compare cursors for equality.
 */
export function encodeChangesCursor(cursor: ChangesCursor): string {
    const json = JSON.stringify({
        e: cursor.enterDate,
        g: cursor.guid,
        n: cursor.nullGuid,
        se: cursor.sweepEnterDate,
        sg: cursor.sweepGuid,
    });
    return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or null when it is not one we minted.
 *
 * A malformed cursor is a 422 at the call site, never a silent restart from the
 * beginning of the feed: replaying the entire ledger into a sync client because
 * one character was dropped in transit is exactly the failure this rejects.
 *
 * `e` and `g` stand or fall together. That pairing is what still rejects the
 * retired NULL-tail encoding (`{ e: null, g: <guid> }`), whose position skipped
 * rows and must not be resumable, while admitting the new "NULL set only"
 * position (`{ e: null, g: null, n: <guid> }`). A cursor naming no position at
 * all is not one this endpoint issued, so it is refused rather than treated as
 * the start of the feed.
 */
export function decodeChangesCursor(raw: string): ChangesCursor | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as { e?: unknown; g?: unknown; n?: unknown; se?: unknown; sg?: unknown };

    let nullGuid: string | null = null;
    if (candidate.n !== undefined && candidate.n !== null) {
        if (typeof candidate.n !== 'string' || !isValidGuid(candidate.n)) return null;
        nullGuid = candidate.n.toLowerCase();
    }

    // The sweep position obeys the same pairing rule as the high watermark, and
    // is simply absent on a cursor issued before the overlap existed — such a
    // cursor decodes to "start a fresh sweep", which re-reads the overlap band
    // once. Bounded repetition on upgrade, never a skip.
    const sweep = readPosition(candidate.se, candidate.sg);
    if (sweep === null) return null;

    const hasEnterDate = candidate.e !== undefined && candidate.e !== null;
    const hasGuid = candidate.g !== undefined && candidate.g !== null;
    if (hasEnterDate !== hasGuid) return null;

    if (!hasEnterDate) {
        // No high watermark means no floor to sweep down from, so a sweep
        // position here names nothing this endpoint could have issued.
        if (nullGuid === null || sweep.enterDate !== null) return null;
        return { enterDate: null, guid: null, nullGuid, sweepEnterDate: null, sweepGuid: null };
    }

    if (typeof candidate.g !== 'string' || !isValidGuid(candidate.g)) return null;
    // No `new Date(...)` anywhere on this path: constructing one would discard
    // the microseconds this cursor exists to preserve, and would accept
    // out-of-range fields by rolling them over instead of refusing them.
    if (typeof candidate.e !== 'string' || !isEnterDateStamp(candidate.e)) return null;

    return {
        enterDate: candidate.e,
        guid: candidate.g.toLowerCase(),
        nullGuid,
        sweepEnterDate: sweep.enterDate,
        sweepGuid: sweep.guid,
    };
}

/**
 * A `(enter_date, guid)` pair from two raw JSON fields, or null when the pair is
 * not one this endpoint mints: half-present, malformed, or naming an instant
 * that does not exist. An absent pair is the valid `{ enterDate: null }`.
 */
function readPosition(
    rawStamp: unknown,
    rawGuid: unknown,
): { enterDate: string | null; guid: string | null } | null {
    const hasStamp = rawStamp !== undefined && rawStamp !== null;
    const hasGuid = rawGuid !== undefined && rawGuid !== null;
    if (hasStamp !== hasGuid) return null;
    if (!hasStamp) return { enterDate: null, guid: null };
    if (typeof rawStamp !== 'string' || !isEnterDateStamp(rawStamp)) return null;
    if (typeof rawGuid !== 'string' || !isValidGuid(rawGuid)) return null;
    return { enterDate: rawStamp, guid: rawGuid.toLowerCase() };
}

export type LimitParseResult =
    | { ok: true; limit: number }
    | { ok: false; detail: string };

/**
 * Parse `?limit=`. Absent means the default; present-but-malformed is an error,
 * never a fallback — a client that asked for 1000 rows should learn it cannot
 * have them rather than silently receive 100 and conclude it is caught up.
 */
export function parseChangesLimit(raw: string | null): LimitParseResult {
    if (raw === null || raw === '') return { ok: true, limit: DEFAULT_CHANGES_LIMIT };
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        return { ok: false, detail: `limit: "${raw}" is not a non-negative integer` };
    }
    const limit = Number.parseInt(trimmed, 10);
    if (limit < 1) return { ok: false, detail: 'limit: must be at least 1' };
    if (limit > MAX_CHANGES_LIMIT) {
        return { ok: false, detail: `limit: must be at most ${MAX_CHANGES_LIMIT}` };
    }
    return { ok: true, limit };
}
