/**
 * API Tokens (Personal Access Tokens)
 *
 * Bearer tokens of the form `gcw_<32 hex chars>` that authenticate API
 * requests without a browser session. Only the SHA-256 hash of the secret is
 * stored — the plaintext is shown exactly once at creation time.
 *
 * A token carries its own role ('readonly' | 'edit') and an optional book
 * scope. The effective role of a token-authenticated request is ALWAYS capped
 * at both the token's role and the user's actual role for the book — a token
 * can narrow a user's permissions, never widen them.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import prisma from '@/lib/prisma';
import { getUserRoleForBook, type Role } from '@/lib/services/permission.service';

export const TOKEN_PREFIX = 'gcw_';

/** Roles a token may carry. Tokens can never carry 'admin'. */
export type TokenRole = 'readonly' | 'edit';

const TOKEN_FORMAT = /^gcw_[0-9a-f]{32}$/;

// Only the linear financial hierarchy — 'timekeeper' (and any unknown role)
// is deliberately absent so capRole() fails closed for it.
const ROLE_HIERARCHY: Record<string, number> = { readonly: 0, edit: 1, admin: 2 };

export interface ApiTokenRecord {
    id: number;
    userId: number;
    name: string;
    prefix: string;
    role: TokenRole;
    bookGuid: string | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    revokedAt: Date | null;
}

export interface ResolvedToken {
    tokenId: number;
    userId: number;
    role: TokenRole;
    bookGuid: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Generate a fresh token secret: `gcw_` + 32 lowercase hex chars (16 random bytes). */
export function generateTokenSecret(): string {
    return TOKEN_PREFIX + randomBytes(16).toString('hex');
}

/** SHA-256 hex digest of the full token secret (including the `gcw_` prefix). */
export function hashToken(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** True when the string looks like a well-formed token secret. */
export function isValidTokenFormat(secret: string): boolean {
    return TOKEN_FORMAT.test(secret);
}

/**
 * Extract a `gcw_...` token from an Authorization header value.
 * Returns null when the header is missing, not a Bearer scheme, or the token
 * is not one of ours.
 */
export function parseBearerToken(authorizationHeader: string | null | undefined): string | null {
    if (!authorizationHeader) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
    if (!match) return null;
    return match[1].startsWith(TOKEN_PREFIX) ? match[1] : null;
}

/**
 * Effective role for a token-authenticated request: the LOWER of the token's
 * role and the user's actual role for the book. Returns null when the user
 * has no role at all (no access ⇒ token grants nothing).
 */
export function capRole(tokenRole: TokenRole, userBookRole: Role | null): Role | null {
    if (!userBookRole) return null;
    const userRank = ROLE_HIERARCHY[userBookRole];
    // Fail closed: roles outside the financial hierarchy ('timekeeper',
    // unknown names) grant a token nothing at all.
    if (userRank === undefined) return null;
    return ROLE_HIERARCHY[tokenRole] <= userRank ? tokenRole : userBookRole;
}

/** Constant-time comparison of two equal-purpose hex digest strings. */
export function constantTimeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Lazy table creation (advisory-lock pattern, same as notifications.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureApiTokensTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_api_tokens_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_api_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                    name VARCHAR(100) NOT NULL,
                    token_hash CHAR(64) NOT NULL UNIQUE,
                    prefix VARCHAR(16) NOT NULL,
                    role VARCHAR(20) NOT NULL DEFAULT 'readonly',
                    book_guid VARCHAR(32),
                    expires_at TIMESTAMP,
                    last_used_at TIMESTAMP,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    revoked_at TIMESTAMP
                  );

                  CREATE INDEX IF NOT EXISTS idx_api_tokens_user
                    ON gnucash_web_api_tokens(user_id, created_at DESC);
                END $$;
            `);
        })();
        // Allow retry after a transient failure instead of caching the rejection.
        ensurePromise.catch(() => { ensurePromise = null; });
    }
    return ensurePromise;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

interface TokenRow {
    id: number;
    user_id: number;
    name: string;
    token_hash: string;
    prefix: string;
    role: string;
    book_guid: string | null;
    expires_at: Date | null;
    last_used_at: Date | null;
    created_at: Date;
    revoked_at: Date | null;
}

function rowToRecord(row: TokenRow): ApiTokenRecord {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        prefix: row.prefix,
        role: (row.role === 'edit' ? 'edit' : 'readonly'),
        bookGuid: row.book_guid,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
    };
}

export interface CreateTokenInput {
    name: string;
    role: TokenRole;
    /** null ⇒ the token follows the user's default (first accessible) book. */
    bookGuid?: string | null;
    expiresAt?: Date | null;
}

/**
 * Create a token. Returns the record AND the plaintext secret — this is the
 * ONLY time the secret is available; only its hash is persisted.
 */
export async function createToken(
    userId: number,
    input: CreateTokenInput
): Promise<{ token: ApiTokenRecord; secret: string }> {
    await ensureApiTokensTable();

    const name = input.name.trim().slice(0, 100);
    if (!name) throw new Error('Token name is required');
    const role: TokenRole = input.role === 'edit' ? 'edit' : 'readonly';

    const secret = generateTokenSecret();
    const tokenHash = hashToken(secret);
    const prefix = secret.slice(0, 8); // e.g. "gcw_ab12"

    const rows = await prisma.$queryRaw<TokenRow[]>`
        INSERT INTO gnucash_web_api_tokens
            (user_id, name, token_hash, prefix, role, book_guid, expires_at)
        VALUES
            (${userId}, ${name}, ${tokenHash}, ${prefix}, ${role},
             ${input.bookGuid || null}, ${input.expiresAt || null})
        RETURNING id, user_id, name, token_hash, prefix, role, book_guid,
                  expires_at, last_used_at, created_at, revoked_at
    `;

    return { token: rowToRecord(rows[0]), secret };
}

/** List a user's tokens (never returns the hash; revoked tokens excluded). */
export async function listTokens(userId: number): Promise<ApiTokenRecord[]> {
    await ensureApiTokensTable();
    const rows = await prisma.$queryRaw<TokenRow[]>`
        SELECT id, user_id, name, token_hash, prefix, role, book_guid,
               expires_at, last_used_at, created_at, revoked_at
        FROM gnucash_web_api_tokens
        WHERE user_id = ${userId} AND revoked_at IS NULL
        ORDER BY created_at DESC
    `;
    return rows.map(rowToRecord);
}

/** Revoke a token (scoped to the owning user). Returns true when a row changed. */
export async function revokeToken(userId: number, tokenId: number): Promise<boolean> {
    await ensureApiTokensTable();
    const count = await prisma.$executeRaw`
        UPDATE gnucash_web_api_tokens
        SET revoked_at = NOW()
        WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
    `;
    return count > 0;
}

// ---------------------------------------------------------------------------
// Resolution (used by the auth layer)
// ---------------------------------------------------------------------------

/**
 * Resolve a bearer secret to its token. Returns null for malformed, unknown,
 * revoked, or expired tokens. Best-effort last_used_at update, throttled to
 * once per minute so hot API clients don't hammer the table.
 */
export async function resolveToken(bearer: string): Promise<ResolvedToken | null> {
    if (!isValidTokenFormat(bearer)) return null;
    await ensureApiTokensTable();

    const tokenHash = hashToken(bearer);
    const rows = await prisma.$queryRaw<TokenRow[]>`
        SELECT id, user_id, name, token_hash, prefix, role, book_guid,
               expires_at, last_used_at, created_at, revoked_at
        FROM gnucash_web_api_tokens
        WHERE token_hash = ${tokenHash}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    // Defense-in-depth: constant-time re-check of the hash we matched on.
    if (!constantTimeEqualHex(row.token_hash.trim(), tokenHash)) return null;

    if (row.revoked_at) return null;
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null;

    // Best-effort usage timestamp, throttled server-side to 1/min.
    prisma.$executeRaw`
        UPDATE gnucash_web_api_tokens
        SET last_used_at = NOW()
        WHERE id = ${row.id}
          AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')
    `.catch(() => undefined);

    return {
        tokenId: row.id,
        userId: row.user_id,
        role: row.role === 'edit' ? 'edit' : 'readonly',
        bookGuid: row.book_guid,
    };
}

/**
 * Full bearer authentication used by requireRole():
 *   secret → token → user → book → effective (capped) role.
 * Returns null when the token is invalid or grants no access.
 */
export async function authenticateBearer(bearer: string): Promise<
    { user: { id: number; username: string }; role: Role; bookGuid: string } | null
> {
    const resolved = await resolveToken(bearer);
    if (!resolved) return null;

    const user = await prisma.gnucash_web_users.findUnique({
        where: { id: resolved.userId },
        select: { id: true, username: true },
    });
    if (!user) return null;

    // Token book, or the user's default (first accessible) book.
    let bookGuid = resolved.bookGuid;
    if (!bookGuid) {
        const firstPermission = await prisma.gnucash_web_book_permissions.findFirst({
            where: { user_id: user.id },
            orderBy: { granted_at: 'asc' },
            select: { book_guid: true },
        });
        bookGuid = firstPermission?.book_guid ?? null;
    }
    if (!bookGuid) return null;

    const userRole = await getUserRoleForBook(user.id, bookGuid);
    const effectiveRole = capRole(resolved.role, userRole);
    if (!effectiveRole) return null;

    return { user, role: effectiveRole, bookGuid };
}
