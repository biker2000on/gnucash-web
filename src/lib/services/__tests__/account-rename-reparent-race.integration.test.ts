/**
 * The STALE-DESTINATION race in `AccountService.update` / `.move`, proven
 * against a REAL PostgreSQL database on two real connections.
 *
 * ## What is being proven
 *
 * A sibling key is `(parent_guid, name)`, it has no database arbiter (a unique
 * index cannot exist — see ACCOUNTS_SIBLING_NAME_INDEX in src/lib/db-init.ts),
 * and every mutation writes only ONE half of it:
 *
 *     rename  writes name        , leaving parent_guid alone
 *     move    writes parent_guid , leaving name alone
 *
 * So a destination key derived from a read taken BEFORE the writing transaction
 * is invalidated by a concurrent write to the other half, and the key the row
 * actually lands on is one that nothing locked and nothing re-checked:
 *
 *   rename-during-move   update(X, {name:'New'}) reads X = (P1,'Old') and plans
 *                        (P1,'New'); a move commits parent_guid = P2; the rename
 *                        writes name only -> X is (P2,'New'), never claimed.
 *
 *   move-during-rename   move(X, P2) reads name 'Old' and plans (P2,'Old'); a
 *                        rename commits name = 'New'; the move writes
 *                        parent_guid only -> X is (P2,'New'), never claimed.
 *
 * Both tests seed a DECOY already sitting on (P2,'New'), so the unclaimed key
 * is an occupied one: if the operation is allowed through, the book ends up
 * with two real siblings of the same name under the same parent — exactly the
 * state this whole branch exists to prevent, arrived at by a route `create`
 * cannot refuse.
 *
 * ## Why it has to be here and not in the unit tier
 *
 * account-create-sibling-lock.test.ts drives the same functions through an
 * in-memory double, and a double cannot demonstrate row-level exclusion no
 * matter what it returns — the most it can assert is WHICH read the service
 * keys its claim off. Proving that a concurrent writer is actually made to
 * wait, and that the read after the wait sees what that writer committed, takes
 * a real server: one connection holding an uncommitted row lock while the app's
 * connection tries to write the same row.
 *
 * ## How the interleaving is made deterministic
 *
 * Not with sleeps or `Promise.all` luck. A raw connection opens a transaction
 * and performs the CONCURRENT half of the key change without committing, which
 * leaves an exclusive row lock on X. The app operation then starts: its
 * pre-transaction read sees the OLD row (READ COMMITTED shows the uncommitted
 * write to nobody), and it blocks the moment it needs X — on the row lock this
 * fix takes, or, without the fix, on its own final UPDATE. The test waits for
 * Postgres itself to report a blocked backend, then commits the blocker. The
 * window is therefore observed, not hoped for.
 *
 * ## Test data
 *
 * Everything written here carries a per-run suffix and is deleted in afterAll,
 * which then asserts an exact COUNT of zero residue — this tier does not
 * truncate and does not roll back (a single transaction cannot host a test
 * about two connections). See vitest.integration.config.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

/**
 * TEST_DATABASE_URL from the environment (what CI sets, and it must win), or
 * from a gitignored `.env.test.local`. The second candidate is the repository
 * root as seen from a git worktree, where the file lives beside the main
 * checkout rather than in the worktree.
 */
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
// AccountService reaches the database through the `@/lib/prisma` singleton,
// which reads DATABASE_URL when it is first imported — hence set here, and
// hence the dynamic import in beforeAll.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeWithDatabase = describe.skipIf(!TEST_DATABASE_URL);

const guid = () => randomUUID().replace(/-/g, '');
/** Distinguishes this run's rows from any other tier sharing the database. */
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

const BOOK_GUID = guid();
const ROOT_GUID = guid();
/** Where X starts. */
const P1_GUID = guid();
/** Where the concurrent move sends X. */
const P2_GUID = guid();
/** The account both interleavings act on. */
const X_GUID = guid();
/** The account already sitting on the destination key. */
const DECOY_GUID = guid();
const CURRENCY_GUID = guid();
const CURRENCY = `RR${RUN}`;

const OLD_NAME = `Old ${RUN}`;
const NEW_NAME = `New ${RUN}`;

/** Every guid this file inserts, for teardown and the residue count. */
const OWNED_ACCOUNTS = [ROOT_GUID, P1_GUID, P2_GUID, X_GUID, DECOY_GUID];

/**
 * Ceiling for a hang, not an expectation: these tests seed a remote database,
 * load Prisma through the transform pipeline, and deliberately park a backend
 * on a row lock. The file itself runs in a couple of seconds.
 */
const DB_TIMEOUT_MS = 60_000;

/**
 * How long to wait for Postgres to report the app's backend blocked.
 *
 * Deliberately under Prisma's 5s interactive-transaction timeout: the app waits
 * INSIDE a `$transaction`, so a blocker held past that would fail the operation
 * with a transaction timeout instead of racing it.
 */
const PARK_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describeWithDatabase(
    'AccountService rename/reparent stale-destination race (requires TEST_DATABASE_URL; set it in .env.test.local at the repo root)',
    () => {
        let pool: Pool;
        let AccountService: (typeof import('../account.service'))['AccountService'];
        let prisma: (typeof import('@/lib/prisma'))['default'];

        beforeAll(async () => {
            pool = new Pool({ connectionString: TEST_DATABASE_URL!, max: 4 });

            await pool.query(
                `INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
                 VALUES ($1, 'CURRENCY', $2, 'Test currency', '', 100, 0, '', '')`,
                [CURRENCY_GUID, CURRENCY],
            );
            const account = async (g: string, name: string, type: string, parent: string | null) =>
                pool.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, $2, $3, $4, 100, 0, $5, '', '', 0, 0)`,
                    [g, name, type, CURRENCY_GUID, parent],
                );
            await account(ROOT_GUID, `Root ${RUN}`, 'ROOT', null);
            await pool.query(
                `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
                 VALUES ($1, $2, $2, $3)`,
                [BOOK_GUID, ROOT_GUID, `Race book ${RUN}`],
            );
            await account(P1_GUID, `Parent one ${RUN}`, 'EXPENSE', ROOT_GUID);
            await account(P2_GUID, `Parent two ${RUN}`, 'EXPENSE', ROOT_GUID);
            await account(X_GUID, OLD_NAME, 'EXPENSE', P1_GUID);
            await account(DECOY_GUID, NEW_NAME, 'EXPENSE', P2_GUID);

            AccountService = (await import('../account.service')).AccountService;
            prisma = (await import('@/lib/prisma')).default;
            // Warm the pool: a connection established mid-race would add
            // latency to the very step whose blocking is being observed.
            await prisma.$queryRaw`SELECT 1 AS warm`;
        }, DB_TIMEOUT_MS);

        /** Put X and the decoy back where every test expects to find them. */
        beforeEach(async () => {
            await pool.query(
                'UPDATE accounts SET parent_guid = $2, name = $3 WHERE guid = $1',
                [X_GUID, P1_GUID, OLD_NAME],
            );
            await pool.query(
                `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                 VALUES ($1, $2, 'EXPENSE', $3, 100, 0, $4, '', '', 0, 0)
                 ON CONFLICT (guid) DO UPDATE SET parent_guid = $4, name = $2`,
                [DECOY_GUID, NEW_NAME, CURRENCY_GUID, P2_GUID],
            );
        });

        afterEach(async () => {
            // Audit rows are written outside the service transaction and are
            // not part of what is being asserted.
            await pool.query('DELETE FROM gnucash_web_audit WHERE entity_guid = ANY($1::varchar[])', [
                OWNED_ACCOUNTS,
            ]);
        });

        afterAll(async () => {
            if (!pool) return;
            try {
                await prisma?.$disconnect();
                await pool.query('DELETE FROM gnucash_web_audit WHERE entity_guid = ANY($1::varchar[])', [
                    OWNED_ACCOUNTS,
                ]);
                await pool.query('DELETE FROM books WHERE guid = $1', [BOOK_GUID]);
                // Children before parents: accounts.parent_guid is a real FK on
                // a Prisma-provisioned schema.
                await pool.query('DELETE FROM accounts WHERE guid = ANY($1::varchar[])', [
                    [X_GUID, DECOY_GUID],
                ]);
                await pool.query('DELETE FROM accounts WHERE guid = ANY($1::varchar[])', [
                    [P1_GUID, P2_GUID],
                ]);
                await pool.query('DELETE FROM accounts WHERE guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM commodities WHERE guid = $1', [CURRENCY_GUID]);

                // The rollback substitute: nothing this run wrote survives it.
                // Also counts by NAME, so a duplicate the buggy code created
                // under some other guid cannot slip through the guid list.
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
         * Waits until Postgres reports at least one backend blocked
         * specifically BY `blockerPid` — the connection this test parked on the
         * row — and returns how many. Zero means the app never blocked, i.e.
         * the interleaving under test did not happen, which the callers assert
         * on: a race that quietly stopped racing reports a failure rather than
         * a pass.
         *
         * Scoped through `pg_blocking_pids` rather than counting ungranted
         * `pg_locks` rows cluster-wide. Both are strong signals in a serialized
         * tier, but only this one is evidence of WHICH backend is waiting on
         * WHOM: an ungranted lock belonging to some other database, or to a
         * leftover connection, would satisfy the weaker form.
         */
        async function waitForBlockedBackend(blockerPid: number): Promise<number> {
            const deadline = Date.now() + PARK_TIMEOUT_MS;
            while (Date.now() < deadline) {
                const res = await pool.query<{ n: number }>(
                    `SELECT COUNT(*)::int AS n
                       FROM pg_stat_activity
                      WHERE datname = current_database()
                        AND pid <> pg_backend_pid()
                        AND pg_blocking_pids(pid) @> ARRAY[$1]::int[]`,
                    [blockerPid],
                );
                const blocked = Number(res.rows[0].n);
                if (blocked > 0) return blocked;
                await sleep(20);
            }
            return 0;
        }

        /**
         * Runs `concurrent` (one half of the key change) on its own connection
         * WITHOUT committing, starts `operation` (the app-side call), waits for
         * the app to block on the row that connection holds, then commits it.
         *
         * Returns the operation's outcome and the observed block count, so a
         * test can assert both what happened and that the window was real.
         */
        async function withConcurrentKeyChange<T>(
            concurrent: (client: PoolClient) => Promise<void>,
            operation: () => Promise<T>,
        ): Promise<{ settled: PromiseSettledResult<T>; blocked: number }> {
            const blocker = await pool.connect();
            try {
                const pidRes = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                const blockerPid = Number(pidRes.rows[0].pid);

                await blocker.query('BEGIN');
                await blocker.query("SET LOCAL lock_timeout = '10s'");
                await concurrent(blocker);

                const running = operation();
                // Never let a rejection escape as an unhandled rejection while
                // the poll below is still running.
                running.catch(() => {});

                const blocked = await waitForBlockedBackend(blockerPid);
                await blocker.query('COMMIT');

                const [settled] = await Promise.allSettled([running]);
                return { settled, blocked };
            } finally {
                blocker.release();
            }
        }

        /** How many REAL accounts currently sit on (parent, name). */
        async function siblingsOn(parentGuid: string, name: string): Promise<number> {
            const res = await pool.query<{ n: number }>(
                'SELECT COUNT(*)::int AS n FROM accounts WHERE parent_guid = $1 AND name = $2',
                [parentGuid, name],
            );
            return Number(res.rows[0].n);
        }

        /** X's key, as committed. */
        async function keyOfX(): Promise<{ parent_guid: string | null; name: string }> {
            const res = await pool.query<{ parent_guid: string | null; name: string }>(
                'SELECT parent_guid, name FROM accounts WHERE guid = $1',
                [X_GUID],
            );
            return res.rows[0];
        }

        it(
            'rename-during-move: refuses the rename that would land X on the occupied key',
            async () => {
                // The other half of the key, committed while the rename is in
                // flight: X moves from P1 to P2.
                const { settled, blocked } = await withConcurrentKeyChange(
                    async (blocker) => {
                        await blocker.query(
                            'UPDATE accounts SET parent_guid = $2 WHERE guid = $1',
                            [X_GUID, P2_GUID],
                        );
                    },
                    () => AccountService.update(X_GUID, { name: NEW_NAME }),
                );

                // The window was real: the app waited on the row the blocker held.
                expect(blocked).toBeGreaterThan(0);

                // THE INVARIANT, asserted first so a regression reports the
                // duplicate itself rather than a downstream symptom. Without
                // the fix this is 2: the decoy, plus X renamed onto its key.
                expect(await siblingsOn(P2_GUID, NEW_NAME)).toBe(1);

                // The rename's own read said (P1, OLD_NAME) and its planned key
                // was (P1, NEW_NAME) — free. The key it would actually land on
                // is (P2, NEW_NAME), which the decoy holds, so it must refuse.
                expect(settled.status).toBe('rejected');
                expect((settled as PromiseRejectedResult).reason).toBeInstanceOf(Error);
                expect(((settled as PromiseRejectedResult).reason as Error).message).toContain(
                    `An account named "${NEW_NAME}" already exists under this parent`,
                );

                // And the refusal rolled the rename back: the concurrent move
                // stands, the name does not.
                expect(await keyOfX()).toEqual({ parent_guid: P2_GUID, name: OLD_NAME });
            },
            DB_TIMEOUT_MS,
        );

        it(
            'move-during-rename: refuses the move that would land X on the occupied key',
            async () => {
                // The other half of the key, committed while the move is in
                // flight: X is renamed from OLD_NAME to NEW_NAME under P1.
                const { settled, blocked } = await withConcurrentKeyChange(
                    async (blocker) => {
                        await blocker.query('UPDATE accounts SET name = $2 WHERE guid = $1', [
                            X_GUID,
                            NEW_NAME,
                        ]);
                    },
                    () => AccountService.move(X_GUID, P2_GUID),
                );

                expect(blocked).toBeGreaterThan(0);

                // THE INVARIANT, first. Without the fix this is 2: the decoy,
                // plus X moved under P2 carrying the name it was just given.
                expect(await siblingsOn(P2_GUID, NEW_NAME)).toBe(1);

                // The move's own read said the name was OLD_NAME and its planned
                // key was (P2, OLD_NAME) — free. The key it would actually land
                // on is (P2, NEW_NAME), which the decoy holds.
                expect(settled.status).toBe('rejected');
                expect(((settled as PromiseRejectedResult).reason as Error).message).toContain(
                    `An account named "${NEW_NAME}" already exists under this parent`,
                );

                expect(await keyOfX()).toEqual({ parent_guid: P1_GUID, name: NEW_NAME });
            },
            DB_TIMEOUT_MS,
        );

        it(
            'rename-during-move: SUCCEEDS onto the post-move key when nothing holds it',
            async () => {
                // Same interleaving, destination free. The point is that the fix
                // refuses because the key is occupied, not because it refuses
                // every rename that raced a move — a guard that always says no
                // would pass the two tests above and be useless.
                await pool.query('DELETE FROM accounts WHERE guid = $1', [DECOY_GUID]);

                const { settled, blocked } = await withConcurrentKeyChange(
                    async (blocker) => {
                        await blocker.query(
                            'UPDATE accounts SET parent_guid = $2 WHERE guid = $1',
                            [X_GUID, P2_GUID],
                        );
                    },
                    () => AccountService.update(X_GUID, { name: NEW_NAME }),
                );

                expect(blocked).toBeGreaterThan(0);
                expect(settled.status).toBe('fulfilled');
                expect(await keyOfX()).toEqual({ parent_guid: P2_GUID, name: NEW_NAME });
                expect(await siblingsOn(P2_GUID, NEW_NAME)).toBe(1);
            },
            DB_TIMEOUT_MS,
        );

        it(
            'move-during-rename: SUCCEEDS onto the post-rename key when nothing holds it',
            async () => {
                await pool.query('DELETE FROM accounts WHERE guid = $1', [DECOY_GUID]);

                const { settled, blocked } = await withConcurrentKeyChange(
                    async (blocker) => {
                        await blocker.query('UPDATE accounts SET name = $2 WHERE guid = $1', [
                            X_GUID,
                            NEW_NAME,
                        ]);
                    },
                    () => AccountService.move(X_GUID, P2_GUID),
                );

                expect(blocked).toBeGreaterThan(0);
                expect(settled.status).toBe('fulfilled');
                expect(await keyOfX()).toEqual({ parent_guid: P2_GUID, name: NEW_NAME });
                expect(await siblingsOn(P2_GUID, NEW_NAME)).toBe(1);
            },
            DB_TIMEOUT_MS,
        );

        it(
            'a rename that touches neither half of a contended key is unaffected',
            async () => {
                // The row lock is only taken when the payload writes `name` or
                // `parent_guid`. A description-only update takes none, so it
                // must NOT be serialized behind an unrelated key change — and
                // must not be able to move the account onto a new key either.
                const blocker = await pool.connect();
                try {
                    await blocker.query('BEGIN');
                    await blocker.query('UPDATE accounts SET name = $2 WHERE guid = $1', [
                        DECOY_GUID,
                        `Decoy renamed ${RUN}`,
                    ]);
                    await AccountService.update(X_GUID, { description: `Note ${RUN}` });
                    await blocker.query('ROLLBACK');
                } finally {
                    blocker.release();
                }

                expect(await keyOfX()).toEqual({ parent_guid: P1_GUID, name: OLD_NAME });
            },
            DB_TIMEOUT_MS,
        );
    },
);
