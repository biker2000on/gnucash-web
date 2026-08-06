// src/lib/__tests__/ai-query-guardrails.test.ts

import { describe, it, expect } from 'vitest';
import { validateGeneratedSql, MAX_LIMIT, BOOK_RELATIONS } from '../ai-query/guardrails';
import { castScopeParameter } from '../ai-query/execute';

const SCOPED_SELECT =
    "SELECT ROUND(SUM(s.value_num::numeric / s.value_denom), 2) AS total " +
    "FROM book_splits s JOIN book_accounts a ON a.guid = s.account_guid " +
    "WHERE a.account_type = 'EXPENSE' LIMIT 100";

describe('validateGeneratedSql', () => {
    describe('allows valid read-only statements', () => {
        it('allows a plain SELECT', () => {
            const result = validateGeneratedSql('SELECT 1 AS one LIMIT 1');
            expect(result.ok).toBe(true);
            expect(result.sql).toBe('SELECT 1 AS one LIMIT 1');
        });

        it('allows a SELECT over the book relations', () => {
            const result = validateGeneratedSql(SCOPED_SELECT);
            expect(result.ok).toBe(true);
        });

        it('allows WITH ... SELECT (read-only CTE)', () => {
            const sql =
                'WITH expense_accounts AS (SELECT guid FROM book_account_hierarchy) ' +
                'SELECT COUNT(*) FROM expense_accounts LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('allows lowercase select', () => {
            expect(validateGeneratedSql('select 42 as answer limit 5').ok).toBe(true);
        });

        it('tolerates a single trailing semicolon', () => {
            const result = validateGeneratedSql('SELECT 1 LIMIT 1;');
            expect(result.ok).toBe(true);
            expect(result.sql).toBe('SELECT 1 LIMIT 1');
        });

        it('tolerates leading/trailing whitespace', () => {
            expect(validateGeneratedSql('  \n SELECT 1 LIMIT 1 \n ').ok).toBe(true);
        });

        it('allows EXTRACT(part FROM column), whose FROM is not a relation clause', () => {
            const sql =
                'SELECT EXTRACT(YEAR FROM t.post_date) AS yr, COUNT(*) '
                + 'FROM book_transactions t GROUP BY 1 LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });
    });

    // Book scoping is enforced by construction: the model may only name the
    // book_* CTEs, whose definitions this module writes. There is no
    // model-supplied scope predicate left to subvert.
    describe('book scoping by construction', () => {
        it('prepends the scope CTE for each book relation the statement reads', () => {
            const result = validateGeneratedSql('SELECT guid FROM book_splits LIMIT 5');
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(BOOK_RELATIONS.book_splits);
            expect(result.sql).toMatch(/^WITH /);
            expect(result.sql).toContain('SELECT guid FROM book_splits LIMIT 5');
        });

        it('binds $1 in the injected definition even when the model wrote none', () => {
            const result = validateGeneratedSql('SELECT guid FROM book_accounts LIMIT 5');
            expect(result.sql).toContain('ANY($1)');
        });

        it('defines only the relations actually referenced', () => {
            const result = validateGeneratedSql('SELECT guid FROM book_accounts LIMIT 5');
            expect(result.sql).toContain('book_accounts AS');
            expect(result.sql).not.toContain('book_splits AS');
            expect(result.sql).not.toContain('book_transactions AS');
        });

        it('merges into an existing WITH list rather than nesting a second one', () => {
            const sql =
                'WITH mine AS (SELECT guid FROM book_accounts) SELECT COUNT(*) FROM mine LIMIT 5';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql!.match(/\bWITH\b/gi)).toHaveLength(1);
            expect(result.sql).toContain('mine AS (SELECT guid FROM book_accounts)');
        });

        it('injects nothing for a table-free SELECT', () => {
            const result = validateGeneratedSql('SELECT 1 + 1 AS two LIMIT 1');
            expect(result.sql).toBe('SELECT 1 + 1 AS two LIMIT 1');
        });

        it('refuses to let a CTE shadow a reserved book relation', () => {
            const sql =
                'WITH book_splits AS (SELECT 1 AS account_guid) SELECT * FROM book_splits LIMIT 5';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/reserved/i);
        });
    });

    // The base tables are unscoped. Naming one is refused outright, which is
    // what makes "did the model scope this correctly?" a question nobody has to
    // answer.
    describe('base tables are not queryable', () => {
        const baseTables = ['accounts', 'splits', 'transactions', 'account_hierarchy'];

        it.each(baseTables)('refuses FROM %s', (table) => {
            const result = validateGeneratedSql(`SELECT * FROM ${table} LIMIT 10`);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/not queryable/i);
        });

        it('refuses a base table even when it carries a scope predicate', () => {
            const sql = 'SELECT guid FROM splits WHERE account_guid = ANY($1) LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('refuses a base table joined to a book relation', () => {
            const sql =
                'SELECT t.description FROM book_splits s JOIN transactions t ON t.guid = s.tx_guid LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });
    });

    // Payloads confirmed ACCEPTED by the previous alias-based validator during
    // the 2026-08-06 validation of the ASI-3-004 fix. A/B/J reached arbitrary
    // tables (password hashes, TOTP secrets); C/D/E returned every book's rows.
    describe('regression: ASI-3-004 guardrail bypasses', () => {
        it('A: rejects a comma join trailing a JOIN ... ON clause', () => {
            const sql =
                'SELECT u.username FROM book_splits s JOIN book_transactions t ON t.guid = s.tx_guid, '
                + 'gnucash_web_users u LIMIT 10';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/comma join/i);
        });

        it('B: rejects a double-quoted relation name', () => {
            const result = validateGeneratedSql('SELECT * FROM "gnucash_web_users" LIMIT 10');
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/quoted identifier/i);
        });

        it('J: rejects a quoted relation hidden in a subquery of a valid statement', () => {
            const sql =
                'SELECT s.memo FROM book_splits s '
                + 'WHERE s.guid IN (SELECT guid FROM "gnucash_web_users") LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('C: an OR TRUE predicate cannot widen the result set', () => {
            // Accepted then AND unscoped; accepted now but harmless, because
            // book_splits contains only in-book rows to begin with.
            const result = validateGeneratedSql(
                'SELECT s.memo FROM book_splits s WHERE s.account_guid = ANY($1) OR TRUE LIMIT 10'
            );
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(BOOK_RELATIONS.book_splits);
        });

        it('D: a negated scope predicate cannot widen the result set', () => {
            const result = validateGeneratedSql(
                'SELECT s.memo FROM book_splits s WHERE NOT (s.account_guid = ANY($1)) LIMIT 10'
            );
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(BOOK_RELATIONS.book_splits);
        });

        it('E: a UNION branch cannot launder scope from another branch', () => {
            const sql =
                'SELECT t.description FROM book_transactions t '
                + 'UNION ALL SELECT t.description FROM transactions t LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('E: a UNION over book relations alone stays scoped in both branches', () => {
            const sql =
                'SELECT t.description FROM book_transactions t '
                + 'UNION ALL SELECT a.name FROM book_accounts a LIMIT 10';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(BOOK_RELATIONS.book_transactions);
            expect(result.sql).toContain(BOOK_RELATIONS.book_accounts);
        });
    });

    describe('blocks mutation and DDL keywords', () => {
        const forbidden: [string, string][] = [
            ['INSERT', "INSERT INTO book_accounts (guid) VALUES ('x')"],
            ['UPDATE', "UPDATE book_accounts SET name = 'x'"],
            ['DELETE', 'DELETE FROM book_splits'],
            ['DROP', 'DROP TABLE accounts'],
            ['ALTER', 'ALTER TABLE accounts ADD COLUMN x int'],
            ['CREATE', 'CREATE TABLE evil (id int)'],
            ['TRUNCATE', 'TRUNCATE splits'],
            ['GRANT', 'GRANT ALL ON accounts TO public'],
            ['REVOKE', 'REVOKE ALL ON accounts FROM public'],
            ['COPY', "COPY accounts TO '/tmp/x'"],
            ['EXECUTE', 'EXECUTE some_prepared_statement'],
            ['DO', 'DO $x$ BEGIN NULL; END $x$'],
            ['SET', 'SET statement_timeout = 0'],
        ];

        it.each(forbidden)('blocks %s', (_kw, sql) => {
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('blocks lowercase mutation keywords', () => {
            expect(validateGeneratedSql('delete from book_splits').ok).toBe(false);
        });

        it('blocks mixed-case mutation keywords', () => {
            expect(validateGeneratedSql('DeLeTe FROM book_splits').ok).toBe(false);
        });

        it('blocks mutation keywords buried inside a SELECT (data-modifying CTE)', () => {
            const sql =
                'WITH gone AS (DELETE FROM splits RETURNING *) SELECT COUNT(*) FROM gone LIMIT 1';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/DELETE/);
        });

        it('blocks set_config() smuggled into a SELECT', () => {
            expect(validateGeneratedSql("SELECT set_config('statement_timeout', '0', false) LIMIT 1").ok)
                .toBe(false);
        });

        it('does NOT false-positive on keywords inside string literals', () => {
            const sql =
                "SELECT t.description FROM book_transactions t "
                + "WHERE t.description ILIKE '%DELETE%' LIMIT 20";
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('handles escaped quotes inside literals without leaking keyword text', () => {
            const sql =
                "SELECT t.description FROM book_transactions t "
                + "WHERE t.description = 'Bob''s DROP shop' LIMIT 20";
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('does not false-positive on identifiers that merely contain keywords', () => {
            // reconcile_state contains no standalone forbidden word; OFFSET contains "set".
            const sql = 'SELECT s.reconcile_state FROM book_splits s LIMIT 10 OFFSET 5';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });
    });

    describe('blocks multiple statements', () => {
        it('blocks two SELECTs separated by a semicolon', () => {
            const result = validateGeneratedSql('SELECT 1; SELECT 2');
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/multiple/i);
        });

        it('blocks a SELECT followed by a mutation', () => {
            expect(validateGeneratedSql('SELECT 1; DROP TABLE accounts').ok).toBe(false);
        });

        it('does not treat semicolons inside string literals as statement breaks', () => {
            const sql = "SELECT t.description FROM book_transactions t WHERE t.description = 'a;b' LIMIT 5";
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });
    });

    describe('requires statements to start with SELECT or WITH', () => {
        it('blocks EXPLAIN', () => {
            expect(validateGeneratedSql('EXPLAIN SELECT 1').ok).toBe(false);
        });

        it('blocks VACUUM', () => {
            expect(validateGeneratedSql('VACUUM accounts').ok).toBe(false);
        });

        it('blocks empty input', () => {
            expect(validateGeneratedSql('').ok).toBe(false);
            expect(validateGeneratedSql('   ;  ').ok).toBe(false);
        });

        it('blocks recursive CTEs', () => {
            const sql =
                'WITH RECURSIVE tree AS (SELECT guid FROM book_accounts) SELECT * FROM tree LIMIT 5';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/recursive/i);
        });
    });

    describe('LIMIT enforcement', () => {
        it('injects LIMIT when absent', () => {
            const result = validateGeneratedSql('SELECT guid FROM book_accounts');
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(`SELECT guid FROM book_accounts LIMIT ${MAX_LIMIT}`);
        });

        it(`caps LIMIT at ${MAX_LIMIT}`, () => {
            const result = validateGeneratedSql('SELECT guid FROM book_accounts LIMIT 5000');
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(`LIMIT ${MAX_LIMIT}`);
            expect(result.sql).not.toContain('5000');
        });

        it(`leaves LIMIT ${MAX_LIMIT} unchanged`, () => {
            const result = validateGeneratedSql(`SELECT guid FROM book_accounts LIMIT ${MAX_LIMIT}`);
            expect(result.sql!.match(/LIMIT/gi)).toHaveLength(1);
        });

        it('leaves a small LIMIT unchanged', () => {
            const result = validateGeneratedSql('SELECT guid FROM book_accounts LIMIT 25');
            expect(result.sql).toContain('LIMIT 25');
        });

        it('caps lowercase limit too', () => {
            const result = validateGeneratedSql('select guid from book_accounts limit 999');
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(`limit ${MAX_LIMIT}`);
            expect(result.sql).not.toContain('999');
        });

        it('caps every oversized LIMIT, including in subqueries', () => {
            const sql = 'SELECT * FROM (SELECT guid FROM book_accounts LIMIT 1000) sub LIMIT 500';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql).not.toMatch(/1000|500/);
            expect(result.sql!.match(new RegExp(`LIMIT ${MAX_LIMIT}`, 'gi'))).toHaveLength(2);
        });

        it('rejects a non-numeric LIMIT', () => {
            expect(validateGeneratedSql('SELECT guid FROM book_accounts LIMIT ALL').ok).toBe(false);
        });

        it('injects a top-level LIMIT when the only LIMIT is inside a CTE', () => {
            const sql =
                'WITH t AS (SELECT guid FROM book_accounts LIMIT 100) '
                + 'SELECT t.guid, s.value_num FROM t CROSS JOIN book_splits s';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql).toMatch(new RegExp(`LIMIT ${MAX_LIMIT}$`));
        });

        it('does not double-append when a top-level LIMIT is already present', () => {
            const result = validateGeneratedSql('SELECT s.guid FROM book_splits s LIMIT 10');
            expect(result.ok).toBe(true);
            expect(result.sql!.match(/LIMIT/gi)).toHaveLength(1);
        });
    });

    describe('hardening against scanner evasion', () => {
        it('blocks pg_ system objects', () => {
            expect(validateGeneratedSql('SELECT * FROM pg_tables LIMIT 10').ok).toBe(false);
            expect(validateGeneratedSql('SELECT pg_sleep(10) LIMIT 1').ok).toBe(false);
        });

        it('blocks information_schema', () => {
            expect(validateGeneratedSql('SELECT table_name FROM information_schema.tables LIMIT 10').ok)
                .toBe(false);
        });

        it('blocks SQL comments (could hide keywords)', () => {
            expect(validateGeneratedSql('SELECT 1 -- DROP TABLE accounts').ok).toBe(false);
            expect(validateGeneratedSql('SELECT /* sneaky */ 1 LIMIT 1').ok).toBe(false);
        });

        it('blocks dollar-quoted strings (could hide keywords)', () => {
            expect(validateGeneratedSql('SELECT $$DROP TABLE accounts$$ LIMIT 1').ok).toBe(false);
        });

        it('blocks unterminated string literals', () => {
            expect(validateGeneratedSql("SELECT 'unterminated FROM accounts LIMIT 1").ok).toBe(false);
        });

        it('blocks unbalanced parentheses', () => {
            expect(validateGeneratedSql('SELECT COUNT(* FROM book_splits LIMIT 5').ok).toBe(false);
        });

        it('blocks parameters other than $1', () => {
            const result = validateGeneratedSql('SELECT guid FROM book_splits WHERE memo = $2 LIMIT 5');
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/\$2/);
        });

        it('refuses schema-qualified relation names', () => {
            expect(validateGeneratedSql('SELECT a.name FROM public.accounts a LIMIT 10').ok).toBe(false);
        });

        it('refuses Object.prototype keys as relation names', () => {
            // `'constructor' in BOOK_RELATIONS` is true via the prototype chain.
            for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
                expect(validateGeneratedSql(`SELECT * FROM ${name} LIMIT 5`).ok).toBe(false);
            }
        });
    });

    // Off-limits tables from the 2026-08-03 audit (finding S3), each previously
    // reachable. They are not on the allowlist, so every form is refused.
    describe('relation allowlist', () => {
        const offLimits: [string, string][] = [
            ['password hashes', 'SELECT username, password_hash FROM gnucash_web_users'],
            ['AI provider keys', 'SELECT api_key_encrypted FROM gnucash_web_ai_config'],
            ['API token hashes', 'SELECT token_hash, user_id FROM gnucash_web_api_tokens'],
            ['TOTP seeds', 'SELECT secret FROM gnucash_web_totp'],
            ['every book', 'SELECT guid, root_account_guid FROM books'],
            ['other tenants', 'SELECT name, addr_email FROM customers'],
            ['joined via an allowed relation',
                'SELECT u.password_hash FROM book_accounts a JOIN gnucash_web_users u ON true'],
        ];

        it.each(offLimits)('refuses to read %s', (_label, sql) => {
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('still allows a CTE name defined in the same statement', () => {
            const sql =
                'WITH scoped AS (SELECT guid FROM book_accounts) SELECT COUNT(*) FROM scoped LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });
    });

    describe('castScopeParameter', () => {
        it('casts a real parameter', () => {
            expect(castScopeParameter('WHERE a.guid = ANY($1)')).toBe('WHERE a.guid = ANY($1::text[])');
        });

        it('leaves $1 inside a string literal alone', () => {
            // Previously rewrote the search term to '%$1::text[]%'.
            const sql = "WHERE a.name LIKE '%$1%' AND a.guid = ANY($1)";
            expect(castScopeParameter(sql)).toBe("WHERE a.name LIKE '%$1%' AND a.guid = ANY($1::text[])");
        });

        it('is idempotent for an already-cast parameter', () => {
            const sql = 'WHERE a.guid = ANY($1::text[])';
            expect(castScopeParameter(sql)).toBe(sql);
        });

        it('casts every occurrence in a multi-relation injected statement', () => {
            const result = validateGeneratedSql(
                'SELECT s.memo FROM book_splits s JOIN book_accounts a ON a.guid = s.account_guid LIMIT 5'
            );
            const cast = castScopeParameter(result.sql!);
            expect(cast.match(/\$1::text\[\]/g)).toHaveLength(2);
            expect(cast).not.toMatch(/\$1(?!::)/);
        });
    });
});
