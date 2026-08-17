/**
 * The lot engine's ordering guarantee, against a REAL PostgreSQL server.
 *
 * WHY THIS FILE EXISTS. The determinism the lot engine promises — revert a
 * scrub, re-scrub, get the same lots and the same taxable gains — rests on one
 * ORDER BY, the array orderBy in loadUnassignedSplits (src/lib/lot-assignment.ts):
 *
 *     orderBy: [{ transaction: { post_date: 'asc' } }, { tx_guid: 'asc' }, { guid: 'asc' }]
 *
 * The end-to-end tests for that promise run against the in-memory fake in
 * helpers/fake-prisma.ts, and the fake's array-orderBy support was written in
 * the same commit as the guarantee. That makes the fake a model of the
 * database, authored alongside the code it grades — so on its own it cannot
 * establish that the server orders rows the way the engine assumes.
 *
 * This file closes that gap. It issues the engine's own orderBy through the
 * application's Prisma client (so Prisma's SQL generation is what runs, not
 * hand-written SQL) over the SAME fixture rows and the SAME expectations that
 * ./fake-prisma-ordering.test.ts asserts the fake on. If the fake and the
 * server ever disagree, one of the two files goes red.
 *
 * The case that made this necessary: `transactions.post_date` is nullable, and
 * Postgres sorts NULL as GREATER than every value — NULLS LAST under ASC,
 * NULLS FIRST under DESC. The fake used to coerce a missing post_date to epoch
 * 0, putting it at the opposite end under both directions.
 *
 * DATA. Self-seeding and self-cleaning, per the tier's convention (see
 * vitest.integration.config.ts and ../../__tests__/integration/locking.integration.test.ts).
 * It assumes NOTHING pre-exists: it creates its own currency, its own account
 * and its own transactions, all carrying a per-run guid prefix, queries only
 * its own account, and deletes every row it wrote in afterAll. It runs
 * correctly against a completely empty database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTestPool } from '../../__tests__/integration/db';
import { hasTestDatabaseUrl } from '../../__tests__/integration/env';
import {
    EXPECTED_ASC_KEYS,
    EXPECTED_GUID_ONLY_KEYS,
    EXPECTED_POST_DATE_DESC_KEYS,
    ORDER_BY_ASC,
    ORDER_BY_GUID_ONLY,
    ORDER_BY_POST_DATE_DESC,
    RUN_PREFIX_LENGTH,
    SPLIT_ORDERING_ROWS,
    keysOf,
    orderingGuid,
    splitGuidOf,
    txGuidOf,
} from './helpers/split-ordering-fixture';

/** Skipped rather than thrown at module scope — see the locking test's note. */
const HAS_TEST_DATABASE = hasTestDatabaseUrl();

/**
 * Per-run prefix, so two runs (or a leftover from a killed one) cannot collide
 * and so the fixture's suffixes alone decide the relative guid order.
 */
const RUN_PREFIX = randomUUID().replace(/-/g, '').slice(0, RUN_PREFIX_LENGTH);

const CURRENCY_GUID = orderingGuid(RUN_PREFIX, 'cur');
const ACCOUNT_GUID = orderingGuid(RUN_PREFIX, 'acct');

/** Lazily imported so src/lib opens no pool when this suite skips. */
let prismaModule: typeof import('@/lib/prisma');

describe.skipIf(!HAS_TEST_DATABASE)('split ordering (real PostgreSQL)', () => {
    beforeAll(async () => {
        prismaModule = await import('@/lib/prisma');

        const pool = getTestPool();
        // A currency for the transactions' FK and the account's commodity.
        await pool.query(
            `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag)
             VALUES ($1, 'INTEGRATION-TEST', $2, 'Ordering fixture currency', 100, 0)`,
            [CURRENCY_GUID, `ORD${RUN_PREFIX.slice(0, 8)}`],
        );
        // parent_guid NULL: this test needs one account to hang splits off, not
        // a hierarchy, and it must not depend on a root account existing.
        await pool.query(
            `INSERT INTO accounts
                 (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu,
                  parent_guid, code, description, hidden, placeholder)
             VALUES ($1, $2, 'STOCK', $3, 100, 0, NULL, '', 'Ordering fixture', 0, 0)`,
            [ACCOUNT_GUID, `Ordering fixture ${RUN_PREFIX}`, CURRENCY_GUID],
        );

        for (const row of SPLIT_ORDERING_ROWS) {
            const txGuid = txGuidOf(row, RUN_PREFIX);
            // Rows may share a transaction (the guid-tiebreak pair does).
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', $3, NOW(), $4)
                 ON CONFLICT (guid) DO NOTHING`,
                [txGuid, CURRENCY_GUID, row.postDate, `ordering ${row.key}`],
            );
            // lot_guid NULL is what loadUnassignedSplits filters on.
            await pool.query(
                `INSERT INTO splits
                     (guid, tx_guid, account_guid, memo, action, reconcile_state,
                      reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                 VALUES ($1, $2, $3, '', '', 'n', NULL, 0, 100, 0, 100, NULL)`,
                [splitGuidOf(row, RUN_PREFIX), txGuid, ACCOUNT_GUID],
            );
        }
    });

    afterAll(async () => {
        // Children first: splits reference transactions and accounts, which
        // reference the commodity. TEST_DATABASE_URL is often a long-lived
        // local database, so nothing written above may survive this hook.
        const pool = getTestPool();
        await pool.query('DELETE FROM splits WHERE account_guid = $1', [ACCOUNT_GUID]);
        await pool.query(
            'DELETE FROM transactions WHERE currency_guid = $1',
            [CURRENCY_GUID],
        );
        await pool.query('DELETE FROM accounts WHERE guid = $1', [ACCOUNT_GUID]);
        await pool.query('DELETE FROM commodities WHERE guid = $1', [CURRENCY_GUID]);
        // The dynamic import above opened the application's own pool, which the
        // tier's closeTestPool cannot reach.
        await prismaModule?.default.$disconnect();
    });

    /** The engine's own query shape, with whichever orderBy is under test. */
    async function orderedKeys(orderBy: unknown): Promise<string[]> {
        const rows = await prismaModule.default.splits.findMany({
            where: { account_guid: ACCOUNT_GUID, lot_guid: null },
            include: { transaction: { select: { post_date: true } } },
            orderBy: orderBy as never,
        });
        return keysOf(rows, RUN_PREFIX);
    }

    it('seeds exactly the fixture and nothing else', async () => {
        // Proves the assertions below are reading this run's rows only, and
        // that the seed did not silently lose one to ON CONFLICT DO NOTHING.
        const rows = await orderedKeys(ORDER_BY_ASC);
        expect(rows).toHaveLength(SPLIT_ORDERING_ROWS.length);
        expect(rows.filter(k => k.startsWith('unknown:'))).toEqual([]);
    });

    it('sorts post_date ASC with NULLS LAST, then tx_guid, then guid', async () => {
        // The literal ordering loadUnassignedSplits issues, run by the server.
        // This is the assertion the fake was previously the only witness to.
        expect(await orderedKeys(ORDER_BY_ASC)).toEqual([...EXPECTED_ASC_KEYS]);
    });

    it('sorts post_date DESC with NULLS FIRST', async () => {
        // The asymmetry is the point: Postgres puts NULL — the largest value —
        // first under DESC, so "nulls at the end" is not a direction-independent
        // rule and cannot be implemented as one.
        expect(await orderedKeys(ORDER_BY_POST_DATE_DESC))
            .toEqual([...EXPECTED_POST_DATE_DESC_KEYS]);
    });

    it('reads later keys only to break ties in the earlier ones', async () => {
        // Left-to-right precedence, plus the fixture's one collation
        // assumption: these suffixes order the same way under any lc_collate.
        const byGuidOnly = await orderedKeys(ORDER_BY_GUID_ONLY);
        expect(byGuidOnly).not.toEqual([...EXPECTED_ASC_KEYS]);
        expect(byGuidOnly).toEqual([...EXPECTED_GUID_ONLY_KEYS]);
    });
});
