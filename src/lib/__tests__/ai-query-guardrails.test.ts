// src/lib/__tests__/ai-query-guardrails.test.ts

import { describe, it, expect } from 'vitest';
import { validateGeneratedSql, MAX_LIMIT } from '../ai-query/guardrails';
import { castScopeParameter } from '../ai-query/execute';

const SCOPED_SELECT =
    "SELECT ROUND(SUM(s.value_num::numeric / s.value_denom), 2) AS total " +
    "FROM splits s JOIN accounts a ON a.guid = s.account_guid " +
    "WHERE s.account_guid = ANY($1) AND a.account_type = 'EXPENSE' LIMIT 100";

describe('validateGeneratedSql', () => {
    describe('allows valid read-only statements', () => {
        it('allows a plain SELECT', () => {
            const result = validateGeneratedSql('SELECT 1 AS one LIMIT 1');
            expect(result.ok).toBe(true);
            expect(result.sql).toBe('SELECT 1 AS one LIMIT 1');
        });

        it('allows a book-scoped SELECT over splits/accounts', () => {
            const result = validateGeneratedSql(SCOPED_SELECT);
            expect(result.ok).toBe(true);
        });

        it('allows WITH ... SELECT (read-only CTE)', () => {
            const sql =
                'WITH expense_accounts AS (SELECT guid FROM account_hierarchy WHERE guid = ANY($1)) ' +
                'SELECT COUNT(*) FROM expense_accounts LIMIT 10';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
        });

        it('allows lowercase select', () => {
            const result = validateGeneratedSql('select 42 as answer limit 5');
            expect(result.ok).toBe(true);
        });

        it('tolerates a single trailing semicolon', () => {
            const result = validateGeneratedSql('SELECT 1 LIMIT 1;');
            expect(result.ok).toBe(true);
            expect(result.sql).toBe('SELECT 1 LIMIT 1');
        });

        it('tolerates leading/trailing whitespace', () => {
            const result = validateGeneratedSql('  \n SELECT 1 LIMIT 1 \n ');
            expect(result.ok).toBe(true);
        });
    });

    describe('blocks mutation and DDL keywords', () => {
        const forbidden: [string, string][] = [
            ['INSERT', 'INSERT INTO accounts (guid) VALUES (\'x\')'],
            ['UPDATE', 'UPDATE accounts SET name = \'x\' WHERE guid = ANY($1)'],
            ['DELETE', 'DELETE FROM splits WHERE account_guid = ANY($1)'],
            ['DROP', 'DROP TABLE accounts'],
            ['ALTER', 'ALTER TABLE accounts ADD COLUMN x int'],
            ['CREATE', 'CREATE TABLE evil (id int)'],
            ['TRUNCATE', 'TRUNCATE splits'],
            ['GRANT', 'GRANT ALL ON accounts TO public'],
            ['REVOKE', 'REVOKE ALL ON accounts FROM public'],
            ['COPY', 'COPY accounts TO \'/tmp/x\''],
            ['EXECUTE', 'EXECUTE some_prepared_statement'],
            ['DO', 'DO $x$ BEGIN NULL; END $x$'],
            ['SET', 'SET statement_timeout = 0'],
        ];

        it.each(forbidden)('blocks %s', (_kw, sql) => {
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('blocks lowercase mutation keywords', () => {
            expect(validateGeneratedSql('delete from splits where account_guid = any($1)').ok).toBe(false);
        });

        it('blocks mixed-case mutation keywords', () => {
            expect(validateGeneratedSql('DeLeTe FROM splits WHERE account_guid = ANY($1)').ok).toBe(false);
        });

        it('blocks mutation keywords buried inside a SELECT (data-modifying CTE)', () => {
            const sql =
                'WITH gone AS (DELETE FROM splits WHERE account_guid = ANY($1) RETURNING *) ' +
                'SELECT COUNT(*) FROM gone LIMIT 1';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/DELETE/);
        });

        it('blocks set_config() smuggled into a SELECT', () => {
            const sql = "SELECT set_config('statement_timeout', '0', false) LIMIT 1";
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('does NOT false-positive on keywords inside string literals', () => {
            // Tradeoff (documented in guardrails.ts): keyword scanning is a
            // word-boundary regex applied AFTER masking string literal contents,
            // so quoted search terms containing keywords stay legal.
            const sql =
                "SELECT t.description FROM transactions t " +
                "JOIN splits s ON s.tx_guid = t.guid " +
                "WHERE s.account_guid = ANY($1) AND t.description ILIKE '%DELETE%' LIMIT 20";
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('handles escaped quotes inside literals without leaking keyword text', () => {
            const sql =
                "SELECT t.description FROM transactions t " +
                "JOIN splits s ON s.tx_guid = t.guid " +
                "WHERE s.account_guid = ANY($1) AND t.description = 'Bob''s DROP shop' LIMIT 20";
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('does not false-positive on identifiers that merely contain keywords', () => {
            // reconcile_state contains no standalone forbidden word; OFFSET contains "set".
            const sql =
                "SELECT s.reconcile_state FROM splits s WHERE s.account_guid = ANY($1) " +
                'LIMIT 10 OFFSET 5';
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
            const sql =
                "SELECT t.description FROM transactions t " +
                "JOIN splits s ON s.tx_guid = t.guid " +
                "WHERE s.account_guid = ANY($1) AND t.description = 'a;b' LIMIT 5";
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
    });

    describe('requires the $1 book-scope parameter', () => {
        it('blocks accounts reference without $1', () => {
            const result = validateGeneratedSql('SELECT name FROM accounts LIMIT 10');
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/\$1/);
        });

        it('blocks splits reference without $1', () => {
            expect(validateGeneratedSql('SELECT SUM(value_num) FROM splits LIMIT 10').ok).toBe(false);
        });

        it('blocks transactions reference without $1', () => {
            expect(validateGeneratedSql('SELECT description FROM transactions LIMIT 10').ok).toBe(false);
        });

        it('blocks account_hierarchy reference without $1', () => {
            expect(validateGeneratedSql('SELECT fullname FROM account_hierarchy LIMIT 10').ok).toBe(false);
        });

        it('allows table-free SELECTs without $1', () => {
            expect(validateGeneratedSql('SELECT 1 + 1 AS two LIMIT 1').ok).toBe(true);
        });
    });

    describe('LIMIT enforcement', () => {
        it('injects LIMIT when absent', () => {
            const result = validateGeneratedSql('SELECT guid FROM accounts WHERE guid = ANY($1)');
            expect(result.ok).toBe(true);
            expect(result.sql).toBe(`SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT ${MAX_LIMIT}`);
        });

        it(`caps LIMIT at ${MAX_LIMIT}`, () => {
            const result = validateGeneratedSql('SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT 5000');
            expect(result.ok).toBe(true);
            expect(result.sql).toBe(`SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT ${MAX_LIMIT}`);
        });

        it(`leaves LIMIT ${MAX_LIMIT} unchanged`, () => {
            const sql = `SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT ${MAX_LIMIT}`;
            expect(validateGeneratedSql(sql).sql).toBe(sql);
        });

        it('leaves a small LIMIT unchanged', () => {
            const sql = 'SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT 25';
            expect(validateGeneratedSql(sql).sql).toBe(sql);
        });

        it('caps lowercase limit too', () => {
            const result = validateGeneratedSql('select guid from accounts where guid = any($1) limit 999');
            expect(result.ok).toBe(true);
            expect(result.sql).toContain(`limit ${MAX_LIMIT}`);
            expect(result.sql).not.toContain('999');
        });

        it('caps every oversized LIMIT, including in subqueries', () => {
            const sql =
                'SELECT * FROM (SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT 1000) sub LIMIT 500';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql).not.toMatch(/1000|500/);
            expect(result.sql!.match(new RegExp(`LIMIT ${MAX_LIMIT}`, 'gi'))).toHaveLength(2);
        });

        it('rejects a non-numeric LIMIT', () => {
            expect(validateGeneratedSql('SELECT guid FROM accounts WHERE guid = ANY($1) LIMIT ALL').ok).toBe(false);
        });
    });

    describe('hardening against scanner evasion', () => {
        it('blocks pg_ system objects', () => {
            expect(validateGeneratedSql('SELECT * FROM pg_tables LIMIT 10').ok).toBe(false);
            expect(validateGeneratedSql('SELECT pg_sleep(10) LIMIT 1').ok).toBe(false);
        });

        it('blocks information_schema', () => {
            expect(validateGeneratedSql('SELECT table_name FROM information_schema.tables LIMIT 10').ok).toBe(false);
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
    });

    // Regression tests for the 2026-08-03 audit. Each case was ALLOWED by the
    // pre-audit guardrails; see docs/audit-2026-08-03.md finding S3.
    describe('relation allowlist', () => {
        const offLimits: [string, string][] = [
            ['password hashes', 'SELECT username, password_hash FROM gnucash_web_users'],
            ['AI provider keys', 'SELECT api_key_encrypted FROM gnucash_web_ai_config'],
            ['API token hashes', 'SELECT token_hash, user_id FROM gnucash_web_api_tokens'],
            ['TOTP seeds', 'SELECT secret FROM gnucash_web_totp'],
            ['every book', 'SELECT guid, root_account_guid FROM books'],
            ['other tenants', 'SELECT name, addr_email FROM customers'],
            ['joined via an allowed table',
                'SELECT u.password_hash FROM accounts a JOIN gnucash_web_users u ON true WHERE a.guid = ANY($1)'],
        ];

        for (const [label, sql] of offLimits) {
            it(`refuses to read ${label}`, () => {
                expect(validateGeneratedSql(sql).ok).toBe(false);
            });
        }

        it('refuses schema-qualified relation names', () => {
            expect(validateGeneratedSql(
                'SELECT a.name FROM public.accounts a WHERE a.guid = ANY($1) LIMIT 10'
            ).ok).toBe(false);
        });

        it('still allows a CTE name defined in the same statement', () => {
            const sql =
                'WITH scoped AS (SELECT guid FROM accounts WHERE guid = ANY($1)) ' +
                'SELECT COUNT(*) FROM scoped LIMIT 10';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });
    });

    describe('book scope must be BOUND, not merely mentioned', () => {
        it('rejects an always-true predicate that only name-drops $1', () => {
            // Returned every account in the database — all books, all users.
            const sql = 'SELECT a.name, a.guid FROM accounts a WHERE $1 IS NOT NULL';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('rejects $1 used in an unrelated comparison', () => {
            const sql = 'SELECT a.name FROM accounts a WHERE array_length($1, 1) > 0';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('accepts account_guid = ANY($1)', () => {
            const sql = 'SELECT s.guid FROM splits s WHERE s.account_guid = ANY($1) LIMIT 5';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('accepts a cast binding', () => {
            const sql = 'SELECT s.guid FROM splits s WHERE s.account_guid = ANY($1::text[]) LIMIT 5';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('rejects an unscoped relation even when another table uses $1', () => {
            const sql =
                'SELECT t.description FROM transactions t, splits s ' +
                'WHERE s.account_guid = ANY($1) LIMIT 20';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('accepts a transaction relation joined to a scoped split relation', () => {
            const sql =
                'SELECT t.description FROM transactions t ' +
                'JOIN splits s ON s.tx_guid = t.guid ' +
                'WHERE s.account_guid = ANY($1) LIMIT 20';
            expect(validateGeneratedSql(sql).ok).toBe(true);
        });

        it('rejects transaction GUIDs bound directly to the account-guid parameter', () => {
            const sql = 'SELECT t.description FROM transactions t WHERE t.guid = ANY($1) LIMIT 20';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });

        it('rejects comma joins that could hide an unscoped relation', () => {
            const sql =
                'SELECT a.name, s.value_num FROM accounts a, splits s ' +
                'WHERE a.guid = ANY($1) LIMIT 20';
            expect(validateGeneratedSql(sql).ok).toBe(false);
        });
    });

    describe('LIMIT must bound the outer result set', () => {
        it('injects a top-level LIMIT when the only LIMIT is inside a CTE', () => {
            // Returned 100 x every split without an outer bound.
            const sql =
                'WITH t AS (SELECT guid FROM accounts WHERE accounts.guid = ANY($1) LIMIT 100) ' +
                'SELECT t.guid, s.value_num FROM t CROSS JOIN splits s ' +
                'WHERE s.account_guid = ANY($1)';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql).toMatch(new RegExp(`LIMIT ${MAX_LIMIT}$`));
        });

        it('does not double-append when a top-level LIMIT is already present', () => {
            const sql = 'SELECT s.guid FROM splits s WHERE s.account_guid = ANY($1) LIMIT 10';
            const result = validateGeneratedSql(sql);
            expect(result.ok).toBe(true);
            expect(result.sql!.match(/LIMIT/gi)).toHaveLength(1);
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
    });
});
