// src/lib/ai-query/guardrails.ts

/**
 * Guardrails for AI-generated SQL.
 *
 * Validates that a generated statement is a single, read-only PostgreSQL
 * SELECT before it is ever handed to the database, restricts it to the
 * relations advertised in ./schema-context.ts, and enforces both a row LIMIT
 * and a real book-scope binding.
 *
 * Tradeoff (documented): keyword blocking uses word-boundary regex matching
 * with string-literal contents masked out first, so words like 'DELETE'
 * appearing inside a quoted search term do not false-positive. We do NOT
 * attempt a full SQL parse; instead we also reject constructs that could hide
 * keywords from the scanner (comments, dollar-quoted strings, multiple
 * statements) and require every FROM/JOIN target to be on an allowlist, so an
 * unparsed construct cannot reach a table we never meant to expose. Defense in
 * depth: execution additionally runs inside a READ ONLY transaction with a
 * statement timeout (see ./execute.ts).
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

/**
 * The ONLY relations this feature may read. Must stay in sync with
 * SCHEMA_CONTEXT in ./schema-context.ts, which is what the model is shown.
 * An allowlist rather than a deny-list: every other relation in the database
 * (users, API tokens, AI config, TOTP secrets, other books' business tables)
 * is unreachable by construction rather than by remembering to ban it.
 */
const ALLOWED_RELATIONS = new Set([
    'accounts',
    'account_hierarchy',
    'transactions',
    'splits',
]);

/** Relations that carry per-book data and therefore require the $1 binding. */
const SCOPED_TABLES = ['accounts', 'splits', 'transactions', 'account_hierarchy'];

/**
 * Replace the contents of single-quoted string literals with spaces so that
 * keyword scanning cannot false-positive on quoted text. Length-preserving,
 * so regex match indices on the masked text are valid in the original.
 * Handles the '' escape. Returns null for an unterminated literal.
 */
export function maskStringLiterals(sql: string): string | null {
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

/** Names introduced by WITH ... AS ( ... ), which are legal FROM/JOIN targets. */
function collectCteNames(masked: string): Set<string> {
    const names = new Set<string>();
    const re = /(?:\bwith\b|,)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) names.add(m[1].toLowerCase());
    return names;
}

/**
 * Every identifier appearing in FROM/JOIN position. A `(` after FROM is a
 * derived table, whose own FROM is caught by the same global scan.
 */
function collectRelationRefs(masked: string): string[] {
    const refs: string[] = [];
    const re = /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_.$"]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) refs.push(m[1].toLowerCase());
    return refs;
}

/**
 * True when the statement binds $1 to an account-guid column rather than merely
 * mentioning it. `WHERE $1 IS NOT NULL` satisfies "contains $1" while returning
 * every book's rows, so presence alone is not a scope check.
 */
function hasScopeBinding(masked: string): boolean {
    const anyForm = /\b(?:account_guid|guid)\s*(?:::\s*\w+(?:\[\])?\s*)?=\s*any\s*\(\s*\$1/i;
    const unnestForm = /\b(?:account_guid|guid)\s+in\s*\(\s*select\s+unnest\s*\(\s*\$1/i;
    return anyForm.test(masked) || unnestForm.test(masked);
}

/** Index of a top-level (paren-depth 0) LIMIT, or -1. Input must be masked. */
function topLevelLimitIndex(masked: string): number {
    let depth = 0;
    for (let i = 0; i < masked.length; i++) {
        const ch = masked[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && (ch === 'l' || ch === 'L')) {
            if (/^limit\b/i.test(masked.slice(i, i + 6)) && (i === 0 || /\W/.test(masked[i - 1]))) {
                return i;
            }
        }
    }
    return -1;
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

    // Relation allowlist: every FROM/JOIN target must be an advertised table or
    // a CTE defined in this statement.
    const cteNames = collectCteNames(masked);
    for (const ref of collectRelationRefs(masked)) {
        if (ref.includes('.') || ref.includes('"')) {
            return {
                ok: false,
                reason: `Schema-qualified or quoted relation names are not allowed: ${ref}`,
            };
        }
        if (!ALLOWED_RELATIONS.has(ref) && !cteNames.has(ref)) {
            return {
                ok: false,
                reason:
                    `Relation "${ref}" is not queryable. Allowed: ` +
                    `${[...ALLOWED_RELATIONS].join(', ')}.`,
            };
        }
    }

    // Book scoping: any query touching account-linked tables must BIND $1, not
    // merely mention it.
    const scopedTables = new RegExp(`\\b(${SCOPED_TABLES.join('|')})\\b`, 'i');
    if (scopedTables.test(masked) && !hasScopeBinding(masked)) {
        return {
            ok: false,
            reason:
                'Queries referencing accounts, splits, or transactions must be scoped by ' +
                'comparing an account guid against the $1 parameter (e.g. account_guid = ANY($1))',
        };
    }

    // LIMIT enforcement: cap every numeric LIMIT, then guarantee a top-level one.
    const numericLimits = [...masked.matchAll(/\blimit\s+(\d+)\b/gi)];
    if (/\blimit\b/i.test(masked) && numericLimits.length === 0) {
        return { ok: false, reason: 'LIMIT must be a plain integer' };
    }

    if (numericLimits.length > 0) {
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

    // A LIMIT inside a CTE or subquery does not bound the result set, so the
    // outer statement needs its own.
    const remasked = maskStringLiterals(stmt);
    if (remasked === null || topLevelLimitIndex(remasked) === -1) {
        stmt = `${stmt} LIMIT ${MAX_LIMIT}`;
    }

    return { ok: true, sql: stmt };
}
