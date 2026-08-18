/**
 * ASI-5-009 (race half) — create-if-missing races in the SimpleFin sync,
 * proven against a REAL PostgreSQL database.
 *
 * Why this file exists at all: the sibling unit test drives the same functions
 * through an in-memory fake whose `acquireNamedXactLock` implements mutual
 * exclusion itself. A fake that implements the rule under test can only ever
 * confirm that the fake works. Six Prisma connections racing for one real
 * Postgres advisory lock is a thing only a real server can demonstrate — as is
 * what a unique index on accounts(parent_guid, name) does to scheduled
 * transactions, which is the other half of this file.
 *
 * Naming: `*.integration.test.ts` is the suffix of the integration tier being
 * wired in parallel (a postgres service in CI; the deploy workflow has none
 * yet). Until that lands the file is skipped, loudly, when no
 * TEST_DATABASE_URL is resolvable — see the skip title below. It is never a
 * silent pass: the whole describe block disappears from the report rather than
 * reporting green.
 *
 * Provisioning a database to run it against (throwaway, empty):
 *
 *     docker run -d --name gcw-itest-pg -e POSTGRES_PASSWORD=test \
 *       -e POSTGRES_USER=test -e POSTGRES_DB=gcw_itest -p 55434:5432 postgres:17-alpine
 *     npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma \
 *       --script -o /tmp/gcw-schema.sql
 *     docker exec -i gcw-itest-pg psql -v ON_ERROR_STOP=1 -U test -d gcw_itest < /tmp/gcw-schema.sql
 *     echo 'TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55434/gcw_itest' >> .env.test.local
 *
 * That schema is stricter than a real GnuCash book in one place that matters
 * here — see the `recurrences_obj_guid_fkey` note in beforeAll.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
/** Second posting account, so a scheduled transaction has two real splits. */
const SECOND_GUID = guid();
/**
 * The book's `root_template_guid`: where GnuCash keeps one child account per
 * scheduled transaction, each with one grandchild PER SPLIT, all named ''.
 */
const TEMPLATE_ROOT_GUID = guid();
const CURRENCY_GUID = guid();
/** A throwaway currency, so nothing here depends on (or disturbs) real USD. */
const CURRENCY = `TC${RUN}`;
const IMBALANCE_NAME = `Imbalance-${CURRENCY}`;
/** A throwaway ticker, likewise. */
const SYMBOL = `ZZ${RUN}`;
/**
 * Name for the run-scoped unique indexes the template tests build. Per-run, so
 * two workers sharing a database cannot collide on it.
 */
const SCOPED_INDEX = `uq_race_parent_name_${RUN.toLowerCase()}`;

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
        let scheduled: typeof import('../scheduled-tx-create');
        let dbInit: typeof import('@/lib/db-init');
        let prisma: (typeof import('@/lib/prisma'))['default'];
        /** True when this run seeded the book's 'Template Root' and must remove it. */
        let ownsTemplateRoot = false;
        /** Every scheduled transaction this run creates, for teardown. */
        const createdSxGuids: string[] = [];

        beforeAll(async () => {
            pool = new Pool({ connectionString: TEST_DATABASE_URL!, max: 4 });

            // A GnuCash book has no foreign keys at all; a database provisioned
            // from prisma/schema.prisma has the ones Prisma infers, and this
            // one is wrong: `recurrences.obj_guid` is polymorphic (budgets OR
            // scheduled transactions) and the schema models only the budget
            // side. Left in place it would reject the recurrence row GnuCash
            // itself writes, failing the scheduled-transaction tests below for
            // a reason that cannot happen in production. Not restored
            // afterwards on purpose: the constraint should not exist on a
            // GnuCash schema in the first place.
            await pool.query(
                'ALTER TABLE recurrences DROP CONSTRAINT IF EXISTS recurrences_obj_guid_fkey',
            );

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
            // scheduled-tx-create resolves the template root GLOBALLY, by the
            // name GnuCash gives it (`WHERE name = 'Template Root' AND
            // account_type = 'ROOT' LIMIT 1`), so on a database that already has
            // one the fixture must NOT add a second and then assume its own was
            // picked — that assumption would leave this run's template rows
            // behind under someone else's root. Seed one only when the database
            // has none, and derive the real root from each created transaction.
            const existingTemplateRoot = await pool.query<{ guid: string }>(
                `SELECT guid FROM accounts WHERE name = 'Template Root' AND account_type = 'ROOT' LIMIT 1`,
            );
            ownsTemplateRoot = existingTemplateRoot.rows.length === 0;
            if (ownsTemplateRoot) {
                await pool.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, 'Template Root', 'ROOT', $2, 100, 0, NULL, '', '', 0, 0)`,
                    [TEMPLATE_ROOT_GUID, CURRENCY_GUID],
                );
            }
            await pool.query(
                `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
                 VALUES ($1, $2, $3, $4)`,
                [
                    BOOK_GUID,
                    ROOT_GUID,
                    ownsTemplateRoot ? TEMPLATE_ROOT_GUID : existingTemplateRoot.rows[0].guid.trim(),
                    `Race book ${RUN}`,
                ],
            );
            await pool.query(
                `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                 VALUES ($1, $2, 'BANK', $3, 100, 0, $4, '', '', 0, 0)`,
                [PARENT_GUID, `Brokerage ${RUN}`, CURRENCY_GUID, ROOT_GUID],
            );
            await pool.query(
                `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                 VALUES ($1, $2, 'BANK', $3, 100, 0, $4, '', '', 0, 0)`,
                [SECOND_GUID, `Checking ${RUN}`, CURRENCY_GUID, ROOT_GUID],
            );

            service = await import('../simplefin-sync.service');
            scheduled = await import('../scheduled-tx-create');
            dbInit = await import('@/lib/db-init');
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

        /**
         * Deletes everything one scheduled transaction owns: its template
         * children (with their template transaction and splits and `account`
         * slots), its per-transaction template root, and its
         * schedxaction/recurrence/audit rows.
         *
         * Keyed on the transaction's OWN `template_act_guid`, never on the
         * fixture's template root, because the service picks the template root
         * globally and may well pick one this run did not create.
         */
        async function deleteScheduledTransaction(sxGuid: string): Promise<void> {
            const roots = await pool.query<{ template_act_guid: string | null }>(
                'SELECT template_act_guid FROM schedxactions WHERE guid = $1',
                [sxGuid],
            );
            const root = roots.rows[0]?.template_act_guid?.trim();
            if (root) {
                const kids = await pool.query<{ guid: string }>(
                    'SELECT guid FROM accounts WHERE parent_guid = $1',
                    [root],
                );
                const kidGuids = kids.rows.map(row => row.guid.trim());
                if (kidGuids.length > 0) {
                    const txs = await pool.query<{ tx_guid: string }>(
                        'SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY($1::varchar[])',
                        [kidGuids],
                    );
                    await pool.query(
                        'DELETE FROM splits WHERE account_guid = ANY($1::varchar[])',
                        [kidGuids],
                    );
                    const txGuids = txs.rows.map(row => row.tx_guid.trim());
                    if (txGuids.length > 0) {
                        await pool.query('DELETE FROM transactions WHERE guid = ANY($1::varchar[])', [
                            txGuids,
                        ]);
                    }
                    await pool.query('DELETE FROM slots WHERE obj_guid = ANY($1::varchar[])', [
                        kidGuids,
                    ]);
                    await pool.query('DELETE FROM accounts WHERE guid = ANY($1::varchar[])', [
                        kidGuids,
                    ]);
                }
            }
            await pool.query('DELETE FROM recurrences WHERE obj_guid = $1', [sxGuid]);
            await pool.query('DELETE FROM schedxactions WHERE guid = $1', [sxGuid]);
            await pool.query('DELETE FROM gnucash_web_audit WHERE entity_guid = $1', [sxGuid]);
            if (root) await pool.query('DELETE FROM accounts WHERE guid = $1', [root]);
        }

        afterAll(async () => {
            if (!pool) return;
            try {
                await prisma?.$disconnect();

                for (const sxGuid of createdSxGuids) await deleteScheduledTransaction(sxGuid);

                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [PARENT_GUID]);
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM books WHERE guid = $1', [BOOK_GUID]);
                await pool.query('DELETE FROM accounts WHERE guid = ANY($1::varchar[])', [
                    ownsTemplateRoot ? [ROOT_GUID, TEMPLATE_ROOT_GUID] : [ROOT_GUID],
                ]);
                await pool.query('DELETE FROM commodities WHERE guid = $1 OR mnemonic = $2', [
                    CURRENCY_GUID,
                    SYMBOL,
                ]);
                // Both indexes the tests below create on purpose: a failure
                // between creating one and dropping it must not leave it for the
                // next run, or for another tier sharing this database.
                await pool.query('DROP INDEX IF EXISTS uq_accounts_parent_name');
                await pool.query(`DROP INDEX IF EXISTS ${SCOPED_INDEX}`);

                // The rollback substitute: nothing this run wrote survives it.
                // Scoped to this run's rows on purpose — a global count would
                // flake against a database shared with another tier.
                const residue = await pool.query<{ n: number }>(
                    `SELECT (SELECT COUNT(*) FROM accounts
                             WHERE guid IN ($1, $2, $3) OR parent_guid IN ($1, $2, $3))
                          + (SELECT COUNT(*) FROM books WHERE guid = $4)
                          + (SELECT COUNT(*) FROM commodities WHERE guid = $5 OR mnemonic = $6)
                          + (SELECT COUNT(*) FROM schedxactions WHERE guid = ANY($7::varchar[]))
                          + (SELECT COUNT(*) FROM recurrences WHERE obj_guid = ANY($7::varchar[]))
                          + (SELECT COUNT(*) FROM gnucash_web_audit WHERE entity_guid = ANY($7::varchar[]))
                          + (SELECT COUNT(*) FROM transactions WHERE description LIKE $8)
                          + (SELECT COUNT(*) FROM accounts WHERE name LIKE $8) AS n`,
                    [
                        ROOT_GUID,
                        PARENT_GUID,
                        TEMPLATE_ROOT_GUID,
                        BOOK_GUID,
                        CURRENCY_GUID,
                        SYMBOL,
                        createdSxGuids,
                        `%${RUN}%`,
                    ],
                );
                expect(Number(residue.rows[0].n)).toBe(0);
            } finally {
                await pool.end();
            }
        }, DB_TIMEOUT_MS);

        /** A two-split scheduled transaction — the shape that has to keep working. */
        const twoSplitInput = (label: string) => ({
            name: `SX ${label} ${RUN}`,
            startDate: '2026-01-05',
            endDate: null,
            recurrence: {
                periodType: 'month',
                mult: 1,
                periodStart: '2026-01-05',
                weekendAdjust: 'none',
            },
            splits: [
                { accountGuid: PARENT_GUID, amount: -25 },
                { accountGuid: SECOND_GUID, amount: 25 },
            ],
            autoCreate: false,
            autoNotify: false,
        });

        /**
         * Creates one and records it for teardown BEFORE asserting anything, so
         * a failed assertion still cleans up.
         */
        async function createSx(label: string) {
            const result = await scheduled.createScheduledTransaction(twoSplitInput(label));
            if (result.success) createdSxGuids.push(result.guid);
            return result;
        }

        /** The template root the service actually used for `sxGuid`. */
        async function templateRootOf(sxGuid: string): Promise<string> {
            const rows = await pool.query<{ template_act_guid: string }>(
                'SELECT template_act_guid FROM schedxactions WHERE guid = $1',
                [sxGuid],
            );
            return rows.rows[0].template_act_guid.trim();
        }

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

        /**
         * The regression a cross-vendor review caught before it shipped, proven
         * rather than argued: `accounts(parent_guid, name)` is NOT a unique key
         * on a healthy book. `createTemplateContents` writes one child account
         * PER SPLIT of a scheduled transaction, all named '' under that
         * transaction's own template root (the real account each split posts to
         * lives in the child's `account` slot). GnuCash desktop writes the same
         * shape, and two scheduled transactions may share a name, which makes
         * their template roots duplicate siblings too.
         *
         * Both halves are demonstrated against rows THIS RUN owns, with
         * subtree-scoped indexes rather than the global one the retired guard
         * built. That is deliberate: a global unique index cannot be created at
         * all on a database that already violates the key — including one shared
         * with another tier mid-run — which would make this test's outcome
         * depend on ambient data instead of on the code under test.
         */
        it('proves a unique index on accounts(parent_guid, name) breaks scheduled transactions', async () => {
            const created = await createSx('Template');
            expect(created.success === false ? created.error : 'ok').toBe('ok');
            const templateRoot = await templateRootOf(
                created.success === true ? created.guid : '',
            );

            // Half one: the template children. Two siblings, same parent, both
            // named '' — so a unique index over just that subtree cannot even be
            // BUILT, which is the same rejection the second split would take on
            // insert.
            const children = await pool.query<{ name: string }>(
                'SELECT name FROM accounts WHERE parent_guid = $1',
                [templateRoot],
            );
            expect(children.rows.map(row => row.name)).toEqual(['', '']);
            await expect(
                pool.query(
                    `CREATE UNIQUE INDEX ${SCOPED_INDEX} ON accounts (parent_guid, name)
                     WHERE parent_guid = '${templateRoot}'`,
                ),
            ).rejects.toMatchObject({ code: '23505' });

            // Each child carries its real account in an `account` slot, which is
            // why the empty names are not a bug to be renamed away.
            const slots = await pool.query<{ guid_val: string }>(
                `SELECT guid_val FROM slots
                 WHERE name = 'account'
                   AND obj_guid IN (SELECT guid FROM accounts WHERE parent_guid = $1)`,
                [templateRoot],
            );
            expect(slots.rows.map(row => row.guid_val.trim()).sort()).toEqual(
                [PARENT_GUID, SECOND_GUID].sort(),
            );

            // Half two: the per-transaction template roots are siblings named
            // after the scheduled transaction, and nothing stops two
            // transactions sharing a name. With a unique index over just that
            // parent, creating the second one FAILS at runtime — the user-facing
            // break, on a key an index predicate could never exclude.
            const parentOfRoots = await pool.query<{ parent_guid: string }>(
                'SELECT parent_guid FROM accounts WHERE guid = $1',
                [templateRoot],
            );
            await pool.query(
                `CREATE UNIQUE INDEX ${SCOPED_INDEX} ON accounts (parent_guid, name)
                 WHERE parent_guid = '${parentOfRoots.rows[0].parent_guid.trim()}'`,
            );
            try {
                const clash = await createSx('Template');
                expect(clash.success).toBe(false);
                expect(clash.success === false && clash.error).toMatch(
                    /duplicate key value|unique constraint/i,
                );
                // A single transaction, so the failed create leaves nothing
                // half-built.
                const roots = await pool.query<{ n: number }>(
                    `SELECT COUNT(*)::int AS n FROM accounts WHERE parent_guid = $1 AND name = $2`,
                    [parentOfRoots.rows[0].parent_guid.trim(), `SX Template ${RUN}`],
                );
                expect(roots.rows[0].n).toBe(1);
            } finally {
                await pool.query(`DROP INDEX IF EXISTS ${SCOPED_INDEX}`);
            }
        }, DB_TIMEOUT_MS);

        /**
         * The recovery path for the databases the earlier release already
         * indexed: it built `uq_accounts_parent_name` on any book that happened
         * to have no multi-split scheduled transaction at startup, and the first
         * one the user created afterwards failed. db-init has to remove it, and
         * has to SAY so — through `console`, because node-postgres discards a
         * Postgres `RAISE WARNING` unseen, which is how the previous generation
         * of guards managed to disable themselves silently.
         *
         * Seeded in the EXACT shape every release that built it used —
         * `ON accounts (parent_guid, name) WHERE parent_guid IS NOT NULL`,
         * excluding the NULL-parent root rows. The shape matters now:
         * retirement no longer keys on the index NAME, it verifies the index is
         * the one this app created (`isRetiredAccountsSiblingNameIndex`), so
         * seeding any other shape would exercise the refusal path instead —
         * which the next test does deliberately.
         *
         * Building that index needs a book with no duplicate siblings, and this
         * file's earlier tests deliberately created some (a scheduled
         * transaction's template children all share (parent, '')). They are
         * removed first, through the same service that created them. If the
         * database still holds duplicate siblings from somewhere else, the
         * CREATE fails with 23505 — which is honest: the index being retired
         * could never have existed on such a database either.
         */
        it('retires a pre-existing uq_accounts_parent_name, visibly, and leaves creation working', async () => {
            // splice(0): these are gone, so afterAll must not try again.
            for (const sxGuid of createdSxGuids.splice(0)) await deleteScheduledTransaction(sxGuid);

            await pool.query(
                `CREATE UNIQUE INDEX uq_accounts_parent_name ON accounts (parent_guid, name)
                 WHERE parent_guid IS NOT NULL`,
            );

            const messages: string[] = [];
            const warn = vi
                .spyOn(console, 'warn')
                // Collected here rather than read off `warn.mock.calls` after
                // the fact: mockRestore() also resets the recorded calls.
                .mockImplementation((...args: unknown[]) => { messages.push(String(args[0])); });
            try {
                await dbInit.initializeDatabase();
            } finally {
                warn.mockRestore();
            }
            // The message names the object AND quotes what was dropped, so the
            // operator can tell exactly what left their database.
            expect(messages.some(m => /dropped index .*uq_accounts_parent_name/.test(m))).toBe(true);
            expect(messages.some(m => /USING btree \(parent_guid, name\)/.test(m))).toBe(true);
            expect(messages.some(m => /scheduled transaction/i.test(m))).toBe(true);

            const stillThere = await pool.query(
                `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_accounts_parent_name'`,
            );
            expect(stillThere.rows).toHaveLength(0);

            const after = await createSx('Retired');
            expect(after.success === false ? after.error : 'ok').toBe('ok');
        }, DB_TIMEOUT_MS);

        /**
         * The other half of the same contract: an index this app did NOT
         * create keeps the name but not the shape, and must survive startup.
         * Deleting a stranger's index because the name matched is how startup
         * DDL eats an operator's work.
         */
        it('refuses to drop a same-named index it did not create, and says so', async () => {
            await pool.query(
                `CREATE UNIQUE INDEX uq_accounts_parent_name
                 ON accounts (parent_guid, name, code) WHERE guid = '${PARENT_GUID}'`,
            );

            const messages: string[] = [];
            const warn = vi
                .spyOn(console, 'warn')
                .mockImplementation((...args: unknown[]) => { messages.push(String(args[0])); });
            try {
                await dbInit.initializeDatabase();
            } finally {
                warn.mockRestore();
            }

            try {
                const survived = await pool.query(
                    `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_accounts_parent_name'`,
                );
                expect(survived.rows).toHaveLength(1);
                expect(messages.some(m => /is NOT the index this app retired/.test(m))).toBe(true);
            } finally {
                await pool.query(`DROP INDEX IF EXISTS uq_accounts_parent_name`);
            }
        }, DB_TIMEOUT_MS);

        /**
         * What replaced the rejected rename migration: a report, and one that
         * has to be silent on a healthy book. The rename was rejected twice
         * over — it would have renamed the template children above on EVERY
         * healthy book, and renaming an account is not even safe in general,
         * because personal-import.ts, qif/importer.ts and
         * settlement-import.service.ts all resolve accounts by name, so a
         * rename can redirect a later import into a different ledger account.
         *
         * Asserted as deltas rather than absolute counts, so the numbers hold
         * on a database shared with another tier's fixtures.
         */
        it('counts duplicate REAL sibling names while structurally ignoring template accounts', async () => {
            const count = async () => {
                const rows = await pool.query<{ dupes: number }>(
                    dbInit.REAL_SIBLING_NAME_DUPLICATES_COUNT_SQL,
                );
                return Number(rows.rows[0].dupes);
            };

            const baseline = await count();

            const created = await createSx('Report');
            expect(created.success === false ? created.error : 'ok').toBe('ok');

            // Premise check: the template children ARE duplicate siblings by the
            // raw key, so a report that did not exclude them structurally would
            // now be non-zero.
            const raw = await pool.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM (
                    SELECT parent_guid, name FROM accounts WHERE parent_guid IS NOT NULL
                    GROUP BY parent_guid, name HAVING COUNT(*) > 1) d`,
            );
            expect(raw.rows[0].n).toBeGreaterThan(0);

            // The property that matters: a healthy book reports nothing, so
            // nothing on it would ever be "remediated".
            expect(await count()).toBe(baseline);

            // A genuine anomaly — two real siblings sharing a name — is
            // reported, which also proves the real account tree is not being
            // misclassified as templates.
            const dupName = `Dup ${RUN}`;
            const dupA = guid();
            const dupB = guid();
            const insertDup = (rowGuid: string) =>
                pool.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, $2, 'BANK', $3, 100, 0, $4, '', '', 0, 0)`,
                    [rowGuid, dupName, CURRENCY_GUID, PARENT_GUID],
                );
            await insertDup(dupA);
            await insertDup(dupB);
            try {
                expect(await count()).toBe(baseline + 1);
            } finally {
                await pool.query('DELETE FROM accounts WHERE guid = ANY($1::varchar[])', [
                    [dupA, dupB],
                ]);
            }
            expect(await count()).toBe(baseline);
        }, DB_TIMEOUT_MS);
    },
);
