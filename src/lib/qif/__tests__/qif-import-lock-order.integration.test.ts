/**
 * The ABBA deadlock between two concurrent QIF IMPORTS, proven against a REAL
 * PostgreSQL database.
 *
 * ## What is being proven
 *
 * `executeQifImport` (src/lib/qif/importer.ts) walks `plan.accountsToCreate`
 * and hands each entry to `findOrCreateAccountDetailed`, which claims
 * `account:(parent, name)` for every segment it has to create.
 *
 * That list is built from USER INPUT — the order the QIF file happens to list
 * its accounts and categories in. Two people importing two different files
 * into the SAME book therefore used to claim shared sibling keys in whatever
 * order their two authors typed them:
 *
 *     T1 (file lists A then B)   holds  account:(root, A)   wants  ...(root, B)
 *     T2 (file lists B then A)   holds  account:(root, B)   wants  ...(root, A)
 *
 * `pg_advisory_xact_lock` is held to COMMIT, so neither can yield. PostgreSQL
 * breaks the cycle by aborting one importer with SQLSTATE 40P01, and that user
 * sees a failed import.
 *
 * The same argument applies verbatim to `commitPersonalImport`
 * (src/lib/import/personal-import.service.ts), which walks a planned account
 * list built the same way from the same kind of user input, and which took the
 * same two-part fix below.
 *
 * ## The fix these tests pin, and why it is the BOOK lock
 *
 * The key set here is not knowable up front in any useful sense: it is
 * whatever arbitrary tree the uploaded file describes. So rather than ordering
 * the claims, both importers now SERIALIZE — `acquireBookLock(tx, bookGuid)`
 * as the first statement of the import transaction, exactly the precedent the
 * XML importer already set (src/lib/gnucash-xml/importer.ts). An import is a
 * heavyweight, user-initiated operation; two of them running into one book at
 * once have nothing to gain from interleaving.
 *
 * The planned accounts are ALSO sorted into the canonical acquisition order
 * (src/lib/account-lock-order.ts) before any of them is claimed, so the
 * ordering invariant holds on its own terms rather than only because the book
 * lock hid the question.
 *
 * ## The two halves of this file
 *
 * 1. `reproduces the pre-fix cycle` drives the OLD interleaving directly
 *    against the database — two connections claiming the two keys in opposite
 *    orders, the way the unserialized, unsorted loop did — and asserts a real
 *    40P01 arrives. Without it the second test proves only that something did
 *    not happen, which any bug in the harness also achieves.
 * 2. `two opposed imports do not deadlock` runs the REAL `executeQifImport` on
 *    both sides and asserts neither reports 40P01, both commit, and exactly
 *    one row lands on each contended sibling key.
 *
 * ## Test data
 *
 * Everything carries a per-run suffix and is deleted in afterAll, which then
 * asserts an exact COUNT of zero residue — this tier does not truncate and
 * does not roll back. See vitest.integration.config.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getTestPool } from '@/__tests__/integration/db';
import { describeSettled, isDeadlock } from '@/__tests__/integration/deadlock';

const guid = () => randomUUID().replace(/-/g, '');
/** Distinguishes this run's rows from any other tier sharing the database. */
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

const BOOK_GUID = guid();
const ROOT_GUID = guid();
const CURRENCY_GUID = guid();

/**
 * Two sibling names with a KNOWN sort relation, because the fix claims in
 * sorted order and the test must be able to say which key that makes first.
 */
const NAME_A = `AA ${RUN}`;
const NAME_B = `ZZ ${RUN}`;

const DB_TIMEOUT_MS = 60_000;
/** Under Prisma's interactive-transaction timeout — see the sibling file. */
const PARK_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('QIF import lock order: two concurrent imports into one book', () => {
    const pool = getTestPool();
    let executeQifImport: (typeof import('@/lib/qif/importer'))['executeQifImport'];
    let prisma: (typeof import('@/lib/prisma'))['default'];

    beforeAll(async () => {
        await pool.query(
            `INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
             VALUES ($1, 'CURRENCY', $2, $2, '', 100, 0, '', '')`,
            [CURRENCY_GUID, `QQ${RUN}`.slice(0, 8)],
        );
        await pool.query(
            `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
             VALUES ($1, $2, 'ROOT', $3, 100, 0, NULL, '', '', 0, 1)`,
            [ROOT_GUID, `Root ${RUN}`, CURRENCY_GUID],
        );
        await pool.query(
            `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
             VALUES ($1, $2, $2, $3)`,
            [BOOK_GUID, ROOT_GUID, `QIF order book ${RUN}`],
        );

        executeQifImport = (await import('@/lib/qif/importer')).executeQifImport;
        prisma = (await import('@/lib/prisma')).default;
        // Warm the pool: a connection established mid-race would add latency
        // to the very step whose blocking is being observed.
        await prisma.$queryRaw`SELECT 1 AS warm`;
    }, DB_TIMEOUT_MS);

    afterAll(async () => {
        await prisma?.$disconnect();
        await pool.query('DELETE FROM books WHERE guid = $1', [BOOK_GUID]);
        // Deepest first: accounts.parent_guid is a real FK.
        await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [ROOT_GUID]);
        await pool.query('DELETE FROM accounts WHERE guid = $1', [ROOT_GUID]);
        await pool.query('DELETE FROM commodities WHERE guid = $1', [CURRENCY_GUID]);

        // The rollback substitute: nothing this run wrote survives it. Counted
        // by NAME as well as by guid, so a row created under some guid this
        // file never saw cannot slip past.
        const residue = await pool.query<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM accounts WHERE guid = $1 OR parent_guid = $1 OR name LIKE $2)
                  + (SELECT COUNT(*) FROM books WHERE guid = $3)
                  + (SELECT COUNT(*) FROM commodities WHERE guid = $4 OR mnemonic LIKE $2) AS n`,
            [ROOT_GUID, `%${RUN}%`, BOOK_GUID, CURRENCY_GUID],
        );
        expect(Number(residue.rows[0].n)).toBe(0);
    }, DB_TIMEOUT_MS);

    /** The key `findOrCreateAccountDetailed` claims for a root-level name. */
    const siblingKey = (name: string) => `account:${ROOT_GUID}:${name}`;

    async function backendPid(client: PoolClient): Promise<number> {
        const res = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return Number(res.rows[0].pid);
    }

    /**
     * Waits until PostgreSQL reports a backend in THIS database blocked
     * specifically BY `blockerPid`. `pg_blocking_pids` names the blocker, so
     * this is a real wait-for edge rather than the weaker inference from
     * "something somewhere is not granted".
     */
    async function waitForBlockedBy(blockerPid: number): Promise<number> {
        const deadline = Date.now() + PARK_TIMEOUT_MS;
        let seen = 0;
        while (Date.now() < deadline) {
            const res = await pool.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n
                   FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND pid <> pg_backend_pid()
                    AND pg_blocking_pids(pid) @> ARRAY[$1]::int[]`,
                [blockerPid],
            );
            seen = Number(res.rows[0].n);
            if (seen >= 1) return seen;
            await sleep(20);
        }
        return seen;
    }

    /** How many REAL accounts currently sit on (root, name). */
    async function siblingsOn(name: string): Promise<number> {
        const res = await pool.query<{ n: number }>(
            'SELECT COUNT(*)::int AS n FROM accounts WHERE parent_guid = $1 AND name = $2',
            [ROOT_GUID, name],
        );
        return Number(res.rows[0].n);
    }

    it(
        'reproduces the pre-fix cycle: two files listing the same siblings in opposite orders deadlock',
        async () => {
            const first: PoolClient = await pool.connect();
            const second: PoolClient = await pool.connect();
            try {
                await first.query('BEGIN');
                await second.query('BEGIN');
                await first.query("SET LOCAL lock_timeout = '20s'");
                await second.query("SET LOCAL lock_timeout = '20s'");

                // Each import claims the first key ITS file listed.
                await first.query('SELECT pg_advisory_xact_lock(hashtext($1))', [siblingKey(NAME_A)]);
                await second.query('SELECT pg_advisory_xact_lock(hashtext($1))', [siblingKey(NAME_B)]);

                const firstPid = await backendPid(first);
                const secondPid = await backendPid(second);

                // Now each reaches for the other's. Neither can yield:
                // pg_advisory_xact_lock is released only at COMMIT.
                const firstWait = first
                    .query('SELECT pg_advisory_xact_lock(hashtext($1))', [siblingKey(NAME_B)])
                    .catch((e: unknown) => e);
                expect(await waitForBlockedBy(secondPid)).toBeGreaterThanOrEqual(1);

                const secondWait = second
                    .query('SELECT pg_advisory_xact_lock(hashtext($1))', [siblingKey(NAME_A)])
                    .catch((e: unknown) => e);
                expect(await waitForBlockedBy(firstPid)).toBeGreaterThanOrEqual(1);

                const outcomes = await Promise.all([firstWait, secondWait]);

                // THE POINT OF THIS TEST. PostgreSQL detects the cycle and
                // aborts exactly one side with 40P01. If this ever stops being
                // true the second test below proves nothing.
                expect(
                    outcomes.filter(isDeadlock).length,
                    `expected exactly one 40P01, got: ${outcomes.map(o => String((o as Error)?.message ?? o)).join(' | ')}`,
                ).toBe(1);
            } finally {
                await first.query('ROLLBACK').catch(() => {});
                await second.query('ROLLBACK').catch(() => {});
                first.release();
                second.release();
            }
        },
        DB_TIMEOUT_MS,
    );

    it(
        'two opposed imports do not deadlock, and neither doubles a sibling',
        async () => {
            const planned = (name: string) => ({
                key: name,
                path: name,
                anchorGuid: ROOT_GUID,
                displayPath: name,
                accountType: 'EXPENSE',
                reason: 'category' as const,
            });
            const plan = (order: string[]) => ({
                bookGuid: BOOK_GUID,
                bookRootGuid: ROOT_GUID,
                currencyGuid: CURRENCY_GUID,
                accountsToCreate: order.map(planned),
                transactions: [],
                skippedDuplicates: [],
                transferPairsDeduped: 0,
                accountMappings: [],
                categoryMappings: [],
                warnings: [],
            });

            // The two files list the same two categories the other way round.
            // That input is what used to decide the claim order.
            const forward = executeQifImport(plan([NAME_A, NAME_B]));
            const backward = executeQifImport(plan([NAME_B, NAME_A]));
            forward.catch(() => {});
            backward.catch(() => {});

            const [f, b] = await Promise.allSettled([forward, backward]);

            // THE INVARIANT. Asserted first, with the offending error attached,
            // so a regression reports the deadlock rather than a downstream
            // symptom.
            expect(
                {
                    forward: isDeadlock(f.status === 'rejected' ? f.reason : null),
                    backward: isDeadlock(b.status === 'rejected' ? b.reason : null),
                },
                `deadlock (40P01) reported.\n  [A,B]: ${describeSettled(f)}\n  [B,A]: ${describeSettled(b)}`,
            ).toEqual({ forward: false, backward: false });

            expect(f.status, `[A,B]: ${describeSettled(f)}`).toBe('fulfilled');
            expect(b.status, `[B,A]: ${describeSettled(b)}`).toBe('fulfilled');

            // The duplicate-sibling invariant the whole branch exists for: the
            // loser of the race for a key adopted the row the winner had
            // committed rather than inserting a second one.
            expect(await siblingsOn(NAME_A)).toBe(1);
            expect(await siblingsOn(NAME_B)).toBe(1);

            // And between them the two imports created exactly two accounts.
            const totals = [f, b].map(s => (s.status === 'fulfilled' ? s.value.accountsCreated : -1));
            expect(totals.reduce((sum, n) => sum + n, 0)).toBe(2);
        },
        DB_TIMEOUT_MS,
    );
});
