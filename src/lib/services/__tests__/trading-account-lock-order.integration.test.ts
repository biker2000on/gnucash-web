/**
 * The ABBA deadlock between two ORDINARY multi-currency transaction saves,
 * proven against a REAL PostgreSQL database.
 *
 * ## What is being proven
 *
 * `processMultiCurrencySplits` (src/lib/trading-accounts.ts) asks
 * `getOrCreateTradingAccount` for one `Trading:<namespace>:<mnemonic>` account
 * per imbalanced commodity, and each of those claims
 * `account:(Trading:<namespace>, <mnemonic>)` on its way to being created.
 *
 * The set it iterates came from `calculateImbalances`, which preserves SPLIT
 * ENCOUNTER ORDER. So a USD->EUR save walks {USD, EUR} and an EUR->USD save
 * walks {EUR, USD} — the same two keys, in opposite orders:
 *
 *     T1  holds  account:(Trading:CURRENCY, 'USD')   wants  ...'EUR'
 *     T2  holds  account:(Trading:CURRENCY, 'EUR')   wants  ...'USD'
 *
 * `pg_advisory_xact_lock` is held to COMMIT, so neither can yield. PostgreSQL
 * breaks the cycle by aborting one side with SQLSTATE 40P01, and the user who
 * pressed Save gets a 500.
 *
 * Nothing about this needed an import or an admin action. Two people saving
 * currency transfers in opposite directions is enough, which is what makes it
 * worth a database-backed test rather than an argument.
 *
 * The fix sorts the imbalance set into the canonical acquisition order
 * (src/lib/account-lock-order.ts) before claiming any of it, so both saves take
 * 'EUR' then 'USD' and the second simply queues behind the first.
 *
 * ## The two halves of this file
 *
 * 1. `reproduces the pre-fix cycle` drives the OLD order directly against the
 *    database — two connections claiming the two keys the way the unsorted
 *    loop did. It asserts a real 40P01 arrives. Without this the second test
 *    proves only that something did not happen, which any bug in the harness
 *    also achieves.
 * 2. `two opposed saves do not deadlock` runs the REAL
 *    `processMultiCurrencySplits` on both connections and asserts neither
 *    reports 40P01 and both produce correct trading splits.
 *
 * ## How the interleaving is made deterministic
 *
 * Not with sleeps. Each side takes its FIRST key, and the test then waits for
 * PostgreSQL itself to report — via `pg_blocking_pids`, naming the blocker —
 * that the other side is genuinely parked on it before either is allowed to
 * reach for its second key. A run where that did not happen fails rather than
 * passing vacuously.
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
import { describeSettled, isDeadlock } from '@/__tests__/integration/deadlock';

/** See the identical resolver in account-lock-hierarchy-deadlock.integration.test.ts. */
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
const TRADING_GUID = guid();
/** The `Trading:CURRENCY` group. Its two children are the contested keys. */
const NAMESPACE_GUID = guid();
const ALPHA_COMMODITY = guid();
const BETA_COMMODITY = guid();
const ALPHA_ACCOUNT = guid();
const BETA_ACCOUNT = guid();

/**
 * Two currencies whose mnemonics have a KNOWN sort relation, because the fix
 * is "claim in sorted order" and the test must be able to say which key that
 * makes first. `AA…` sorts before `ZZ…`.
 */
const ALPHA = `AA${RUN}`.slice(0, 8);
const BETA = `ZZ${RUN}`.slice(0, 8);

const OWNED_ACCOUNTS = [ROOT_GUID, TRADING_GUID, NAMESPACE_GUID, ALPHA_ACCOUNT, BETA_ACCOUNT];

const DB_TIMEOUT_MS = 60_000;
/** Under Prisma's 5s interactive-transaction timeout — see the sibling file. */
const PARK_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The error a settled promise carries, or null when it fulfilled. */
function reasonOf<T>(settled: PromiseSettledResult<T>): unknown {
    return settled.status === 'rejected' ? settled.reason : null;
}

describeWithDatabase(
    'trading-account lock order: two opposed multi-currency saves (requires TEST_DATABASE_URL; set it in .env.test.local at the repo root)',
    () => {
        let pool: Pool;
        let processMultiCurrencySplits: (typeof import('@/lib/trading-accounts'))['processMultiCurrencySplits'];
        let prisma: (typeof import('@/lib/prisma'))['default'];

        beforeAll(async () => {
            pool = new Pool({ connectionString: TEST_DATABASE_URL!, max: 8 });

            const commodity = async (g: string, mnemonic: string) =>
                pool.query(
                    `INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
                     VALUES ($1, 'CURRENCY', $2, $2, '', 100, 0, '', '')`,
                    [g, mnemonic],
                );
            await commodity(ALPHA_COMMODITY, ALPHA);
            await commodity(BETA_COMMODITY, BETA);

            const account = async (
                g: string,
                name: string,
                type: string,
                parent: string | null,
                commodityGuid: string,
                placeholder: number,
            ) =>
                pool.query(
                    `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
                     VALUES ($1, $2, $3, $4, 100, 0, $5, '', '', 0, $6)`,
                    [g, name, type, commodityGuid, parent, placeholder],
                );

            await account(ROOT_GUID, `Root ${RUN}`, 'ROOT', null, ALPHA_COMMODITY, 1);
            await pool.query(
                `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
                 VALUES ($1, $2, $2, $3)`,
                [BOOK_GUID, ROOT_GUID, `Trading order book ${RUN}`],
            );

            // The Trading root and its CURRENCY group ALREADY EXIST. That is
            // the reachable shape: the deadlock needs both saves to contend on
            // the two LEAF keys, which only happens once their shared parents
            // are in place — otherwise the first save to arrive holds the
            // parent key and the second simply queues behind it.
            await account(TRADING_GUID, 'Trading', 'TRADING', ROOT_GUID, ALPHA_COMMODITY, 1);
            await account(NAMESPACE_GUID, 'CURRENCY', 'TRADING', TRADING_GUID, ALPHA_COMMODITY, 1);

            // The two ordinary asset accounts a user would transfer between.
            await account(ALPHA_ACCOUNT, `Alpha ${RUN}`, 'BANK', ROOT_GUID, ALPHA_COMMODITY, 0);
            await account(BETA_ACCOUNT, `Beta ${RUN}`, 'BANK', ROOT_GUID, BETA_COMMODITY, 0);

            processMultiCurrencySplits = (await import('@/lib/trading-accounts')).processMultiCurrencySplits;
            prisma = (await import('@/lib/prisma')).default;
            // Warm the pool: a connection established mid-race would add
            // latency to the very step whose blocking is being observed.
            await prisma.$queryRaw`SELECT 1 AS warm`;
        }, DB_TIMEOUT_MS);

        afterAll(async () => {
            if (!pool) return;
            try {
                await prisma?.$disconnect();
                await pool.query('DELETE FROM books WHERE guid = $1', [BOOK_GUID]);
                // Deepest first: accounts.parent_guid is a real FK. The saves
                // create leaves under NAMESPACE_GUID whose guids this file
                // never sees, so delete by parentage rather than a guid list.
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [NAMESPACE_GUID]);
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [TRADING_GUID]);
                await pool.query('DELETE FROM accounts WHERE parent_guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM accounts WHERE guid = $1', [ROOT_GUID]);
                await pool.query('DELETE FROM commodities WHERE guid = ANY($1::varchar[])', [
                    [ALPHA_COMMODITY, BETA_COMMODITY],
                ]);

                // The rollback substitute: nothing this run wrote survives it.
                // Also counts by NAME and by MNEMONIC, so a row created under
                // some other guid cannot slip past the guid list.
                const residue = await pool.query<{ n: number }>(
                    `SELECT (SELECT COUNT(*) FROM accounts
                             WHERE guid = ANY($1::varchar[])
                                OR parent_guid = ANY($1::varchar[])
                                OR name LIKE $2)
                          + (SELECT COUNT(*) FROM books WHERE guid = $3)
                          + (SELECT COUNT(*) FROM commodities
                             WHERE guid = ANY($4::varchar[]) OR mnemonic LIKE $2) AS n`,
                    [OWNED_ACCOUNTS, `%${RUN}%`, BOOK_GUID, [ALPHA_COMMODITY, BETA_COMMODITY]],
                );
                expect(Number(residue.rows[0].n)).toBe(0);
            } finally {
                await pool.end();
            }
        }, DB_TIMEOUT_MS);

        /**
         * Waits until PostgreSQL reports at least one backend in THIS database
         * blocked specifically BY `blockerPid`.
         *
         * `pg_blocking_pids` names the blocker, so this is a real wait-for edge
         * rather than the weaker inference from "something somewhere is not
         * granted".
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

        /** The key `getOrCreateTradingAccount` claims for a currency leaf. */
        const leafKey = (mnemonic: string) => `account:${NAMESPACE_GUID}:${mnemonic}`;

        async function backendPid(client: PoolClient): Promise<number> {
            const res = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            return Number(res.rows[0].pid);
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
            'reproduces the pre-fix cycle: the two leaf keys claimed in opposite orders deadlock',
            async () => {
                // Drives the OLD behaviour directly: split-encounter order, so
                // one save reaches BETA first and the other ALPHA first. This
                // is what the unsorted loop in processMultiCurrencySplits did,
                // reduced to the two statements that matter.
                const first: PoolClient = await pool.connect();
                const second: PoolClient = await pool.connect();
                try {
                    await first.query('BEGIN');
                    await second.query('BEGIN');
                    await first.query("SET LOCAL lock_timeout = '20s'");
                    await second.query("SET LOCAL lock_timeout = '20s'");

                    // Each takes ITS first key and holds it.
                    await first.query('SELECT pg_advisory_xact_lock(hashtext($1))', [leafKey(ALPHA)]);
                    await second.query('SELECT pg_advisory_xact_lock(hashtext($1))', [leafKey(BETA)]);

                    const firstPid = await backendPid(first);
                    const secondPid = await backendPid(second);

                    // Now each reaches for the OTHER's key. Neither can yield:
                    // pg_advisory_xact_lock is released only at COMMIT.
                    const firstWait = first
                        .query('SELECT pg_advisory_xact_lock(hashtext($1))', [leafKey(BETA)])
                        .catch((e: unknown) => e);
                    // Prove the first side is genuinely parked on the second's
                    // key before closing the cycle, so this cannot pass by luck.
                    expect(await waitForBlockedBy(secondPid)).toBeGreaterThanOrEqual(1);

                    const secondWait = second
                        .query('SELECT pg_advisory_xact_lock(hashtext($1))', [leafKey(ALPHA)])
                        .catch((e: unknown) => e);
                    expect(await waitForBlockedBy(firstPid)).toBeGreaterThanOrEqual(1);

                    const outcomes = await Promise.all([firstWait, secondWait]);

                    // THE POINT OF THIS TEST. PostgreSQL detects the cycle and
                    // aborts exactly one side with 40P01. If this ever stops
                    // being true the second test below proves nothing.
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
            'two opposed saves do not deadlock, and both produce correct trading splits',
            async () => {
                // The real thing: two multi-currency saves in opposite
                // directions, each through processMultiCurrencySplits, running
                // concurrently against the same Trading:CURRENCY parent.
                //
                // The splits are handed over in OPPOSITE orders on purpose —
                // that is the input that used to decide the claim order.
                const scope = () =>
                    new Set([ROOT_GUID, TRADING_GUID, NAMESPACE_GUID, ALPHA_ACCOUNT, BETA_ACCOUNT]);

                const alphaToBeta = prisma.$transaction(
                    tx =>
                        processMultiCurrencySplits(
                            [
                                { account_guid: ALPHA_ACCOUNT, value_num: -10000, value_denom: 100, quantity_num: -10000, quantity_denom: 100 },
                                { account_guid: BETA_ACCOUNT, value_num: 10000, value_denom: 100, quantity_num: 8500, quantity_denom: 100 },
                            ],
                            tx,
                            scope(),
                        ),
                    { timeout: 20_000, maxWait: 15_000 },
                );
                const betaToAlpha = prisma.$transaction(
                    tx =>
                        processMultiCurrencySplits(
                            [
                                { account_guid: BETA_ACCOUNT, value_num: -8500, value_denom: 100, quantity_num: -8500, quantity_denom: 100 },
                                { account_guid: ALPHA_ACCOUNT, value_num: 8500, value_denom: 100, quantity_num: 10000, quantity_denom: 100 },
                            ],
                            tx,
                            scope(),
                        ),
                    { timeout: 20_000, maxWait: 15_000 },
                );
                alphaToBeta.catch(() => {});
                betaToAlpha.catch(() => {});

                const [forward, backward] = await Promise.allSettled([alphaToBeta, betaToAlpha]);

                // THE INVARIANT. Asserted first, with the offending error
                // attached, so a regression reports the deadlock itself rather
                // than a downstream symptom.
                const forwardErr = reasonOf(forward);
                const backwardErr = reasonOf(backward);
                expect(
                    { forward: isDeadlock(forwardErr), backward: isDeadlock(backwardErr) },
                    `deadlock (40P01) reported.\n  A->B: ${describeSettled(forward)}\n  B->A: ${describeSettled(backward)}`,
                ).toEqual({ forward: false, backward: false });

                // Both saves succeeded outright — the loser of the race for a
                // key simply queued behind the winner and then adopted the row
                // it had committed.
                expect(forward.status, `A->B: ${describeSettled(forward)}`).toBe('fulfilled');
                expect(backward.status, `B->A: ${describeSettled(backward)}`).toBe('fulfilled');

                for (const settled of [forward, backward]) {
                    if (settled.status !== 'fulfilled') continue;
                    expect(settled.value.isMultiCurrency).toBe(true);
                    // Two original splits plus one trading split per commodity.
                    expect(settled.value.allSplits).toHaveLength(4);
                }

                // The duplicate-sibling invariant the whole branch exists for:
                // exactly one Trading leaf per currency, not one per save.
                expect(await siblingsOn(NAMESPACE_GUID, ALPHA)).toBe(1);
                expect(await siblingsOn(NAMESPACE_GUID, BETA)).toBe(1);
                // And no second Trading tree was grown alongside the existing one.
                expect(await siblingsOn(ROOT_GUID, 'Trading')).toBe(1);
                expect(await siblingsOn(TRADING_GUID, 'CURRENCY')).toBe(1);
            },
            DB_TIMEOUT_MS,
        );
    },
);
