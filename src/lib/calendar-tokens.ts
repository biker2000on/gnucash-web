/**
 * Calendar Feed Tokens
 *
 * Per-user feed tokens for the public iCal endpoint /api/calendar/[token].
 * The token IS the auth: the URL is a capability. Only the SHA-256 hash of
 * the secret is stored (plaintext shown exactly once at creation); an 8-char
 * prefix is kept for display. Each token is pinned to the book that was
 * active when it was created and carries the event types it exposes.
 *
 * Lazy table via the advisory-lock pattern (same as backup.ts / api-tokens.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import prisma from '@/lib/prisma';
import { CALENDAR_EVENT_TYPES, type CalendarEventType } from '@/lib/ical';

const TOKEN_FORMAT = /^[0-9a-f]{48}$/;

export interface CalendarFeedTokenRecord {
    id: number;
    userId: number;
    bookGuid: string;
    prefix: string;
    eventTypes: CalendarEventType[];
    createdAt: Date;
    revokedAt: Date | null;
}

export interface ResolvedCalendarToken {
    tokenId: number;
    userId: number;
    bookGuid: string;
    eventTypes: CalendarEventType[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Generate a fresh feed token secret: 48 lowercase hex chars (24 random bytes). */
export function generateCalendarTokenSecret(): string {
    return randomBytes(24).toString('hex');
}

/** SHA-256 hex digest of the token secret. */
export function hashCalendarToken(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** True when the string looks like a well-formed feed token. */
export function isValidCalendarTokenFormat(secret: string): boolean {
    return TOKEN_FORMAT.test(secret);
}

/** Constant-time comparison of two hex digests. */
function constantTimeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/** Parse a stored event-type list; unknown entries dropped, empty ⇒ all types. */
export function parseCalendarEventTypes(raw: unknown): CalendarEventType[] {
    if (Array.isArray(raw)) {
        const valid = raw.filter(
            (t): t is CalendarEventType => CALENDAR_EVENT_TYPES.includes(t as CalendarEventType),
        );
        if (valid.length > 0) return [...new Set(valid)];
    }
    return [...CALENDAR_EVENT_TYPES];
}

// ---------------------------------------------------------------------------
// Lazy table creation (advisory-lock pattern)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureCalendarTokensTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_calendar_tokens_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_calendar_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                    book_guid VARCHAR(32) NOT NULL,
                    token_hash CHAR(64) NOT NULL UNIQUE,
                    prefix VARCHAR(16) NOT NULL,
                    event_types JSONB NOT NULL DEFAULT '["scheduled","fixed_income","rmd","compliance","renewal","home","invoice","goal","equity_comp","report_schedule","plan"]'::jsonb,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    revoked_at TIMESTAMP
                  );

                  CREATE INDEX IF NOT EXISTS idx_calendar_tokens_user
                    ON gnucash_web_calendar_tokens(user_id, created_at DESC);
                END $$;
            `);
        })();
        // Allow retry after a transient failure instead of caching the rejection.
        ensurePromise.catch(() => { ensurePromise = null; });
    }
    return ensurePromise;
}

// ---------------------------------------------------------------------------
// CRUD + resolution
// ---------------------------------------------------------------------------

interface CalendarTokenRow {
    id: number;
    user_id: number;
    book_guid: string;
    token_hash: string;
    prefix: string;
    event_types: unknown;
    created_at: Date;
    revoked_at: Date | null;
}

function rowToRecord(row: CalendarTokenRow): CalendarFeedTokenRecord {
    return {
        id: row.id,
        userId: row.user_id,
        bookGuid: row.book_guid,
        prefix: row.prefix,
        eventTypes: parseCalendarEventTypes(row.event_types),
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
    };
}

/**
 * Create a feed token. Returns the record AND the plaintext secret — this is
 * the ONLY time the secret is available; only its hash is persisted.
 */
export async function createCalendarFeedToken(
    userId: number,
    bookGuid: string,
    eventTypes: unknown,
): Promise<{ token: CalendarFeedTokenRecord; secret: string }> {
    await ensureCalendarTokensTable();

    const types = parseCalendarEventTypes(eventTypes);
    const secret = generateCalendarTokenSecret();
    const tokenHash = hashCalendarToken(secret);
    const prefix = secret.slice(0, 8);

    const rows = await prisma.$queryRaw<CalendarTokenRow[]>`
        INSERT INTO gnucash_web_calendar_tokens
            (user_id, book_guid, token_hash, prefix, event_types)
        VALUES
            (${userId}, ${bookGuid}, ${tokenHash}, ${prefix}, ${JSON.stringify(types)}::jsonb)
        RETURNING id, user_id, book_guid, token_hash, prefix, event_types, created_at, revoked_at
    `;

    return { token: rowToRecord(rows[0]), secret };
}

/** List a user's active (non-revoked) feed tokens. Never returns the hash. */
export async function listCalendarFeedTokens(userId: number): Promise<CalendarFeedTokenRecord[]> {
    await ensureCalendarTokensTable();
    const rows = await prisma.$queryRaw<CalendarTokenRow[]>`
        SELECT id, user_id, book_guid, token_hash, prefix, event_types, created_at, revoked_at
        FROM gnucash_web_calendar_tokens
        WHERE user_id = ${userId} AND revoked_at IS NULL
        ORDER BY created_at DESC
    `;
    return rows.map(rowToRecord);
}

/** Revoke a feed token (scoped to the owning user). Returns true when a row changed. */
export async function revokeCalendarFeedToken(userId: number, tokenId: number): Promise<boolean> {
    await ensureCalendarTokensTable();
    const count = await prisma.$executeRaw`
        UPDATE gnucash_web_calendar_tokens
        SET revoked_at = NOW()
        WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
    `;
    return count > 0;
}

/**
 * Resolve a feed URL token to its user/book/event-type selection.
 * Returns null for malformed, unknown, or revoked tokens.
 */
export async function resolveCalendarFeedToken(secret: string): Promise<ResolvedCalendarToken | null> {
    if (!isValidCalendarTokenFormat(secret)) return null;
    await ensureCalendarTokensTable();

    const tokenHash = hashCalendarToken(secret);
    const rows = await prisma.$queryRaw<CalendarTokenRow[]>`
        SELECT id, user_id, book_guid, token_hash, prefix, event_types, created_at, revoked_at
        FROM gnucash_web_calendar_tokens
        WHERE token_hash = ${tokenHash}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    // Defense-in-depth: constant-time re-check of the hash we matched on.
    if (!constantTimeEqualHex(row.token_hash.trim(), tokenHash)) return null;
    if (row.revoked_at) return null;

    return {
        tokenId: row.id,
        userId: row.user_id,
        bookGuid: row.book_guid,
        eventTypes: parseCalendarEventTypes(row.event_types),
    };
}
