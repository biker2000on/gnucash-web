// src/lib/ai-query/guardrails.ts

/**
 * Guardrails for AI-generated SQL.
 *
 * Validates that a generated statement is a single, read-only PostgreSQL
 * SELECT, restricts it to the relations advertised in ./schema-context.ts, and
 * enforces a row LIMIT.
 *
 * Book scoping is enforced BY CONSTRUCTION rather than by inspection. The model
 * is never allowed to name a base table; it may only read the `book_*` CTEs,
 * whose definitions this module writes itself with the account-guid array bound
 * as $1. Two earlier designs tried to prove that a model-supplied predicate
 * scoped the query correctly — first by requiring one `$1` binding anywhere,
 * then by requiring one per alias — and both were bypassable, because deciding
 * whether a predicate actually constrains a query means understanding boolean
 * position (`OR TRUE`, `NOT (...)`), UNION branches, and alias shadowing. There
 * is no predicate to subvert here: an unscoped row is not reachable from the
 * relations the model can name.
 *
 * Scanning runs over a real tokenizer, not regex over raw text. Quoted
 * identifiers and comma joins are rejected outright rather than parsed, because
 * both were previously invisible to a regex that only looked for a bare word
 * after FROM/JOIN. Constructs that could hide keywords from the scanner
 * (comments, dollar-quoted strings, multiple statements) are also rejected.
 *
 * Defense in depth: execution additionally runs inside a READ ONLY transaction
 * with a statement timeout (see ./execute.ts).
 */

export interface GuardrailResult {
    ok: boolean;
    reason?: string;
    /** The SQL to execute (scope CTEs prepended, LIMIT injected/capped). Present only when ok. */
    sql?: string;
}

export const MAX_LIMIT = 200;

/** Keywords that must never appear as bare identifiers. */
const FORBIDDEN_KEYWORDS = new Set([
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
    'grant', 'revoke', 'copy', 'execute', 'do', 'set',
    // settings escape hatch callable from SELECT
    'set_config',
]);

/**
 * The ONLY relations this feature may read: pre-scoped CTEs this module
 * defines. Base table names (accounts, splits, transactions,
 * account_hierarchy) are deliberately NOT here — a statement naming one is
 * rejected, so there is no path to an unscoped row, and every other relation in
 * the database (users, API tokens, AI config, TOTP secrets, other books'
 * business tables) is unreachable by construction rather than by remembering to
 * ban it.
 */
export const BOOK_RELATIONS: Record<string, string> = {
    book_accounts:
        'book_accounts AS (SELECT * FROM accounts WHERE guid = ANY($1))',
    book_account_hierarchy:
        'book_account_hierarchy AS (SELECT * FROM account_hierarchy WHERE guid = ANY($1))',
    book_splits:
        'book_splits AS (SELECT * FROM splits WHERE account_guid = ANY($1))',
    book_transactions:
        'book_transactions AS (SELECT * FROM transactions WHERE guid IN '
        + '(SELECT tx_guid FROM splits WHERE account_guid = ANY($1)))',
};

/**
 * Own-property test, not `in`: `'constructor' in BOOK_RELATIONS` is true via
 * Object.prototype, which would let an inherited key pass the allowlist.
 */
function isBookRelation(name: string): boolean {
    return Object.hasOwn(BOOK_RELATIONS, name);
}

/** Functions whose argument list contains a FROM that is not a relation clause. */
const FROM_IN_ARGUMENTS = new Set(['extract', 'substring', 'position', 'overlay', 'trim']);

/** Keywords that end the relation list of a FROM clause at the same paren depth. */
const FROM_CLAUSE_TERMINATORS = new Set([
    'where', 'group', 'order', 'having', 'limit', 'offset', 'window',
    'union', 'intersect', 'except', 'fetch', 'for',
]);

export interface SqlToken {
    kind: 'ident' | 'quotedIdent' | 'string' | 'number' | 'param' | 'punct';
    /** Identifiers are lowercased; other kinds carry their raw text. */
    value: string;
    start: number;
    end: number;
    /** Paren nesting depth at this token (an opening paren carries its outer depth). */
    depth: number;
}

export type TokenizeResult =
    | { ok: true; tokens: SqlToken[] }
    | { ok: false; reason: string };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Tokenize a statement, rejecting anything that could hide meaning from the
 * scanner. Comments and dollar-quoted strings are refused rather than skipped:
 * they have no legitimate use here and every one of them is a place a keyword
 * could hide.
 */
export function tokenizeSql(sql: string): TokenizeResult {
    const tokens: SqlToken[] = [];
    let i = 0;
    let depth = 0;

    while (i < sql.length) {
        const ch = sql[i];

        if (/\s/.test(ch)) { i++; continue; }

        if (ch === '-' && sql[i + 1] === '-') {
            return { ok: false, reason: 'SQL comments are not allowed' };
        }
        if (ch === '/' && sql[i + 1] === '*') {
            return { ok: false, reason: 'SQL comments are not allowed' };
        }
        if (ch === '*' && sql[i + 1] === '/') {
            return { ok: false, reason: 'SQL comments are not allowed' };
        }

        // Dollar-quoted string ($$ ... $$ or $tag$ ... $tag$) vs. a $1 parameter.
        if (ch === '$') {
            const dollarQuote = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
            if (dollarQuote) {
                return { ok: false, reason: 'Dollar-quoted strings are not allowed' };
            }
            const param = /^\$\d+/.exec(sql.slice(i));
            if (param) {
                tokens.push({
                    kind: 'param', value: param[0], start: i, end: i + param[0].length, depth,
                });
                i += param[0].length;
                continue;
            }
            return { ok: false, reason: 'Unexpected "$" in statement' };
        }

        // Single-quoted string literal, with '' escape.
        if (ch === "'") {
            let j = i + 1;
            for (;;) {
                if (j >= sql.length) return { ok: false, reason: 'Unterminated string literal' };
                if (sql[j] === "'") {
                    if (sql[j + 1] === "'") { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            tokens.push({ kind: 'string', value: sql.slice(i, j), start: i, end: j, depth });
            i = j;
            continue;
        }

        // Double-quoted identifier. Always rejected: a quoted name is invisible
        // to a bare-word scanner, which is exactly how `FROM "gnucash_web_users"`
        // slipped past the previous allowlist.
        if (ch === '"') {
            return { ok: false, reason: 'Quoted identifiers are not allowed' };
        }

        if (ch === '(') {
            tokens.push({ kind: 'punct', value: '(', start: i, end: i + 1, depth });
            depth++;
            i++;
            continue;
        }
        if (ch === ')') {
            depth--;
            if (depth < 0) return { ok: false, reason: 'Unbalanced parentheses' };
            tokens.push({ kind: 'punct', value: ')', start: i, end: i + 1, depth });
            i++;
            continue;
        }

        if (IDENT_START.test(ch)) {
            let j = i + 1;
            while (j < sql.length && IDENT_PART.test(sql[j])) j++;
            tokens.push({
                kind: 'ident',
                value: sql.slice(i, j).toLowerCase(),
                start: i,
                end: j,
                depth,
            });
            i = j;
            continue;
        }

        if (/\d/.test(ch)) {
            let j = i;
            while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
            tokens.push({ kind: 'number', value: sql.slice(i, j), start: i, end: j, depth });
            i = j;
            continue;
        }

        tokens.push({ kind: 'punct', value: ch, start: i, end: i + 1, depth });
        i++;
    }

    if (depth !== 0) return { ok: false, reason: 'Unbalanced parentheses' };
    return { ok: true, tokens };
}

/**
 * Replace the contents of single-quoted string literals with spaces.
 * Length-preserving, so match indices on the masked text are valid in the
 * original. Handles the '' escape. Returns null for an unterminated literal.
 * Retained for ./execute.ts, which must not rewrite a $1 that is really data.
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

/** Index of the token closing the paren opened at `openIndex`. */
function matchingParen(tokens: SqlToken[], openIndex: number): number {
    const target = tokens[openIndex].depth;
    for (let i = openIndex + 1; i < tokens.length; i++) {
        if (tokens[i].kind === 'punct' && tokens[i].value === ')' && tokens[i].depth === target) {
            return i;
        }
    }
    return tokens.length;
}

/** Names introduced by WITH ... AS ( ... ), which are legal FROM/JOIN targets. */
export function collectCteNames(tokens: SqlToken[]): Set<string> {
    const names = new Set<string>();
    if (tokens.length === 0 || tokens[0].value !== 'with') return names;

    // WITH name AS ( ... ) [, name AS ( ... )]* — all at depth 0.
    let expectName = true;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.depth !== 0) continue;
        if (expectName) {
            if (token.kind !== 'ident') break;
            const next = tokens[i + 1];
            const opener = tokens[i + 2];
            if (next?.value !== 'as' || opener?.value !== '(') break;
            names.add(token.value);
            i = matchingParen(tokens, i + 2);
            expectName = false;
            continue;
        }
        if (token.kind === 'punct' && token.value === ',') {
            expectName = true;
            continue;
        }
        break; // start of the main SELECT
    }
    return names;
}

export interface RelationRef {
    name: string;
    tokenIndex: number;
}

/**
 * Every identifier in FROM/JOIN position. A `(` after FROM is a derived table,
 * whose own FROM is caught by the same scan.
 */
export function collectRelationRefs(tokens: SqlToken[]): RelationRef[] {
    const refs: RelationRef[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind !== 'ident') continue;

        // EXTRACT(YEAR FROM x) and friends: the FROM inside the argument list
        // introduces no relation. Skip the whole call.
        if (FROM_IN_ARGUMENTS.has(token.value) && tokens[i + 1]?.value === '(') {
            i = matchingParen(tokens, i + 1);
            continue;
        }

        if (token.value !== 'from' && token.value !== 'join') continue;

        const target = tokens[i + 1];
        if (!target) continue;
        if (target.kind === 'punct' && target.value === '(') continue; // derived table
        if (target.kind !== 'ident') continue;

        refs.push({ name: target.value, tokenIndex: i + 1 });
    }
    return refs;
}

/**
 * True when a FROM clause lists more than one relation separated by a comma.
 * Rejected because a comma join is a second, easily-overlooked relation slot:
 * `FROM splits s JOIN transactions t ON ..., gnucash_web_users u` previously
 * reached an arbitrary table, since only the first FROM item was checked.
 */
export function hasCommaJoin(tokens: SqlToken[]): boolean {
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'ident' || tokens[i].value !== 'from') continue;

        const clauseDepth = tokens[i].depth;
        for (let j = i + 1; j < tokens.length; j++) {
            const token = tokens[j];
            if (token.depth < clauseDepth) break;
            if (token.depth > clauseDepth) continue;
            if (token.kind === 'punct' && token.value === ',') return true;
            if (token.kind === 'ident' && FROM_CLAUSE_TERMINATORS.has(token.value)) break;
        }
    }
    return false;
}

/** Index of a top-level (depth 0) LIMIT token, or -1. */
function topLevelLimitIndex(tokens: SqlToken[]): number {
    return tokens.findIndex(t => t.kind === 'ident' && t.value === 'limit' && t.depth === 0);
}

/** Prepend the scope CTEs for every book relation the statement reads. */
function withScopeCtes(stmt: string, tokens: SqlToken[], used: string[]): string {
    const definitions = used.map(name => BOOK_RELATIONS[name]).join(',\n     ');
    if (tokens[0]?.value === 'with') {
        // Merge into the existing WITH list rather than nesting a second one.
        return `WITH ${definitions},\n     ${stmt.slice(tokens[0].end).trimStart()}`;
    }
    return `WITH ${definitions}\n${stmt}`;
}

/**
 * Validate an AI-generated SQL statement. On success, `sql` carries the
 * statement to execute: book-scope CTEs prepended (binding $1) and LIMIT
 * enforced (injected when absent, capped at MAX_LIMIT when present).
 */
export function validateGeneratedSql(sql: string): GuardrailResult {
    if (typeof sql !== 'string' || !sql.trim()) {
        return { ok: false, reason: 'Empty SQL statement' };
    }

    // Normalize: trim and drop a single trailing semicolon.
    let stmt = sql.trim().replace(/;\s*$/, '');
    if (!stmt) return { ok: false, reason: 'Empty SQL statement' };

    const tokenized = tokenizeSql(stmt);
    if (!tokenized.ok) return { ok: false, reason: tokenized.reason };
    let tokens = tokenized.tokens;
    if (tokens.length === 0) return { ok: false, reason: 'Empty SQL statement' };

    // Single statement only.
    if (tokens.some(t => t.kind === 'punct' && t.value === ';')) {
        return { ok: false, reason: 'Multiple SQL statements are not allowed' };
    }

    // Must be a plain SELECT (optionally starting with a CTE).
    if (tokens[0].value !== 'select' && tokens[0].value !== 'with') {
        return { ok: false, reason: 'Only SELECT statements are allowed' };
    }

    // Recursive CTEs can iterate unboundedly; the statement timeout should not
    // be the only thing standing between a generated query and the CPU.
    if (tokens[0].value === 'with' && tokens[1]?.value === 'recursive') {
        return { ok: false, reason: 'Recursive CTEs are not allowed' };
    }

    for (const token of tokens) {
        if (token.kind !== 'ident') continue;
        if (FORBIDDEN_KEYWORDS.has(token.value)) {
            return { ok: false, reason: `Forbidden keyword: ${token.value.toUpperCase()}` };
        }
        if (token.value.startsWith('pg_')) {
            return { ok: false, reason: 'Access to pg_ system objects is not allowed' };
        }
        if (token.value === 'information_schema') {
            return { ok: false, reason: 'Access to information_schema is not allowed' };
        }
    }

    // Only $1 (the account-guid array) may be bound.
    const badParam = tokens.find(t => t.kind === 'param' && t.value !== '$1');
    if (badParam) {
        return { ok: false, reason: `Only the $1 parameter is available, not ${badParam.value}` };
    }

    if (hasCommaJoin(tokens)) {
        return { ok: false, reason: 'Comma joins are not allowed; use an explicit JOIN' };
    }

    // Schema qualification (a `.` directly after a relation name) would name a
    // relation the allowlist never sees.
    const cteNames = collectCteNames(tokens);
    for (const name of cteNames) {
        if (isBookRelation(name)) {
            return { ok: false, reason: `"${name}" is reserved and cannot be redefined as a CTE` };
        }
    }

    const refs = collectRelationRefs(tokens);
    for (const ref of refs) {
        if (tokens[ref.tokenIndex + 1]?.value === '.') {
            return {
                ok: false,
                reason: `Schema-qualified relation names are not allowed: ${ref.name}`,
            };
        }
        if (!isBookRelation(ref.name) && !cteNames.has(ref.name)) {
            return {
                ok: false,
                reason:
                    `Relation "${ref.name}" is not queryable. Allowed: `
                    + `${Object.keys(BOOK_RELATIONS).join(', ')}.`,
            };
        }
    }

    // LIMIT enforcement: cap every numeric LIMIT, then guarantee a top-level one.
    const limits: Array<{ token: SqlToken; value: number }> = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'ident' || tokens[i].value !== 'limit') continue;
        const next = tokens[i + 1];
        if (!next || next.kind !== 'number' || !/^\d+$/.test(next.value)) {
            return { ok: false, reason: 'LIMIT must be a plain integer' };
        }
        limits.push({ token: next, value: parseInt(next.value, 10) });
    }

    if (limits.some(l => l.value > MAX_LIMIT)) {
        let rebuilt = '';
        let last = 0;
        for (const limit of limits) {
            if (limit.value <= MAX_LIMIT) continue;
            rebuilt += stmt.slice(last, limit.token.start) + String(MAX_LIMIT);
            last = limit.token.end;
        }
        stmt = rebuilt + stmt.slice(last);

        const retokenized = tokenizeSql(stmt);
        if (!retokenized.ok) return { ok: false, reason: retokenized.reason };
        tokens = retokenized.tokens;
    }

    // A LIMIT inside a CTE or subquery does not bound the result set, so the
    // outer statement needs its own.
    if (topLevelLimitIndex(tokens) === -1) {
        stmt = `${stmt} LIMIT ${MAX_LIMIT}`;
        const retokenized = tokenizeSql(stmt);
        if (!retokenized.ok) return { ok: false, reason: retokenized.reason };
        tokens = retokenized.tokens;
    }

    // Book scoping, by construction: define the book_* relations the statement
    // reads. Nothing the model wrote can widen these — an out-of-book row is
    // not reachable from the only relations it is allowed to name.
    const finalRefs = new Set(collectRelationRefs(tokens).map(ref => ref.name));
    const used = Object.keys(BOOK_RELATIONS).filter(name => finalRefs.has(name));
    if (used.length > 0) {
        stmt = withScopeCtes(stmt, tokens, used);
    }

    return { ok: true, sql: stmt };
}
