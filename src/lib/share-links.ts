/**
 * Accountant Share Links
 *
 * Time-boxed, read-only share links: `/share/<secret>` renders a self-contained
 * report bundle (balance sheet, income statement YTD, net worth summary) as a
 * public server-rendered page. A link never grants app access — the page calls
 * the report libs directly and shows only the sections selected at creation.
 *
 * Secrets are `share_<32 hex chars>`; only the SHA-256 hash is stored, the
 * plaintext is shown exactly once at creation. Storage follows the lazy-table
 * + advisory-lock pattern from backup.ts / api-tokens.ts.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import prisma from '@/lib/prisma';

export const SHARE_TOKEN_PREFIX = 'share_';

const SHARE_TOKEN_FORMAT = /^share_[0-9a-f]{32}$/;

/** Sections a share link can include, in canonical display order. */
export const SHARE_SECTIONS = [
    { key: 'balance_sheet', label: 'Balance Sheet' },
    { key: 'income_statement_ytd', label: 'Income Statement (YTD)' },
    { key: 'net_worth', label: 'Net Worth Summary' },
] as const;

export type ShareSection = (typeof SHARE_SECTIONS)[number]['key'];

const SHARE_SECTION_KEYS = SHARE_SECTIONS.map(s => s.key);

export function shareSectionLabel(key: ShareSection): string {
    return SHARE_SECTIONS.find(s => s.key === key)?.label ?? key;
}

export interface ShareLinkRecord {
    id: number;
    userId: number;
    bookGuid: string;
    /** Display prefix, e.g. `share_ab12` — never the full secret. */
    prefix: string;
    label: string;
    sections: ShareSection[];
    expiresAt: Date;
    createdAt: Date;
    revokedAt: Date | null;
    viewCount: number;
}

/** What the public page gets back for a valid token. */
export interface ResolvedShareLink {
    id: number;
    bookGuid: string;
    label: string;
    sections: ShareSection[];
    expiresAt: Date;
    createdAt: Date;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Generate a fresh share secret: `share_` + 32 lowercase hex chars. */
export function generateShareSecret(): string {
    return SHARE_TOKEN_PREFIX + randomBytes(16).toString('hex');
}

/** SHA-256 hex digest of the full secret (including the `share_` prefix). */
export function hashShareToken(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** True when the string looks like a well-formed share secret. */
export function isValidShareTokenFormat(secret: string): boolean {
    return SHARE_TOKEN_FORMAT.test(secret);
}

/** Constant-time comparison of two hex digest strings. */
export function constantTimeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/**
 * Validate a raw sections value (JSON from DB or request body) into a
 * deduplicated list in canonical order. Unknown entries are dropped; an
 * empty/invalid selection falls back to ALL sections so a link is never blank.
 */
export function parseShareSections(raw: unknown): ShareSection[] {
    const requested = Array.isArray(raw) ? raw : [];
    const set = new Set<string>(requested.filter((s): s is string => typeof s === 'string'));
    const valid = SHARE_SECTION_KEYS.filter(key => set.has(key));
    return valid.length > 0 ? valid : [...SHARE_SECTION_KEYS];
}

/** Allowed expiry windows, in days. */
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;

/** Clamp an expiry-days choice to an allowed window (default 30). */
export function normalizeExpiryDays(raw: unknown): number {
    const n = Number(raw);
    return (SHARE_EXPIRY_DAYS as readonly number[]).includes(n) ? n : 30;
}

// ---------------------------------------------------------------------------
// Lazy table (advisory-lock pattern, same as backup.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureShareLinksTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_share_links_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_share_links (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                    book_guid VARCHAR(32) NOT NULL,
                    token_hash CHAR(64) NOT NULL UNIQUE,
                    prefix VARCHAR(16) NOT NULL,
                    label VARCHAR(100) NOT NULL,
                    reports JSONB NOT NULL DEFAULT '[]'::jsonb,
                    expires_at TIMESTAMP NOT NULL,
                    revoked_at TIMESTAMP,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    view_count INTEGER NOT NULL DEFAULT 0
                  );

                  CREATE INDEX IF NOT EXISTS idx_share_links_user
                    ON gnucash_web_share_links(user_id, created_at DESC);
                END $$;
            `);
        })();
        // Allow retry after a transient failure instead of caching the rejection.
        ensurePromise.catch(() => { ensurePromise = null; });
    }
    return ensurePromise;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface ShareLinkRow {
    id: number;
    user_id: number;
    book_guid: string;
    token_hash: string;
    prefix: string;
    label: string;
    reports: unknown;
    expires_at: Date;
    revoked_at: Date | null;
    created_at: Date;
    view_count: number;
}

const ROW_COLUMNS = `id, user_id, book_guid, token_hash, prefix, label, reports,
                     expires_at, revoked_at, created_at, view_count`;

function rowToRecord(row: ShareLinkRow): ShareLinkRecord {
    return {
        id: row.id,
        userId: row.user_id,
        bookGuid: row.book_guid,
        prefix: row.prefix,
        label: row.label,
        sections: parseShareSections(row.reports),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        viewCount: Number(row.view_count),
    };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateShareLinkInput {
    bookGuid: string;
    label: string;
    expiresAt: Date;
    sections?: unknown;
}

/**
 * Create a share link. Returns the record AND the plaintext secret — this is
 * the ONLY time the secret is available; only its hash is persisted.
 */
export async function createShareLink(
    userId: number,
    input: CreateShareLinkInput,
): Promise<{ link: ShareLinkRecord; secret: string }> {
    await ensureShareLinksTable();

    const label = input.label.trim().slice(0, 100);
    if (!label) throw new Error('Share link label is required');
    if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
        throw new Error('Share link expiry is required');
    }
    if (input.expiresAt.getTime() <= Date.now()) {
        throw new Error('Share link expiry must be in the future');
    }

    const sections = parseShareSections(input.sections);
    const secret = generateShareSecret();
    const tokenHash = hashShareToken(secret);
    const prefix = secret.slice(0, 10); // e.g. "share_ab12"

    const rows = await prisma.$queryRaw<ShareLinkRow[]>`
        INSERT INTO gnucash_web_share_links
            (user_id, book_guid, token_hash, prefix, label, reports, expires_at)
        VALUES
            (${userId}, ${input.bookGuid}, ${tokenHash}, ${prefix}, ${label},
             ${JSON.stringify(sections)}::jsonb, ${input.expiresAt})
        RETURNING ${ROW_COLUMNS}
    `;

    return { link: rowToRecord(rows[0]), secret };
}

/** List a user's non-revoked share links for a book (expired ones included, flagged by expires_at). */
export async function listShareLinks(userId: number, bookGuid: string): Promise<ShareLinkRecord[]> {
    await ensureShareLinksTable();
    const rows = await prisma.$queryRaw<ShareLinkRow[]>`
        SELECT ${ROW_COLUMNS}
        FROM gnucash_web_share_links
        WHERE user_id = ${userId} AND book_guid = ${bookGuid} AND revoked_at IS NULL
        ORDER BY created_at DESC
    `;
    return rows.map(rowToRecord);
}

/** Revoke a share link (scoped to the owning user). Returns true when a row changed. */
export async function revokeShareLink(userId: number, linkId: number): Promise<boolean> {
    await ensureShareLinksTable();
    const count = await prisma.$executeRaw`
        UPDATE gnucash_web_share_links
        SET revoked_at = NOW()
        WHERE id = ${linkId} AND user_id = ${userId} AND revoked_at IS NULL
    `;
    return count > 0;
}

// ---------------------------------------------------------------------------
// Resolution (used by the public page)
// ---------------------------------------------------------------------------

/**
 * Resolve a share secret. Returns null for malformed, unknown, revoked, or
 * expired tokens — the caller renders a neutral "link expired" page either way,
 * so nothing about WHY resolution failed is leaked.
 */
export async function resolveShareToken(secret: string): Promise<ResolvedShareLink | null> {
    if (!isValidShareTokenFormat(secret)) return null;
    await ensureShareLinksTable();

    const tokenHash = hashShareToken(secret);
    const rows = await prisma.$queryRaw<ShareLinkRow[]>`
        SELECT ${ROW_COLUMNS}
        FROM gnucash_web_share_links
        WHERE token_hash = ${tokenHash}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    // Defense-in-depth: constant-time re-check of the hash we matched on.
    if (!constantTimeEqualHex(row.token_hash.trim(), tokenHash)) return null;

    if (row.revoked_at) return null;
    if (row.expires_at.getTime() <= Date.now()) return null;

    return {
        id: row.id,
        bookGuid: row.book_guid,
        label: row.label,
        sections: parseShareSections(row.reports),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
    };
}

/** Best-effort view counter — failures never break the public page. */
export async function recordShareView(linkId: number): Promise<void> {
    try {
        await prisma.$executeRaw`
            UPDATE gnucash_web_share_links
            SET view_count = view_count + 1
            WHERE id = ${linkId}
        `;
    } catch {
        // non-fatal
    }
}

// ---------------------------------------------------------------------------
// Session-free book helpers (the public page has no session/cookies)
// ---------------------------------------------------------------------------

export interface ShareBookInfo {
    bookGuid: string;
    name: string;
    accountGuids: string[];
}

/**
 * Book name + all account GUIDs under the book's root, resolved WITHOUT a
 * session (book-scope.ts needs request cookies, which the public page lacks).
 * Same recursive CTE used by the report scheduler.
 */
export async function shareBookInfo(bookGuid: string): Promise<ShareBookInfo | null> {
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) return null;

    const rows = await prisma.$queryRaw<Array<{ guid: string }>>`
        WITH RECURSIVE account_tree AS (
            SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
            UNION ALL
            SELECT a.guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid FROM account_tree
    `;

    // Display name: root account name unless it's the generic "Root Account",
    // in which case fall back to the first child (same heuristic as backup.ts).
    let name = 'GnuCash Book';
    const root = await prisma.accounts.findUnique({
        where: { guid: book.root_account_guid },
        select: { name: true },
    });
    if (root?.name && root.name.toLowerCase() !== 'root account') {
        name = root.name;
    } else {
        const firstChild = await prisma.accounts.findFirst({
            where: { parent_guid: book.root_account_guid },
            select: { name: true },
        });
        name = firstChild?.name ?? root?.name ?? name;
    }

    return { bookGuid, name, accountGuids: rows.map(r => r.guid) };
}
