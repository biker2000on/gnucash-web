/**
 * Full-Text Document Search
 *
 * Searches every free-text source the app stores, grouped by kind:
 *
 *   - receipts      → gnucash_web_receipts.ocr_text + filename
 *                     (big OCR blobs: matched with Postgres full-text search
 *                     via the generated `ocr_tsvector` column + GIN index that
 *                     db-init.ts maintains, OR'd with a plain ILIKE so exact
 *                     literals like "ACME-1234" that stemming would miss still
 *                     hit; snippets come from the raw ocr_text)
 *   - statements    → gnucash_web_statement_lines.description joined to
 *                     gnucash_web_statement_batches (short text: plain ILIKE).
 *                     These are lazy advisory-lock tables owned by
 *                     services/statement.service — we call its
 *                     ensureStatementTables() before touching them.
 *   - payslips      → gnucash_web_payslips.employer_name + line_items JSONB
 *                     rendered as text (short text: ILIKE)
 *   - transactions  → transactions.description + splits.memo, book-scoped via
 *                     the account GUID list (short text: ILIKE)
 *
 * All queries are read-only and capped per group. Results carry a snippet
 * with highlight indices (relative to the snippet text) plus an href to the
 * page that renders the underlying object.
 *
 * NOTE for the command palette: `toPaletteEntries()` flattens grouped results
 * into { label, href, group } entries so the palette can later surface
 * document hits without knowing this module's result shape.
 */

import prisma from '@/lib/prisma';
import { ensureStatementTables } from '@/lib/services/statement.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocSearchGroup = 'receipts' | 'statements' | 'payslips' | 'transactions';

export interface SearchSnippet {
    /** Snippet text (may start/end with an ellipsis character). */
    text: string;
    /** Start index of the highlighted match WITHIN `text`, or -1 when the
     *  match position could not be determined (e.g. stemmed FTS hit). */
    highlightStart: number;
    /** Exclusive end index of the highlight within `text`, or -1. */
    highlightEnd: number;
}

export interface DocSearchHit {
    group: DocSearchGroup;
    /** Stable identifier within the group (row id or guid). */
    id: string;
    title: string;
    /** ISO date (YYYY-MM-DD) when available. */
    date: string | null;
    snippet: SearchSnippet;
    href: string;
    /** Secondary context line (filename, amount, ...). */
    meta?: string;
}

export interface DocSearchResults {
    query: string;
    receipts: DocSearchHit[];
    statements: DocSearchHit[];
    payslips: DocSearchHit[];
    transactions: DocSearchHit[];
    totalHits: number;
}

export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 200;
export const MAX_GROUP_RESULTS = 20;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type QueryValidation =
    | { ok: true; query: string }
    | { ok: false; error: string };

/** Trim + length-validate a raw query string. */
export function validateSearchQuery(raw: string | null | undefined): QueryValidation {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
        return { ok: false, error: `Query must be at least ${MIN_QUERY_LENGTH} characters` };
    }
    if (trimmed.length > MAX_QUERY_LENGTH) {
        return { ok: false, error: `Query must be at most ${MAX_QUERY_LENGTH} characters` };
    }
    return { ok: true, query: trimmed };
}

/** Escape LIKE/ILIKE wildcards (backslash is Postgres' default escape char). */
export function escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Collapse runs of whitespace (OCR text is full of newlines) for display. */
function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract a snippet of `radius` characters around the first case-insensitive
 * occurrence of `query` (falling back to the first query word of >= 3 chars).
 * Returns null when no literal occurrence exists — callers should fall back
 * to `fallbackSnippet()`.
 */
export function extractSnippet(
    source: string,
    query: string,
    radius: number = 60,
): SearchSnippet | null {
    const text = normalizeWhitespace(source);
    if (!text) return null;

    const lower = text.toLowerCase();
    const candidates = [query.trim(), ...query.trim().split(/\s+/).filter(w => w.length >= 3)];

    let matchIndex = -1;
    let matchLength = 0;
    for (const candidate of candidates) {
        if (!candidate) continue;
        const idx = lower.indexOf(candidate.toLowerCase());
        if (idx !== -1) {
            matchIndex = idx;
            matchLength = candidate.length;
            break;
        }
    }
    if (matchIndex === -1) return null;

    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(text.length, matchIndex + matchLength + radius);

    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    const body = text.slice(start, end);

    return {
        text: `${prefix}${body}${suffix}`,
        highlightStart: prefix.length + (matchIndex - start),
        highlightEnd: prefix.length + (matchIndex - start) + matchLength,
    };
}

/** Non-highlighted snippet of the start of the text (FTS-only hits). */
export function fallbackSnippet(source: string, maxLength: number = 120): SearchSnippet {
    const text = normalizeWhitespace(source);
    const truncated = text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
    return { text: truncated, highlightStart: -1, highlightEnd: -1 };
}

function snippetFor(source: string | null | undefined, query: string): SearchSnippet {
    const text = source ?? '';
    return extractSnippet(text, query) ?? fallbackSnippet(text);
}

function isoDate(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10) || null;
}

/**
 * Flatten grouped results for the command palette (label + href only).
 * The palette does not use this yet — it is exported so a future palette
 * integration can call the /api/search/documents endpoint and render hits
 * without depending on this module's grouped shape.
 */
export function toPaletteEntries(
    results: DocSearchResults,
): Array<{ label: string; href: string; group: DocSearchGroup }> {
    const groups: DocSearchGroup[] = ['transactions', 'receipts', 'statements', 'payslips'];
    const entries: Array<{ label: string; href: string; group: DocSearchGroup }> = [];
    for (const group of groups) {
        for (const hit of results[group]) {
            entries.push({ label: hit.title, href: hit.href, group });
        }
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Row shapes returned by the raw queries
// ---------------------------------------------------------------------------

interface ReceiptRow {
    id: number;
    filename: string;
    ocr_text: string | null;
    created_at: Date | null;
}

interface StatementLineRow {
    id: number;
    batch_id: number;
    description: string;
    line_date: Date | null;
    amount: unknown;
    original_filename: string;
}

interface PayslipRow {
    id: number;
    employer_name: string;
    pay_date: Date | null;
    line_items_text: string | null;
}

interface TransactionRow {
    guid: string;
    description: string | null;
    post_date: Date | null;
    matched_memo: string | null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface SearchDocumentsOptions {
    /** Per-group result cap. Clamped to 1..MAX_GROUP_RESULTS. */
    limit?: number;
}

export async function searchDocuments(
    bookAccountGuids: string[],
    bookGuid: string,
    query: string,
    options: SearchDocumentsOptions = {},
): Promise<DocSearchResults> {
    const validation = validateSearchQuery(query);
    if (!validation.ok) {
        throw new Error(validation.error);
    }
    const q = validation.query;
    const cap = Math.min(Math.max(1, Math.floor(options.limit ?? MAX_GROUP_RESULTS)), MAX_GROUP_RESULTS);
    const pattern = `%${escapeLike(q)}%`;

    // Statement tables are lazy — make sure they exist before SELECTing.
    await ensureStatementTables();

    const [receiptRows, statementRows, payslipRows, transactionRows] = await Promise.all([
        // Receipts: FTS over the generated ocr_tsvector (GIN-indexed) plus a
        // literal ILIKE so exact tokens stemming would drop still match.
        prisma.$queryRaw<ReceiptRow[]>`
            SELECT id, filename, ocr_text, created_at
            FROM gnucash_web_receipts
            WHERE book_guid = ${bookGuid}
              AND (
                ocr_tsvector @@ websearch_to_tsquery('english', ${q})
                OR ocr_text ILIKE ${pattern}
                OR filename ILIKE ${pattern}
              )
            ORDER BY created_at DESC NULLS LAST
            LIMIT ${cap}
        `,
        prisma.$queryRaw<StatementLineRow[]>`
            SELECT l.id, l.batch_id, l.description, l.line_date, l.amount,
                   b.original_filename
            FROM gnucash_web_statement_lines l
            JOIN gnucash_web_statement_batches b ON b.id = l.batch_id
            WHERE b.book_guid = ${bookGuid}
              AND l.description ILIKE ${pattern}
            ORDER BY l.line_date DESC
            LIMIT ${cap}
        `,
        prisma.$queryRaw<PayslipRow[]>`
            SELECT id, employer_name, pay_date, line_items::text AS line_items_text
            FROM gnucash_web_payslips
            WHERE book_guid = ${bookGuid}
              AND (
                employer_name ILIKE ${pattern}
                OR line_items::text ILIKE ${pattern}
              )
            ORDER BY pay_date DESC
            LIMIT ${cap}
        `,
        prisma.$queryRaw<TransactionRow[]>`
            SELECT t.guid, t.description, t.post_date,
                   (
                     SELECT s2.memo FROM splits s2
                     WHERE s2.tx_guid = t.guid AND s2.memo ILIKE ${pattern}
                     LIMIT 1
                   ) AS matched_memo
            FROM transactions t
            WHERE EXISTS (
                    SELECT 1 FROM splits s
                    WHERE s.tx_guid = t.guid AND s.account_guid = ANY(${bookAccountGuids})
                  )
              AND (
                t.description ILIKE ${pattern}
                OR EXISTS (
                    SELECT 1 FROM splits s
                    WHERE s.tx_guid = t.guid AND s.memo ILIKE ${pattern}
                  )
              )
            ORDER BY t.post_date DESC NULLS LAST
            LIMIT ${cap}
        `,
    ]);

    const receipts: DocSearchHit[] = receiptRows.slice(0, cap).map((row) => ({
        group: 'receipts',
        id: String(row.id),
        title: row.filename,
        date: isoDate(row.created_at),
        snippet: snippetFor(row.ocr_text || row.filename, q),
        // The receipt gallery has no per-receipt deep-link parameter today;
        // link to the gallery page.
        href: '/receipts',
        meta: 'Receipt',
    }));

    const statements: DocSearchHit[] = statementRows.slice(0, cap).map((row) => {
        const amount = Number(row.amount);
        return {
            group: 'statements',
            id: String(row.id),
            title: row.description,
            date: isoDate(row.line_date),
            snippet: snippetFor(row.description, q),
            href: `/statements/${row.batch_id}`,
            meta: Number.isFinite(amount)
                ? `${row.original_filename} · ${amount.toFixed(2)}`
                : row.original_filename,
        };
    });

    const payslips: DocSearchHit[] = payslipRows.slice(0, cap).map((row) => {
        const employerMatch = extractSnippet(row.employer_name, q);
        return {
            group: 'payslips',
            id: String(row.id),
            title: row.employer_name,
            date: isoDate(row.pay_date),
            snippet: employerMatch ?? snippetFor(row.line_items_text || row.employer_name, q),
            href: '/payslips',
            meta: 'Payslip',
        };
    });

    const transactions: DocSearchHit[] = transactionRows.slice(0, cap).map((row) => {
        const description = row.description || '(no description)';
        const descriptionMatch = extractSnippet(description, q);
        return {
            group: 'transactions',
            id: row.guid,
            title: description,
            date: isoDate(row.post_date),
            snippet: descriptionMatch ?? snippetFor(row.matched_memo || description, q),
            href: `/ledger?search=${encodeURIComponent(q)}`,
            meta: row.matched_memo && !descriptionMatch ? `Memo: ${row.matched_memo}` : undefined,
        };
    });

    return {
        query: q,
        receipts,
        statements,
        payslips,
        transactions,
        totalHits: receipts.length + statements.length + payslips.length + transactions.length,
    };
}
