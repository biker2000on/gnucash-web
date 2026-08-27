/**
 * finalizeReconciliation against real PostgreSQL.
 *
 * Regression (2026-08-27): the session-completion statements build the audit
 * metadata with `jsonb_build_object('statementEndingBalance', $n)`. That
 * function's parameters are variadic "any", so Postgres cannot infer the
 * bind parameter's type and every manual finalize with a completion payload
 * failed with 42P18 "could not determine data type of parameter" — in
 * production, from 6f309a17 (2026-08-14) until this test's fix cast the
 * parameter to ::text. The unit tier can never see this: only a real server
 * runs the type-inference that rejects it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool } from './db';
import { hasTestDatabaseUrl } from './env';

const HAS_TEST_DATABASE = hasTestDatabaseUrl();

const RUN_ID = randomUUID().replace(/-/g, '');

/** GnuCash guid columns are VARCHAR(32); a dash-stripped uuid is exactly 32. */
function testGuid(): string {
    return randomUUID().replace(/-/g, '');
}

const CURRENCY_GUID = testGuid();
const BOOK_GUID = testGuid();
const ACCOUNT_GUID = testGuid();
const CASH_ACCOUNT_GUID = testGuid();
const TX_GUID = testGuid();
const SPLIT_GUID = testGuid();
const CASH_SPLIT_GUID = testGuid();
let userId = 0;

let reconcile: typeof import('@/lib/reconcile');
let prismaModule: typeof import('@/lib/prisma');

describe.skipIf(!HAS_TEST_DATABASE)('finalizeReconciliation (real PostgreSQL)', () => {
    beforeAll(async () => {
        // Dynamic: keeps application modules - and the connection pools they
        // open at import time - out of module evaluation when this file is
        // skipped for want of a database.
        reconcile = await import('@/lib/reconcile');
        prismaModule = await import('@/lib/prisma');

        const pool = getTestPool();
        // The sessions table has a real FK to gnucash_web_users.
        const user = await pool.query(
            `INSERT INTO gnucash_web_users (username, auth_method) VALUES ($1, 'password') RETURNING id`,
            [`reconcile-itest-${RUN_ID.slice(0, 16)}`],
        );
        userId = user.rows[0].id;
        await pool.query(
            `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag)
             VALUES ($1, 'INTEGRATION-TEST', $2, 'Integration test currency', 100, 0)`,
            [CURRENCY_GUID, `RTEST${RUN_ID.slice(0, 8)}`],
        );
        await pool.query(
            `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, code, description, hidden, placeholder)
             VALUES ($1, $2, 'BANK', $3, 100, 0, '', 'reconcile finalize fixture', 0, 0),
                    ($4, $5, 'BANK', $3, 100, 0, '', 'reconcile finalize offset', 0, 0)`,
            [ACCOUNT_GUID, `Reconcile fixture ${RUN_ID}`, CURRENCY_GUID, CASH_ACCOUNT_GUID, `Reconcile offset ${RUN_ID}`],
        );
        await pool.query(
            `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
             VALUES ($1, $2, '', NOW() - INTERVAL '2 days', NOW(), $3)`,
            [TX_GUID, CURRENCY_GUID, `reconcile finalize fixture ${RUN_ID}`],
        );
        await pool.query(
            `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date,
                                 value_num, value_denom, quantity_num, quantity_denom)
             VALUES ($1, $2, $3, '', '', 'n', NULL, 12345, 100, 12345, 100),
                    ($4, $2, $5, '', '', 'n', NULL, -12345, 100, -12345, 100)`,
            [SPLIT_GUID, TX_GUID, ACCOUNT_GUID, CASH_SPLIT_GUID, CASH_ACCOUNT_GUID],
        );
    });

    afterAll(async () => {
        // Leave the database as it was found: TEST_DATABASE_URL is frequently a
        // developer's long-lived local database, not a fresh container.
        const pool = getTestPool();
        await pool.query('DELETE FROM gnucash_web_reconciliation_sessions WHERE account_guid = $1', [ACCOUNT_GUID]);
        await pool.query('DELETE FROM splits WHERE tx_guid = $1', [TX_GUID]);
        await pool.query('DELETE FROM transactions WHERE guid = $1', [TX_GUID]);
        await pool.query('DELETE FROM accounts WHERE guid IN ($1, $2)', [ACCOUNT_GUID, CASH_ACCOUNT_GUID]);
        await pool.query('DELETE FROM commodities WHERE guid = $1', [CURRENCY_GUID]);
        if (userId) await pool.query('DELETE FROM gnucash_web_users WHERE id = $1', [userId]);
        await prismaModule?.default.$disconnect();
    });

    it('finalizes with a completion payload and records the session metadata', async () => {
        const statementDate = new Date();
        statementDate.setUTCHours(0, 0, 0, 0);

        const result = await reconcile.finalizeReconciliation(
            ACCOUNT_GUID,
            statementDate,
            '123.45',
            [SPLIT_GUID],
            undefined,
            {
                bookGuid: BOOK_GUID,
                userId,
                sessionId: null,
                interactionDelta: 3,
            },
            false,
            100,
        );

        expect(result.reconciledSplits).toBe(1);

        const pool = getTestPool();
        const split = await pool.query(
            'SELECT reconcile_state FROM splits WHERE guid = $1',
            [SPLIT_GUID],
        );
        expect(split.rows[0].reconcile_state).toBe('y');

        // The completion insert is what carried the untypable jsonb parameter.
        const session = await pool.query(
            `SELECT status, interaction_count, metadata
             FROM gnucash_web_reconciliation_sessions
             WHERE account_guid = $1 AND user_id = $2`,
            [ACCOUNT_GUID, userId],
        );
        expect(session.rowCount).toBe(1);
        expect(session.rows[0].status).toBe('completed');
        expect(session.rows[0].interaction_count).toBe(3);
        expect(session.rows[0].metadata).toEqual({ statementEndingBalance: '123.45' });
    });
});
