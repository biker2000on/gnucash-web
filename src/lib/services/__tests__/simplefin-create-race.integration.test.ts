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

const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip;

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
 * Note the asymmetry this test has, and cannot lose: against the FIXED code it
 * passes every time (one account is the invariant, however the racers land),
 * while against broken code it fails only when the scheduler actually
 * interleaves them — usually, not always. A real race can be under-observed;
 * it cannot be falsely convicted. Warming the pool below removes the largest
 * source of skew (first-connection latency) so the window is as wide as this
 * harness can make it.
 */
const RACERS = 6;

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
        });

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
        });

        it('creates exactly one Imbalance account under concurrent syncs', async () => {
            // The book scope a real sync would carry: captured before any of
            // these creations, and (like the memoised one in production) never
            // updated by them.
            const bookScope = new Set([ROOT_GUID, PARENT_GUID]);

            const guids = await Promise.all(
                Array.from({ length: RACERS }, () =>
                    service.getOrCreateImbalanceAccount(CURRENCY, BOOK_GUID, bookScope),
                ),
            );

            expect(new Set(guids).size).toBe(1);
            const rows = await pool.query<{ guid: string }>(
                'SELECT guid FROM accounts WHERE parent_guid = $1 AND name = $2',
                [ROOT_GUID, IMBALANCE_NAME],
            );
            expect(rows.rows).toHaveLength(1);
            expect(guids[0]).toBe(rows.rows[0].guid);
        });

        it('creates exactly one Cash child under concurrent syncs, and counts one creation', async () => {
            const bookScope = new Set([ROOT_GUID, PARENT_GUID]);
            const created = { count: 0 };

            const guids = await Promise.all(
                Array.from({ length: RACERS }, () =>
                    service.getOrCreateCashChild(PARENT_GUID, BOOK_GUID, bookScope, created),
                ),
            );

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
        });

        it('creates exactly one symbol child and one commodity under concurrent syncs', async () => {
            const bookScope = new Set([ROOT_GUID, PARENT_GUID]);
            const created = { count: 0 };

            const guids = await Promise.all(
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
            );

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
        });

        it('has the database itself refuse a duplicate sibling, lock or no lock', async () => {
            // This is why the fix does not rest on the advisory lock alone: the
            // index binds writers that never take it. Its presence is also what
            // makes the winner-adoption path in the service reachable.
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
        });
    },
);
