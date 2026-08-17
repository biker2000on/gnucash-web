/**
 * The LOCK-ORDERING deadlock between a template graft and a concurrent
 * rename, proven against a REAL PostgreSQL database on three connections.
 *
 * ## What is being proven
 *
 * Two locks guard a sibling key, and they must always be taken in the same
 * order:
 *
 *     level 2   the row lock on the account being changed  (SELECT ... FOR UPDATE)
 *     level 3   the per-(parent, name) advisory lock       (pg_advisory_xact_lock)
 *
 * `AccountService.update`/`.move` take them 2-then-3: the row lock first, then
 * the destination key derived from what that lock read (see `lockAccountKey`
 * in ../account.service.ts).
 *
 * `addTemplateAccounts` used to take them 3-then-2. Walking its template in one
 * pass, it claimed a name key to create a missing sibling and then — still
 * holding that key, because `pg_advisory_xact_lock` is only released at COMMIT
 * — issued an UPDATE against an account that already existed, to promote it to
 * a placeholder. Those two orders close a wait-for cycle:
 *
 *     T1 graft   holds  account:(P,'Z')    wants  row lock on E
 *     T2 rename  holds  row lock on E      wants  account:(P,'Z')
 *
 * The per-book advisory lock does not prevent it. A plain rename takes no book
 * lock at all, so the graft's `acquireBookLock` excludes nobody here.
 *
 * PostgreSQL detects the cycle and aborts one side with SQLSTATE 40P01, which
 * is what makes this directly testable rather than merely arguable: the test
 * asserts that NEITHER side comes back with 40P01, and that both reach a
 * correct terminal state.
 *
 * ## How the interleaving is made deterministic
 *
 * Not with sleeps or `Promise.all` luck. Advisory-lock waiters are served FIFO,
 * and that is the whole mechanism:
 *
 *   1. a blocker connection takes `account:(P,'Z')` and holds it;
 *   2. the graft starts and queues on that key — FIRST in line;
 *   3. the rename starts, takes E's row lock on the way past, and queues on the
 *      same key — SECOND in line;
 *   4. the blocker commits. The graft is served first, so it now holds the key
 *      the rename is still waiting for, and walks on into the UPDATE of E whose
 *      row lock the rename holds. Cycle closed.
 *
 * Each step waits for PostgreSQL itself to report the expected backend blocked
 * — by `pg_blocking_pids`, against the blocker's own pid — so a run where the
 * interleaving did not happen fails rather than passing vacuously.
 *
 * After the fix the same script produces no cycle: the graft reconciles every
 * account that ALREADY exists (E's placeholder) in a first phase that holds no
 * name lock, and only then claims keys to insert what is missing. At step 3 the
 * rename therefore queues on E's ROW lock rather than overtaking into the name
 * lock, and at step 4 the graft finishes and the rename is refused for the
 * ordinary reason: the key it wanted is now occupied.
 *
 * ## Test data
 *
 * Everything written here carries a per-run suffix and is deleted in afterAll,
 * which then asserts an exact COUNT of zero residue — this tier does not
 * truncate and does not roll back. See vitest.integration.config.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

/** See the identical resolver in account-rename-reparent-race.integration.test.ts. */
function resolveTestDatabaseUrl(): string | null {
    const fromEnv = process.env.TEST_DATABASE_URL?.trim();
    if (fromEnv) return fromEnv;
    const candidates = [
        path.resolve(process.cwd(), '.env.test.local'),
        path.resolve(process.cwd(), '../../.env.test.local'),
    ];
    for (const file of candidates) {
        if (!existsSync(file)) continue;
        const match = readFileSync(file, 'utf8').match(/^\s*TEST_DATABASE_URL\s*=\s*(.+)\s*$/m);
        const url = match?.[1]?.trim().replace(/^["']|["']$/g, '');
        if (url) return url;
    }
    return null;
}

const TEST_DATABASE_URL = resolveTestDatabaseUrl();
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeWithDatabase = describe.skipIf(!TEST_DATABASE_URL);

const guid = () => randomUUID().replace(/-/g, '');
/** Distinguishes this run's rows from any other tier sharing the database. */
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

const BOOK_GUID = guid();
const ROOT_GUID = guid();
/** The graft anchor: both the template's parent and the contested sibling key's parent. */
const P_GUID = guid();
/** Pre-existing, placeholder = 0, and named by a template node that HAS children. */
const E_GUID = guid();
const CURRENCY_GUID = guid();
const CURRENCY = `DL${RUN}`;

const P_NAME = `Anchor ${RUN}`;
/** The template's missing leaf, and the rename's destination. The contested key. */
const Z_NAME = `Zed ${RUN}`;
const E_NAME = `Existing ${RUN}`;
const C_NAME = `Child ${RUN}`;

const OWNED_ACCOUNTS = [ROOT_GUID, P_GUID, E_GUID];

const DB_TIMEOUT_MS = 60_000;
/**
 * How long to wait for PostgreSQL to report the expected backend blocked.
 *
 * Under Prisma's 5s interactive-transaction timeout: both app operations wait
 * INSIDE a `$transaction`, so a gate held past that would fail the operation
 * with a transaction timeout instead of producing the interleaving.
 */
const PARK_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** SQLSTATE 40P01, however Prisma chose to wrap it. */
function isDeadlock(err: unknown): boolean {
    if (!err) return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.includes('40P01')) return true;
    const text = `${(err as Error)?.message ?? ''} ${JSON.stringify((err as { meta?: unknown }).meta ?? '')}`;
    return /40P01|deadlock detected/i.test(text);
}

/** The error a settled promise carries, or null when it fulfilled. */
function reasonOf<T>(settled: PromiseSettledResult<T>): unknown {
    return settled.status === 'rejected' ? settled.reason : null;
}

describeWithDatabase(
    'account lock hierarchy: template graft vs concurrent rename (requires TEST_DATABASE_URL; set it in .env.test.local at the repo root)',
    () => {
        let pool: Pool;
        let AccountService: (typeof import('../account.service'))['AccountService'];
        let addTemplateAccounts: (typeof import('@/lib/default-book'))['addTemplateAccounts'];
        let prisma: (typeof import('@/lib/prisma'))['default'];

        beforeAll(async () => {
            pool = new Pool({ connectionString: TEST_DATABASE_URL!, max: 5 });

            await pool.query(
                `INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
                 VALUES ($1, 'CURRENCY', $2, 'Test currency', '', 100, 0, '', '')`,
                [CURRENCY_GUID, CURRENCY],
            );
            const account = async (
                g: string,
                name: string,
                type: string,
                parent: string | null,
                placeholder: number,
            ) =>
                pool.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, $2, $3, $4, 100, 0, $5, '', '', 0, $6)`,
                    [g, name, type, CURRENCY_GUID, parent, placeholder],
                );
            await account(ROOT_GUID, `Root ${RUN}`, 'ROOT', null, 1);
            await pool.query(
                `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
                 VALUES ($1, $2, $2, $3)`,
                [BOOK_GUID, ROOT_GUID, `Deadlock book ${RUN}`],
            );
            await account(P_GUID, P_NAME, 'EXPENSE', ROOT_GUID, 1);
            // placeholder = 0 is what makes the graft want to UPDATE this row:
            // its template node has children, so the one-pass implementation
            // promoted it to a placeholder mid-walk.
            await account(E_GUID, E_NAME, 'EXPENSE', P_GUID, 0);

            AccountService = (await import('../account.service')).AccountService;
            addTemplateAccounts = (await import('@/lib/default-book')).addTemplateAccounts;
            prisma = (await import('@/lib/prisma')).default;
            // Warm the pool: a connection established mid-race would add latency
            // to the very step whose blocking is being observed.
            await prisma.$queryRaw`SELECT 1 AS warm`;
        }, DB_TIMEOUT_MS);

        afterAll(async () => {
            if (!pool) return;
            try {
                await prisma?.$disconnect();
                await pool.query('DELETE FROM gnucash_web_audit WHERE entity_guid = ANY($1::varchar[])', [
                    OWNED_ACCOUNTS,
                ]);
                await pool.query('DELETE FROM books WHERE guid = $1', [BOOK_GUID]);
                // Deepest first: accounts.parent_guid is a real FK. The graft
                // creates rows under P and under E whose guids this file never
                // sees, so delete by parentage rather than by a guid list.
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [E_GUID]);
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [P_GUID]);
                await pool.query('DELETE FROM accounts WHERE guid = $1', [P_GUID]);
                await pool.query('DELETE FROM accounts WHERE guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM commodities WHERE guid = $1', [CURRENCY_GUID]);

                // The rollback substitute: nothing this run wrote survives it.
                // Also counts by NAME, so a row created under some other guid
                // cannot slip past the guid list.
                const residue = await pool.query<{ n: number }>(
                    `SELECT (SELECT COUNT(*) FROM accounts
                             WHERE guid = ANY($1::varchar[])
                                OR parent_guid = ANY($1::varchar[])
                                OR name LIKE $2)
                          + (SELECT COUNT(*) FROM books WHERE guid = $3)
                          + (SELECT COUNT(*) FROM commodities WHERE guid = $4 OR mnemonic = $5)
                          + (SELECT COUNT(*) FROM gnucash_web_audit
                             WHERE entity_guid = ANY($1::varchar[])) AS n`,
                    [OWNED_ACCOUNTS, `%${RUN}%`, BOOK_GUID, CURRENCY_GUID, CURRENCY],
                );
                expect(Number(residue.rows[0].n)).toBe(0);
            } finally {
                await pool.end();
            }
        }, DB_TIMEOUT_MS);

        /**
         * Waits until PostgreSQL reports at least one backend in THIS database
         * blocked specifically BY `blockerPid`, and returns how many it saw.
         *
         * `pg_blocking_pids` names the blocker, so this is a real wait-for edge
         * — proof of which backend is waiting on whom — rather than the weaker
         * inference from "something, somewhere in the cluster, is not granted".
         */
        async function waitForBlockedBy(blockerPid: number): Promise<number> {
            return pollBlocked(
                `SELECT COUNT(*)::int AS n
                   FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND pid <> pg_backend_pid()
                    AND pg_blocking_pids(pid) @> ARRAY[$1]::int[]`,
                [blockerPid],
                1,
            );
        }

        /**
         * Waits until at least `expected` backends in THIS database are blocked
         * by ANY backend, and returns how many it saw.
         *
         * The second app operation is deliberately not pinned to a blocker,
         * because WHICH lock it parks on is precisely what the fix changes.
         * Before the fix the rename overtakes the graft into the sibling-name
         * lock and waits on the test's blocker; after it, the graft has already
         * taken E's ROW lock in its first phase and the rename waits on the
         * graft instead. Either way both operations are parked and the
         * interleaving is established, which is all this gate is for — the
         * distinction is what the 40P01 assertion measures.
         */
        async function waitForBlockedBackends(expected: number): Promise<number> {
            return pollBlocked(
                `SELECT COUNT(*)::int AS n
                   FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND pid <> pg_backend_pid()
                    AND cardinality(pg_blocking_pids(pid)) > 0`,
                [],
                expected,
            );
        }

        async function pollBlocked(
            sql: string,
            params: unknown[],
            expected: number,
        ): Promise<number> {
            const deadline = Date.now() + PARK_TIMEOUT_MS;
            let seen = 0;
            while (Date.now() < deadline) {
                const res = await pool.query<{ n: number }>(sql, params);
                seen = Number(res.rows[0].n);
                if (seen >= expected) return seen;
                await sleep(20);
            }
            return seen;
        }

        /** How many REAL accounts currently sit on (parent, name). */
        async function siblingsOn(parentGuid: string, name: string): Promise<number> {
            const res = await pool.query<{ n: number }>(
                'SELECT COUNT(*)::int AS n FROM accounts WHERE parent_guid = $1 AND name = $2',
                [parentGuid, name],
            );
            return Number(res.rows[0].n);
        }

        it(
            'graft-vs-rename on the same sibling key does not deadlock, and both sides settle correctly',
            async () => {
                const blocker: PoolClient = await pool.connect();
                let graftSettled: PromiseSettledResult<{ created: number; existing: number }>;
                let renameSettled: PromiseSettledResult<unknown>;

                try {
                    const pidRes = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                    const blockerPid = Number(pidRes.rows[0].pid);

                    // 1. Hold the contested sibling key. Same construction as
                    //    `accountNameLockKey` + `acquireNamedXactLock`.
                    await blocker.query('BEGIN');
                    await blocker.query("SET LOCAL lock_timeout = '20s'");
                    await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                        `account:${P_GUID}:${Z_NAME}`,
                    ]);

                    // 2. The graft queues on that key FIRST. Its template asks
                    //    for a missing leaf (Z) beside an existing node that has
                    //    children (E) — the pairing that made the old one-pass
                    //    walk hold Z's key while updating E's row.
                    const graft = addTemplateAccounts(
                        BOOK_GUID,
                        [
                            { name: Z_NAME, type: 'EXPENSE' },
                            { name: E_NAME, type: 'EXPENSE', children: [{ name: C_NAME, type: 'EXPENSE' }] },
                        ],
                        P_NAME,
                    );
                    graft.catch(() => {});
                    expect(await waitForBlockedBy(blockerPid)).toBeGreaterThanOrEqual(1);

                    // 3. The rename takes E's row lock on its way past, then
                    //    queues on the same key SECOND.
                    const rename = AccountService.update(E_GUID, { name: Z_NAME });
                    rename.catch(() => {});
                    expect(await waitForBlockedBackends(2)).toBeGreaterThanOrEqual(2);

                    // 4. Release. The graft is served first and, before the fix,
                    //    walks straight into E's row lock while the rename waits
                    //    on the key the graft now holds.
                    await blocker.query('COMMIT');

                    [graftSettled] = await Promise.allSettled([graft]);
                    [renameSettled] = await Promise.allSettled([rename]);
                } finally {
                    blocker.release();
                }

                // THE INVARIANT. Asserted first, and with the offending error
                // attached, so a regression reports the deadlock itself rather
                // than a downstream symptom.
                const graftErr = reasonOf(graftSettled);
                const renameErr = reasonOf(renameSettled);
                expect(
                    { graft: isDeadlock(graftErr), rename: isDeadlock(renameErr) },
                    `deadlock (40P01) reported.\n  graft: ${String((graftErr as Error)?.message ?? graftErr)}\n  rename: ${String((renameErr as Error)?.message ?? renameErr)}`,
                ).toEqual({ graft: false, rename: false });

                // Both sides reached a correct terminal state.
                //
                // The graft is served the key first, so it creates Z and the
                // rename is then refused for the ordinary reason — the key it
                // wanted is occupied. Nothing here depends on that order beyond
                // the two being consistent with each other, which is what the
                // sibling count checks.
                expect(graftSettled.status).toBe('fulfilled');
                if (graftSettled.status === 'fulfilled') {
                    // Z and C: the missing leaf, and the missing child of E.
                    expect(graftSettled.value.created).toBe(2);
                    expect(graftSettled.value.existing).toBe(1);
                }

                expect(renameSettled.status).toBe('rejected');
                expect(String((renameErr as Error)?.message)).toMatch(/already exists under this parent/);

                // The duplicate-sibling invariant the whole branch exists for.
                expect(await siblingsOn(P_GUID, Z_NAME)).toBe(1);
                expect(await siblingsOn(P_GUID, E_NAME)).toBe(1);

                // The graft's phase-2 reconciliation still happened: E was
                // promoted to a placeholder because its template node has
                // children.
                const e = await pool.query<{ placeholder: number; name: string }>(
                    'SELECT placeholder, name FROM accounts WHERE guid = $1',
                    [E_GUID],
                );
                expect(e.rows[0].name).toBe(E_NAME);
                expect(Number(e.rows[0].placeholder)).toBe(1);
                expect(await siblingsOn(E_GUID, C_NAME)).toBe(1);
            },
            DB_TIMEOUT_MS,
        );
    },
);
