/**
 * ASI-5-009 (race half) — create-if-missing races in the SimpleFin sync,
 * proven against a REAL PostgreSQL database.
 *
 * Why this file exists at all: the sibling unit test drives the same functions
 * through an in-memory fake whose `acquireNamedXactLock` implements mutual
 * exclusion itself. A fake that implements the rule under test can only ever
 * confirm that the fake works. Two Prisma connections racing for one Postgres
 * advisory lock — and one partial unique index deciding the loser — is a thing
 * only a real server can demonstrate.
 *
 * Naming: `*.integration.test.ts` is the suffix of the integration tier being
 * wired in parallel (vitest.integration.config.ts + a postgres service in CI).
 * Until that lands the file is skipped, loudly, when no TEST_DATABASE_URL is
 * resolvable — see the skip title below. It is never a silent pass: the whole
 * describe block disappears from the report rather than reporting green.
 *
 * Isolation: every row this file writes carries a per-run random suffix, so it
 * can share a database with another worker's tier without either colliding.
 *
 * On BEGIN/ROLLBACK: a single transaction cannot host this test. Genuine
 * concurrency needs two connections, and one connection's uncommitted rows are
 * invisible to the other — the seed has to be committed for the racers to see
 * it. So cleanup is explicit (afterAll) and the residue is asserted to zero
 * afterwards, which is what the rollback was for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

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
// The service reaches the database through the `@/lib/prisma` singleton, which
// reads DATABASE_URL when it is first imported — hence set here, and hence the
// dynamic import in beforeAll.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeWithDatabase = describe.skipIf(!TEST_DATABASE_URL);

const guid = () => randomUUID().replace(/-/g, '');
/** Distinguishes this run's rows from any other tier running concurrently. */
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

const BOOK_GUID = guid();
const ROOT_GUID = guid();
const PARENT_GUID = guid();
const CURRENCY_GUID = guid();
/** A throwaway currency, so nothing here depends on (or disturbs) real USD. */
const CURRENCY = `TC${RUN}`;
const IMBALANCE_NAME = `Imbalance-${CURRENCY}`;
/** A throwaway ticker, likewise. */
const SYMBOL = `ZZ${RUN}`;

/**
 * Racers per scenario. More than two, because two can miss an interleaving.
 *
 * Against the FIXED code this passes every time — one account is the invariant,
 * however the racers land. Against broken code it has to actually interleave
 * them, which is what the starting gate below is for: rather than leaving the
 * overlap to the scheduler, it holds every racer at its first read of
 * `accounts`, waits for Postgres to report them parked, and releases them
 * together.
 */
const RACERS = 6;

/**
 * How long the gate waits for all RACERS to park before releasing whoever
 * arrived.
 *
 * Deliberately well under Prisma's 5s interactive-transaction timeout: some
 * racers park INSIDE a `$transaction` (the Imbalance path takes its advisory
 * lock before reading), so a gate that lingered would fail them with a
 * transaction timeout instead of racing them.
 */
const GATE_TIMEOUT_MS = 2000;

/**
 * How many racers must be OBSERVED parked for the overlap to count.
 *
 * Two, not RACERS, and the difference matters. What the barrier buys is that
 * the overlap is confirmed by Postgres instead of assumed from `Promise.all` —
 * once two backends are parked on the same lock, releasing the gate genuinely
 * drives more than one racer through the pre-create window, which no amount of
 * scheduler luck was guaranteeing before. Demanding all six would put a CPU
 * starvation timer back in the assertion: this suite runs ~380 files across
 * every core, and a worker that loses its slice for a second leaves a racer
 * that has not reached its first query yet. In practice all six park within
 * milliseconds; the floor is here so an unlucky machine reports a slower run,
 * not a failure.
 */
const MIN_OVERLAP = 2;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Explicit budget for everything here, because vitest's 5s default is a budget
 * for pure-CPU unit tests. These hooks and tests seed a remote database, load
 * the service and Prisma through the transform pipeline, and park six backends
 * on a lock — and they do it while the other ~380 test files are competing for
 * the same CPUs. The number is a ceiling for a hang, not an expectation: the
 * whole file runs in about ten seconds.
 */
const DB_TIMEOUT_MS = 60_000;

describeWithDatabase(
    'SimpleFin create-if-missing races (requires TEST_DATABASE_URL; set it in .env.test.local at the repo root)',
    () => {
        let pool: Pool;
        let service: typeof import('../simplefin-sync.service');
        let prisma: (typeof import('@/lib/prisma'))['default'];

        beforeAll(async () => {
            pool = new Pool({ connectionString: TEST_DATABASE_URL!, max: 4 });

            await pool.query(
                `INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
                 VALUES ($1, 'CURRENCY', $2, 'Test currency', '', 100, 0, '', '')`,
                [CURRENCY_GUID, CURRENCY],
            );
            await pool.query(
                `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                 VALUES ($1, $2, 'ROOT', $3, 100, 0, NULL, '', '', 0, 0)`,
                [ROOT_GUID, `Root ${RUN}`, CURRENCY_GUID],
            );
            await pool.query(
                `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
                 VALUES ($1, $2, $2, $3)`,
                [BOOK_GUID, ROOT_GUID, `Race book ${RUN}`],
            );
            await pool.query(
                `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                 VALUES ($1, $2, 'BANK', $3, 100, 0, $4, '', '', 0, 0)`,
                [PARENT_GUID, `Brokerage ${RUN}`, CURRENCY_GUID, ROOT_GUID],
            );

            service = await import('../simplefin-sync.service');
            prisma = (await import('@/lib/prisma')).default;

            // Open one pooled connection per racer up front. A racer that has
            // to establish a connection first starts its check-then-create
            // milliseconds behind the others, which is enough for the winner
            // to finish before anyone else looks.
            await Promise.all(
                Array.from({ length: RACERS }, () => prisma.$queryRaw`SELECT 1 AS warm`),
            );
        }, DB_TIMEOUT_MS);

        /**
         * Run `launch`'s racers with a real starting barrier.
         *
         * `Promise.all` starts them in one tick, but started is not
         * overlapping: connection checkout and query latency vary by
         * milliseconds, and that is more than enough for the first racer to
         * finish its entire check-and-create before the last one has looked.
         * A test that only calls them together is therefore timing-dependent —
         * it observes the race when the scheduler happens to cooperate.
         *
         * So the gate takes ACCESS EXCLUSIVE on `accounts` (the one lock mode
         * that blocks readers too) on a connection of its own. Every racer runs
         * until its first touch of `accounts` and parks there; the ones on the
         * Imbalance path park on each other's advisory lock instead, which is
         * the same starting line one step further in. The gate holds until
         * Postgres itself reports every racer waiting (or GATE_TIMEOUT_MS
         * passes), so the overlap is observed rather than hoped for.
         *
         * Returns how many were confirmed parked, so a test can assert that the
         * window it claims to have exercised was real — see MIN_OVERLAP.
         */
        async function withStartingGate<T>(launch: () => Promise<T>): Promise<{ result: T; parked: number }> {
            const gate = await pool.connect();
            try {
                await gate.query('BEGIN');
                // A gate that cannot be taken must fail the test, not hang the
                // suite behind some unrelated reader.
                await gate.query("SET LOCAL lock_timeout = '10s'");
                await gate.query('LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE');

                const racing = launch();
                // Never let a racer's rejection escape as an unhandled
                // rejection while the gate is still polling.
                racing.catch(() => {});

                let parked = 0;
                const deadline = Date.now() + GATE_TIMEOUT_MS;
                while (Date.now() < deadline) {
                    const waiting = await gate.query<{ blocked: number }>(
                        `SELECT COUNT(DISTINCT pid)::int AS blocked
                         FROM pg_locks
                         WHERE NOT granted
                           AND pid <> pg_backend_pid()
                           AND (database IS NULL
                                OR database = (SELECT oid FROM pg_database WHERE datname = current_database()))`,
                    );
                    parked = Number(waiting.rows[0].blocked);
                    if (parked >= RACERS) break;
                    await sleep(20);
                }

                await gate.query('ROLLBACK');
                return { result: await racing, parked };
            } finally {
                gate.release();
            }
        }

        afterAll(async () => {
            if (!pool) return;
            try {
                await prisma?.$disconnect();
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [PARENT_GUID]);
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM books WHERE guid = $1', [BOOK_GUID]);
                await pool.query('DELETE FROM accounts WHERE guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM commodities WHERE guid = $1 OR mnemonic = $2', [
                    CURRENCY_GUID,
                    SYMBOL,
                ]);

                // The rollback substitute: nothing this run wrote survives it.
                // Scoped to this run's rows on purpose — a global count would
                // flake against a database shared with another tier.
                const residue = await pool.query<{ n: number }>(
                    `SELECT (SELECT COUNT(*) FROM accounts WHERE guid IN ($1, $2) OR parent_guid IN ($1, $2))
                          + (SELECT COUNT(*) FROM books WHERE guid = $3)
                          + (SELECT COUNT(*) FROM commodities WHERE guid = $4 OR mnemonic = $5) AS n`,
                    [ROOT_GUID, PARENT_GUID, BOOK_GUID, CURRENCY_GUID, SYMBOL],
                );
                expect(Number(residue.rows[0].n)).toBe(0);
            } finally {
                await pool.end();
            }
        }, DB_TIMEOUT_MS);

        it('creates exactly one Imbalance account under concurrent syncs', async () => {
            // The book scope a real sync would carry: captured before any of
            // these creations, and (like the memoised one in production) never
            // updated by them.
            const bookScope = new Set([ROOT_GUID, PARENT_GUID]);

            const { result: guids, parked } = await withStartingGate(() =>
                Promise.all(
                    Array.from({ length: RACERS }, () =>
                        service.getOrCreateImbalanceAccount(CURRENCY, BOOK_GUID, bookScope),
                    ),
                ),
            );

            expect(parked).toBeGreaterThanOrEqual(MIN_OVERLAP);
            expect(new Set(guids).size).toBe(1);
            const rows = await pool.query<{ guid: string }>(
                'SELECT guid FROM accounts WHERE parent_guid = $1 AND name = $2',
                [ROOT_GUID, IMBALANCE_NAME],
            );
            expect(rows.rows).toHaveLength(1);
            expect(guids[0]).toBe(rows.rows[0].guid);
        }, DB_TIMEOUT_MS);

        it('creates exactly one Cash child under concurrent syncs, and counts one creation', async () => {
            const bookScope = new Set([ROOT_GUID, PARENT_GUID]);
            const created = { count: 0 };

            const { result: guids, parked } = await withStartingGate(() =>
                Promise.all(
                    Array.from({ length: RACERS }, () =>
                        service.getOrCreateCashChild(PARENT_GUID, BOOK_GUID, bookScope, created),
                    ),
                ),
            );

            expect(parked).toBeGreaterThanOrEqual(MIN_OVERLAP);
            expect(new Set(guids).size).toBe(1);
            const rows = await pool.query<{ guid: string }>(
                `SELECT guid FROM accounts WHERE parent_guid = $1 AND name = 'Cash'`,
                [PARENT_GUID],
            );
            expect(rows.rows).toHaveLength(1);
            expect(guids[0]).toBe(rows.rows[0].guid);
            // The losers must not report a creation they did not make — that
            // count drives cache invalidation.
            expect(created.count).toBe(1);
        }, DB_TIMEOUT_MS);

        it('creates exactly one symbol child and one commodity under concurrent syncs', async () => {
            const bookScope = new Set([ROOT_GUID, PARENT_GUID]);
            const created = { count: 0 };

            const { result: guids, parked } = await withStartingGate(() =>
                Promise.all(
                    Array.from({ length: RACERS }, () =>
                        service.getOrCreateChildAccount(
                            PARENT_GUID,
                            SYMBOL,
                            `${SYMBOL} test holding`,
                            BOOK_GUID,
                            bookScope,
                            created,
                        ),
                    ),
                ),
            );

            expect(parked).toBeGreaterThanOrEqual(MIN_OVERLAP);
            expect(new Set(guids).size).toBe(1);
            const accounts = await pool.query<{ guid: string }>(
                'SELECT guid FROM accounts WHERE parent_guid = $1 AND name = $2',
                [PARENT_GUID, SYMBOL],
            );
            expect(accounts.rows).toHaveLength(1);
            expect(guids[0]).toBe(accounts.rows[0].guid);
            expect(created.count).toBe(1);

            // Duplicate commodities cannot be merged after the fact (accounts,
            // prices and splits reference one by guid), so the commodity race
            // matters as much as the account race.
            const commodities = await pool.query('SELECT guid FROM commodities WHERE mnemonic = $1', [
                SYMBOL,
            ]);
            expect(commodities.rows).toHaveLength(1);
        }, DB_TIMEOUT_MS);

        it('has the database itself refuse a duplicate sibling, lock or no lock', async () => {
            // This is why the fix does not rest on the advisory lock alone: the
            // index binds writers that never take it — AccountService.create
            // and the XML importer do not, and cannot be made to without the
            // same discipline surviving in every account writer ever added.
            // Its presence is also what makes the winner-adoption path in the
            // service reachable.
            const index = await pool.query(
                `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_accounts_parent_name'`,
            );
            expect(index.rows).toHaveLength(1);
            expect(index.rows[0].indexdef).toContain('parent_guid, name');

            const name = `Dup ${RUN}`;
            const insert = (rowGuid: string) =>
                pool.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, $2, 'BANK', $3, 100, 0, $4, '', '', 0, 0)`,
                    [rowGuid, name, CURRENCY_GUID, PARENT_GUID],
                );

            await insert(guid());
            await expect(insert(guid())).rejects.toMatchObject({ code: '23505' });

            await pool.query('DELETE FROM accounts WHERE parent_guid = $1 AND name = $2', [
                PARENT_GUID,
                name,
            ]);
        }, DB_TIMEOUT_MS);

        /**
         * The deployment state the whole fix turns on: a database where the old
         * db-init SKIPPED `uq_accounts_parent_name` because some unrelated
         * duplicate sibling existed somewhere. On such a database the advisory
         * lock was the only serializer, and it binds only its own callers — so
         * the guarantee has to be restored, not worked around.
         *
         * Staged in a private schema rather than by dropping the real index:
         * real tables (LIKE the production ones), a real server, the real DDL
         * resolving `accounts`/`splits`/the backup table unqualified exactly as
         * it does in production, and no way for a failure here to leave the
         * shared database without its index.
         */
        it('repairs a database where the sibling-name index was previously skipped', async () => {
            const { ACCOUNTS_SIBLING_NAME_GUARD_DDL, SCHEMA_META_DDL } = await import('@/lib/db-init');

            const SCHEMA = `race_guard_${RUN.toLowerCase()}`;
            // Its own pool: `SET search_path` is session state, and a client
            // handed back to the shared pool would carry it to the next caller.
            const sandbox = new Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });

            // Explicit guids so the tie-break is observable: within a duplicate
            // group the most-posted-to row keeps the name, ties going to the
            // lowest guid.
            const PARENT = '9'.repeat(32);
            const KEEPER = '1'.repeat(32);
            const LOSER_A = '2'.repeat(32);
            const LOSER_B = '3'.repeat(32);
            const DECOY = '4'.repeat(32);
            const ROOT_A = '5'.repeat(32);
            const ROOT_B = '6'.repeat(32);

            const insertAccount = (rowGuid: string, rowName: string, parent: string | null) =>
                sandbox.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, $2, 'BANK', $3, 100, 0, $4, '', '', 0, 0)`,
                    [rowGuid, rowName, CURRENCY_GUID, parent],
                );

            const namesByGuid = async () => {
                const rows = await sandbox.query<{ guid: string; name: string }>(
                    'SELECT guid, name FROM accounts ORDER BY guid',
                );
                return Object.fromEntries(rows.rows.map(r => [r.guid.trim(), r.name]));
            };

            try {
                await sandbox.query(`CREATE SCHEMA ${SCHEMA}`);
                await sandbox.query(`SET search_path TO ${SCHEMA}`);
                await sandbox.query('CREATE TABLE accounts (LIKE public.accounts INCLUDING DEFAULTS)');
                await sandbox.query('CREATE TABLE splits (LIKE public.splits INCLUDING DEFAULTS)');
                await sandbox.query(SCHEMA_META_DDL);

                // Three siblings called Cash — the state the old guard refused
                // to touch, and therefore never indexed past.
                await insertAccount(KEEPER, 'Cash', PARENT);
                await insertAccount(LOSER_A, 'Cash', PARENT);
                await insertAccount(LOSER_B, 'Cash', PARENT);
                // A sibling already occupying the name LOSER_A would be given,
                // so the collision loop has to find the next one.
                await insertAccount(DECOY, `Cash (dup ${LOSER_A.slice(0, 8)})`, PARENT);
                // Two roots sharing a name: NULL parent_guid is outside the
                // partial index and must be left completely alone.
                await insertAccount(ROOT_A, 'Root Account', null);
                await insertAccount(ROOT_B, 'Root Account', null);

                // Only the keeper is posted to, so only the keeper keeps its name.
                for (const n of [0, 1]) {
                    await sandbox.query(
                        `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, value_num, value_denom, quantity_num, quantity_denom)
                         VALUES ($1, $2, $3, '', '', 'n', 100, 100, 100, 100)`,
                        [`${n}`.repeat(32), `${n}`.repeat(32), KEEPER],
                    );
                }

                await sandbox.query(ACCOUNTS_SIBLING_NAME_GUARD_DDL);

                const after = await namesByGuid();
                expect(after[KEEPER]).toBe('Cash');
                expect(after[LOSER_A]).toBe(`Cash (dup ${LOSER_A.slice(0, 8)}) 2`);
                expect(after[LOSER_B]).toBe(`Cash (dup ${LOSER_B.slice(0, 8)})`);
                expect(after[DECOY]).toBe(`Cash (dup ${LOSER_A.slice(0, 8)})`);
                expect(after[ROOT_A]).toBe('Root Account');
                expect(after[ROOT_B]).toBe('Root Account');
                // Renamed, never removed.
                expect(Object.keys(after)).toHaveLength(6);

                // The index the old guard could not create now exists.
                const index = await sandbox.query<{ indexdef: string }>(
                    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'uq_accounts_parent_name'`,
                    [SCHEMA],
                );
                expect(index.rows).toHaveLength(1);
                expect(index.rows[0].indexdef).toContain('WHERE (parent_guid IS NOT NULL)');

                // Every rename is recoverable: the complete original row, plus
                // the name it was given.
                const backups = await sandbox.query<{ row_key: string; row_data: Record<string, string> }>(
                    `SELECT row_key, row_data FROM gnucash_web_migration_backups
                     WHERE step_name = 'accounts-sibling-name-disambiguate' AND source_table = 'accounts'
                     ORDER BY row_key`,
                );
                expect(backups.rows).toHaveLength(2);
                expect(backups.rows.map(r => r.row_key.trim())).toEqual([LOSER_A, LOSER_B]);
                for (const row of backups.rows) {
                    expect(row.row_data.name).toBe('Cash');
                    expect(row.row_data.parent_guid.trim()).toBe(PARENT);
                    expect(row.row_data.gnucash_web_renamed_to).toBe(after[row.row_key.trim()]);
                }

                // Idempotent: a second startup is a no-op, not a second round
                // of renames on top of the first.
                await sandbox.query(ACCOUNTS_SIBLING_NAME_GUARD_DDL);
                expect(await namesByGuid()).toEqual(after);
                const backupsAgain = await sandbox.query(
                    `SELECT COUNT(*)::int AS n FROM gnucash_web_migration_backups`,
                );
                expect(backupsAgain.rows[0].n).toBe(2);

                // And the guarantee now holds against a writer that takes no
                // lock at all — which is the entire point of restoring it.
                await expect(insertAccount('7'.repeat(32), 'Cash', PARENT)).rejects.toMatchObject({
                    code: '23505',
                });
            } finally {
                await sandbox.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
                await sandbox.end();
            }
        }, DB_TIMEOUT_MS);
    },
);
