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

    // Sum in a plain number: every term is a safe integer and MAX_SPLITS caps
    // the count at 200, so the total cannot leave the safe-integer range unless
    // an individual term was already near it — and 200 × 2^53 cents is money
    // nobody has.
    const total = splits.reduce((sum, split) => sum + split.amountCents, 0);
    if (total !== 0) {
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
 * Position in the `(enter_date, guid)` stream.
 *
 * `enterDate` is null for the tail of transactions whose `enter_date` column is
 * NULL — GnuCash allows it, and a feed that quietly skipped those rows would
 * lose data permanently rather than visibly. They sort last, matching
 * PostgreSQL's default NULLS LAST for an ascending btree, so the same index
 * serves both phases.
 */
export interface ChangesCursor {
    /** ISO-8601 with milliseconds, or null for the NULL-enter_date tail. */
    enterDate: string | null;
    guid: string;
}

/**
 * Encode a cursor as base64url JSON.
 *
 * Opaque by contract: the client stores it and hands it back, and the encoding
 * is free to change. It is deliberately NOT signed — it names a position in a
 * feed the caller is already authorized to read in full, so forging one buys
 * nothing that a different `since` value would not.
 */
export function encodeChangesCursor(cursor: ChangesCursor): string {
    const json = JSON.stringify({ e: cursor.enterDate, g: cursor.guid });
    return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or null when it is not one we minted.
 *
 * A malformed cursor is a 422 at the call site, never a silent restart from the
 * beginning of the feed: replaying the entire ledger into a sync client because
 * one character was dropped in transit is exactly the failure this rejects.
 */
export function decodeChangesCursor(raw: string): ChangesCursor | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as { e?: unknown; g?: unknown };

    if (typeof candidate.g !== 'string' || !isValidGuid(candidate.g)) return null;
    if (candidate.e === null) return { enterDate: null, guid: candidate.g.toLowerCase() };
    if (typeof candidate.e !== 'string') return null;
    const enterDate = new Date(candidate.e);
    if (Number.isNaN(enterDate.getTime())) return null;

    return { enterDate: enterDate.toISOString(), guid: candidate.g.toLowerCase() };
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
