// src/lib/ai-query/guardrails.ts

/**
 * Guardrails for AI-generated SQL.
 *
 * Validates that a generated statement is a single, read-only PostgreSQL
 * SELECT before it is ever handed to the database, and enforces a row LIMIT.
 *
 * Tradeoff (documented): keyword blocking uses word-boundary regex matching
 * with string-literal contents masked out first, so words like 'DELETE'
 * appearing inside a quoted search term do not false-positive. We do NOT
 * attempt a full SQL parse; instead we also reject constructs that could hide
 * keywords from the scanner (comments, dollar-quoted strings, multiple
 * statements). Defense in depth: execution additionally runs inside a
 * READ ONLY transaction with a statement timeout (see ./execute.ts).
 */

export interface GuardrailResult {
    ok: boolean;
    reason?: string;
    /** The SQL to execute (LIMIT injected/capped). Present only when ok. */
    sql?: string;
}

export const MAX_LIMIT = 200;

/** Keywords that must never appear outside string literals (word-boundary match). */
const FORBIDDEN_KEYWORDS = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
    'grant', 'revoke', 'copy', 'execute', 'do', 'set',
    // settings escape hatch callable from SELECT
    'set_config',
];

/** Tables/views whose presence requires the $1 book-scope parameter. */
const SCOPED_TABLES = ['accounts', 'splits', 'transactions', 'account_hierarchy'];

/**
 * Replace the contents of single-quoted string literals with spaces so that
 * keyword scanning cannot false-positive on quoted text. Length-preserving,
 * so regex match indices on the masked text are valid in the original.
 * Handles the '' escape. Returns null for an unterminated literal.
 */
function maskStringLiterals(sql: string): string | null {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < sql.length) {
        const ch = sql[i];
        if (!inString) {
            out += ch;
            if (ch === "'") inString = true;
            i++;
        } else if (ch === "'") {
            if (sql[i + 1] === "'") {
                out += '  '; // escaped quote — stay inside the literal
                i += 2;
            } else {
                out += "'";
                inString = false;
                i++;
            }
        } else {
            out += ' ';
            i++;
        }
    }
    return inString ? null : out;
}

/**
 * Validate an AI-generated SQL statement. On success, `sql` carries the
 * statement to execute with LIMIT enforced (injected when absent, capped
 * at MAX_LIMIT when present).
 */
export function validateGeneratedSql(sql: string): GuardrailResult {
    if (typeof sql !== 'string' || !sql.trim()) {
        return { ok: false, reason: 'Empty SQL statement' };
    }

    // Normalize: trim and drop a single trailing semicolon.
    let stmt = sql.trim().replace(/;\s*$/, '');
    if (!stmt) return { ok: false, reason: 'Empty SQL statement' };

    const masked = maskStringLiterals(stmt);
    if (masked === null) {
        return { ok: false, reason: 'Unterminated string literal' };
    }

    // Constructs that could hide keywords from the scanner.
    if (masked.includes('--') || masked.includes('/*') || masked.includes('*/')) {
        return { ok: false, reason: 'SQL comments are not allowed' };
    }
    if (/\$[a-zA-Z_]*\$/.test(masked)) {
        return { ok: false, reason: 'Dollar-quoted strings are not allowed' };
    }

    // Single statement only.
    if (masked.includes(';')) {
        return { ok: false, reason: 'Multiple SQL statements are not allowed' };
    }

    // Must be a plain SELECT (optionally starting with a CTE).
    if (!/^\s*(select|with)\b/i.test(masked)) {
        return { ok: false, reason: 'Only SELECT statements are allowed' };
    }

    // Forbidden keywords (outside string literals).
    const forbidden = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i');
    const keywordHit = masked.match(forbidden);
    if (keywordHit) {
        return { ok: false, reason: `Forbidden keyword: ${keywordHit[1].toUpperCase()}` };
    }

    // System catalog access.
    if (/\bpg_/i.test(masked)) {
        return { ok: false, reason: 'Access to pg_ system objects is not allowed' };
    }
    if (/\binformation_schema\b/i.test(masked)) {
        return { ok: false, reason: 'Access to information_schema is not allowed' };
    }

    // Book scoping: any query touching account-linked tables must carry $1.
    const scopedTables = new RegExp(`\\b(${SCOPED_TABLES.join('|')})\\b`, 'i');
    if (scopedTables.test(masked) && !masked.includes('$1')) {
        return {
            ok: false,
            reason: 'Queries referencing accounts, splits, or transactions must be scoped with the $1 account-guid parameter (e.g. account_guid = ANY($1))',
        };
    }

    // LIMIT enforcement: inject when absent, cap every numeric LIMIT at MAX_LIMIT.
    const numericLimits = [...masked.matchAll(/\blimit\s+(\d+)\b/gi)];
    if (/\blimit\b/i.test(masked) && numericLimits.length === 0) {
        return { ok: false, reason: 'LIMIT must be a plain integer' };
    }

    if (numericLimits.length === 0) {
        stmt = `${stmt} LIMIT ${MAX_LIMIT}`;
    } else {
        // Rebuild the statement, capping oversized limits. Masking is
        // length-preserving, so masked indices map directly onto stmt.
        let rebuilt = '';
        let last = 0;
        for (const m of numericLimits) {
            const value = parseInt(m[1], 10);
            if (value > MAX_LIMIT) {
                const numStart = (m.index ?? 0) + m[0].length - m[1].length;
                rebuilt += stmt.slice(last, numStart) + String(MAX_LIMIT);
                last = numStart + m[1].length;
            }
        }
        rebuilt += stmt.slice(last);
        stmt = rebuilt;
    }

    return { ok: true, sql: stmt };
}
