/**
 * REAL contention tests against a live PostgreSQL server.
 *
 * This is the file the integration tier exists for. `harness.integration.test.ts`
 * proves the tier can reach a database; this one proves the application's
 * concurrency contracts actually hold, by holding a lock on one connection and
 * watching what a second connection running APPLICATION code does about it.
 *
 * Every test here follows the same shape, and the shape is the point:
 *
 *   1. a test-owned connection takes a lock (advisory, or a row lock inside an
 *      open transaction) and HOLDS it;
 *   2. application code is invoked on a different connection;
 *   3. a third connection reads `pg_locks` to prove the application backend is
 *      genuinely WAITING - not merely slow, not merely returning something
 *      plausible - and the test asserts the operation has not run yet;
 *   4. the holder releases, and the application call is asserted to complete
 *      with the outcome its contract promises.
 *
 * Step 3 is what a mocked pool cannot do at any level of effort, and it is why
 * deleting the lock from the code under test turns these red. A unit test with
 * a fake client can only assert that a string containing "FOR UPDATE" was
 * passed to a spy; it cannot observe that anything was serialized.
 *
 * Coverage maps to the three mechanisms the codebase relies on:
 *   - session advisory locks      src/lib/db.ts
 *   - SELECT ... FOR UPDATE       src/lib/services/reconciled-split.service.ts
 *   - idempotency claim           src/lib/webhook-idempotency.ts
 *
 * DATA. These tests write rows. TEST_DATABASE_URL may be a long-lived local
 * database (the tier does not create a per-run schema - see
 * vitest.integration.config.ts), so every row written here carries a per-run
 * suffix and is deleted in afterAll.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPool, withTestClient } from './db';
import { hasTestDatabaseUrl } from './env';

/**
 * Guard evaluated at module scope but never throwing there: without a database
 * the whole describe is skipped instead of the import blowing up. The tier's
 * setup file is what hard-fails on a missing TEST_DATABASE_URL; this keeps the
 * file itself harmless if it is ever collected by a config that does not use
 * that setup file.
 */
const HAS_TEST_DATABASE = hasTestDatabaseUrl();

/** Distinguishes this run's rows from any left by another run. */
const RUN_ID = randomUUID().replace(/-/g, '');

/** GnuCash guid columns are VARCHAR(32); a dash-stripped uuid is exactly 32. */
function testGuid(): string {
    return randomUUID().replace(/-/g, '');
}

const CURRENCY_GUID = testGuid();
const TX_GUID = testGuid();
const BOOK_GUID = testGuid();

/** Lazily imported so nothing in src/lib is evaluated when the suite skips. */
let appDb: typeof import('@/lib/db');
let prismaModule: typeof import('@/lib/prisma');
let reconciledSplits: typeof import('@/lib/services/reconciled-split.service');
let webhookIdempotency: typeof import('@/lib/webhook-idempotency');

/**
 * Polls until `predicate` holds. Lock acquisition is asynchronous inside
 * Postgres - the waiter appears in `pg_locks` a moment after the statement is
 * issued - so there is nothing to await on the client side. Failure text names
 * what never happened, because "timed out after 10000ms" on its own has never
 * helped anyone.
 */
async function waitUntil(
    predicate: () => Promise<boolean>,
    description: string,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * How many backends hold - or are queued behind - the session advisory lock
 * that `lockName` maps to, read from outside every party involved.
 *
 * `pg_advisory_lock(hashtext($1))` is the single-argument (bigint) form, which
 * Postgres records as classid = high 32 bits, objid = low 32 bits,
 * objsubid = 1. hashtext() returns a signed int4, so the shift is masked back
 * to 32 unsigned bits rather than compared directly - a negative hash would
 * otherwise never match.
 */
async function countAdvisoryLocks(lockName: string, granted: boolean): Promise<number> {
    const result = await getTestPool().query<{ locks: number }>(
        `WITH k AS (SELECT hashtext($1)::bigint AS key)
         SELECT count(*)::int AS locks
         FROM pg_locks l, k
         WHERE l.locktype = 'advisory'
           AND l.granted = $2
           AND l.classid = ((k.key >> 32) & 4294967295)::oid
           AND l.objid = (k.key & 4294967295)::oid
           AND l.objsubid = 1`,
        [lockName, granted],
    );
    return result.rows[0].locks;
}

/** Backends BLOCKED on `lockName`, i.e. queued behind whoever holds it. */
function advisoryLockWaiters(lockName: string): Promise<number> {
    return countAdvisoryLocks(lockName, false);
}

/** Backends currently HOLDING `lockName`. */
function advisoryLockHolders(lockName: string): Promise<number> {
    return countAdvisoryLocks(lockName, true);
}

/**
 * How many backends are blocked waiting for transaction `xid` to end. This is
 * how Postgres reports BOTH kinds of row-level contention used below: a
 * `SELECT ... FOR UPDATE` queued behind another transaction's row lock, and an
 * `INSERT ... ON CONFLICT` queued behind another transaction's uncommitted
 * unique-index tuple. Both wait on the holder's transactionid.
 */
async function transactionWaiters(xid: string): Promise<number> {
    const result = await getTestPool().query<{ waiters: number }>(
        `SELECT count(*)::int AS waiters
         FROM pg_locks
         WHERE locktype = 'transactionid'
           AND NOT granted
           AND transactionid::text = $1`,
        [xid],
    );
    return result.rows[0].waiters;
}

/** The holder transaction's id, so waiters on it can be counted precisely. */
async function currentXid(client: { query: (sql: string) => Promise<{ rows: { xid: string }[] }> }) {
    const result = await client.query('SELECT pg_current_xact_id()::text AS xid');
    return result.rows[0].xid;
}

describe.skipIf(!HAS_TEST_DATABASE)('database contention (real PostgreSQL)', () => {
    beforeAll(async () => {
        // Dynamic: keeps application modules - and the connection pools they
        // open at import time - out of module evaluation when this file is
        // skipped for want of a database.
        appDb = await import('@/lib/db');
        prismaModule = await import('@/lib/prisma');
        reconciledSplits = await import('@/lib/services/reconciled-split.service');
        webhookIdempotency = await import('@/lib/webhook-idempotency');

        // Prime the lazy table creation before any contention test runs. Its DO
        // block ends in CREATE UNIQUE INDEX IF NOT EXISTS, and CREATE INDEX
        // takes a ShareLock on the table BEFORE it evaluates IF NOT EXISTS - so
        // on a first call it would queue behind the open transaction the
        // idempotency test deliberately holds, and the observed block would be
        // schema provisioning rather than the claim under test.
        await webhookIdempotency.ensureWebhookIdempotencyTable();

        // Fixture for the FOR UPDATE test: one transaction row to lock, and the
        // currency row its FK requires.
        await getTestPool().query(
            `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag)
             VALUES ($1, 'INTEGRATION-TEST', $2, 'Integration test currency', 100, 0)`,
            [CURRENCY_GUID, `ITEST${RUN_ID.slice(0, 8)}`],
        );
        await getTestPool().query(
            `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
             VALUES ($1, $2, '', NOW(), NOW(), $3)`,
            [TX_GUID, CURRENCY_GUID, `integration lock fixture ${RUN_ID}`],
        );
    });

    afterAll(async () => {
        // Leave the database as it was found: TEST_DATABASE_URL is frequently a
        // developer's long-lived local database, not a fresh container.
        await getTestPool().query(
            'DELETE FROM gnucash_web_webhook_idempotency WHERE book_guid = $1',
            [BOOK_GUID],
        );
        await getTestPool().query('DELETE FROM transactions WHERE guid = $1', [TX_GUID]);
        await getTestPool().query('DELETE FROM commodities WHERE guid = $1', [CURRENCY_GUID]);
        // The application pools opened by the dynamic imports above are not the
        // tier's own pool, so the setup file's closeTestPool cannot reach them.
        await prismaModule?.default.$disconnect();
    });

    describe('session advisory locks (src/lib/db.ts)', () => {
        it('tryWithDatabaseAdvisoryLock takes a free lock and runs the operation', async () => {
            // The other half of the contract - and the half whose absence let a
            // `return { acquired: false }` stub satisfy every other test in this
            // file for free. Testing the helper ONLY while a competing session
            // holds the lock means deleting the locking entirely still looks
            // green, because refusing is the expected answer there.
            //
            // The mid-flight pg_locks read is what makes this more than an
            // outcome check: it observes the lock existing IN THE SERVER while
            // the operation is inside the critical section, so a stub that
            // returns `acquired: true` and runs the work without ever calling
            // pg_try_advisory_lock goes red here rather than passing.
            const lockName = `integration-test:uncontended:${RUN_ID}`;

            expect(await advisoryLockHolders(lockName)).toBe(0);

            let heldDuringOperation = -1;
            let operationRan = false;
            const outcome = await appDb.tryWithDatabaseAdvisoryLock(lockName, async () => {
                operationRan = true;
                heldDuringOperation = await advisoryLockHolders(lockName);
                return 'ran';
            });

            expect(outcome).toEqual({ acquired: true, result: 'ran' });
            expect(operationRan).toBe(true);
            expect(heldDuringOperation).toBe(1);
        });

        it('tryWithDatabaseAdvisoryLock releases the lock once the operation finishes', async () => {
            // Release is invisible in the return value, so it needs its own
            // assertion or dropping the pg_advisory_unlock costs nothing. The
            // connection the helper used goes back to the pool still holding
            // the lock, and from then on whoever borrows it inherits a lock
            // nobody knows about while every future caller is refused.
            //
            // Asserted two ways because they fail differently: no backend still
            // holds the key, and an unrelated session can actually take it.
            const lockName = `integration-test:release:${RUN_ID}`;

            const outcome = await appDb.tryWithDatabaseAdvisoryLock(lockName, async () => 'ran');
            expect(outcome).toEqual({ acquired: true, result: 'ran' });

            expect(await advisoryLockHolders(lockName)).toBe(0);

            await withTestClient(async (probe) => {
                const taken = await probe.query<{ locked: boolean }>(
                    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
                    [lockName],
                );
                expect(taken.rows[0].locked).toBe(true);
                await probe.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
            });
        });

        it('tryWithDatabaseAdvisoryLock refuses a lock another session holds', async () => {
            // The non-blocking variant's entire contract: when someone else has
            // it, report `acquired: false` and DO NOT run the operation. Callers
            // (lot-assignment.ts) turn that into "already in progress" instead
            // of running a second scrub over the same lots. Remove the
            // pg_try_advisory_lock and the operation runs concurrently here.
            const lockName = `integration-test:try:${RUN_ID}`;

            await withTestClient(async (holder) => {
                await holder.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
                try {
                    let operationRan = false;
                    const outcome = await appDb.tryWithDatabaseAdvisoryLock(lockName, async () => {
                        operationRan = true;
                        return 'should not happen';
                    });

                    expect(outcome).toEqual({ acquired: false });
                    expect(operationRan).toBe(false);
                } finally {
                    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
                }
            });
        });

        it('withDatabaseAdvisoryLock blocks until the holder releases', async () => {
            // The blocking variant, used by initializeDatabase() so two app
            // processes starting at once cannot run the DDL concurrently. This
            // asserts serialization itself, not the SQL text: the application
            // backend is observed sitting in pg_locks with granted = false.
            const lockName = `integration-test:blocking:${RUN_ID}`;

            await withTestClient(async (holder) => {
                await holder.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
                let released = false;
                let operationRan = false;

                const pending = appDb.withDatabaseAdvisoryLock(lockName, async () => {
                    operationRan = true;
                    return 'ran';
                });
                // Attach a no-op catch immediately: if the assertions below fail
                // the rejection would otherwise surface as an unhandled one and
                // report a confusing second failure.
                pending.catch(() => {});

                try {
                    await waitUntil(
                        async () => (await advisoryLockWaiters(lockName)) > 0,
                        `the application backend to block on advisory lock ${lockName}`,
                    );
                    // Blocked at the lock, so the operation cannot have run.
                    expect(operationRan).toBe(false);

                    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
                    released = true;

                    await expect(pending).resolves.toBe('ran');
                    expect(operationRan).toBe(true);
                } finally {
                    if (!released) {
                        await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
                        await pending.catch(() => {});
                    }
                }
            });
        });
    });

    describe('SELECT ... FOR UPDATE (src/lib/services/reconciled-split.service.ts)', () => {
        it('lockTransactionsForUpdate blocks on a row another transaction holds', async () => {
            // lockTransactionsForUpdate is the canonical parent-row lock every
            // split-writing path takes before reading reconcile_state. Its whole
            // value is that a concurrent reconcile cannot commit between the
            // guard's read and the caller's write - which is true only if the
            // statement really takes a row lock and really holds it for the
            // caller's transaction. Drop the FOR UPDATE and the call below
            // returns immediately while this test's transaction still holds the
            // row, which is precisely the lost update the guard exists to stop.
            await withTestClient(async (holder) => {
                await holder.query('BEGIN');
                let holderOpen = true;
                try {
                    await holder.query('SELECT guid FROM transactions WHERE guid = $1 FOR UPDATE', [
                        TX_GUID,
                    ]);
                    const holderXid = await currentXid(holder);

                    let lockTaken = false;
                    const pending = prismaModule.default.$transaction(
                        async (tx) => {
                            await reconciledSplits.lockTransactionsForUpdate([TX_GUID], tx);
                            lockTaken = true;
                            return 'locked';
                        },
                        { timeout: 20_000 },
                    );
                    pending.catch(() => {});

                    await waitUntil(
                        async () => (await transactionWaiters(holderXid)) > 0,
                        `the application transaction to block on the row lock held by xid ${holderXid}`,
                    );
                    expect(lockTaken).toBe(false);

                    await holder.query('ROLLBACK');
                    holderOpen = false;

                    await expect(pending).resolves.toBe('locked');
                    expect(lockTaken).toBe(true);
                } finally {
                    if (holderOpen) await holder.query('ROLLBACK');
                }
            });
        });
    });

    describe('idempotency claims (src/lib/webhook-idempotency.ts)', () => {
        it('claimWebhookIdempotency waits for an in-flight claim and then replays', async () => {
            // The claim is enforced by the UNIQUE index, not by a SELECT: a
            // second inserter must WAIT on the first transaction and then lose.
            // A racy select-then-insert would sail past the uncommitted row and
            // report `claimed`, which for the inbound webhook routes means a
            // retry posts a second identical ledger entry.
            const key = `in-flight-${RUN_ID}`;

            await withTestClient(async (holder) => {
                await holder.query('BEGIN');
                let holderOpen = true;
                try {
                    await holder.query(
                        `INSERT INTO gnucash_web_webhook_idempotency
                             (book_guid, endpoint, idempotency_key)
                         VALUES ($1, 'transaction', $2)`,
                        [BOOK_GUID, key],
                    );
                    const holderXid = await currentXid(holder);

                    let settled = false;
                    const pending = webhookIdempotency
                        .claimWebhookIdempotency(BOOK_GUID, 'transaction', key)
                        .then((claim) => {
                            settled = true;
                            return claim;
                        });
                    pending.catch(() => {});

                    await waitUntil(
                        async () => (await transactionWaiters(holderXid)) > 0,
                        `the application claim to block on the uncommitted claim held by xid ${holderXid}`,
                    );
                    expect(settled).toBe(false);

                    await holder.query('COMMIT');
                    holderOpen = false;

                    // Lost the claim, and the original has no stored result yet,
                    // which is the 409 "original still in flight" case.
                    await expect(pending).resolves.toEqual({ status: 'replay', result: null });
                } finally {
                    if (holderOpen) await holder.query('ROLLBACK');
                }
            });
        });

        it('exactly one of eight concurrent claims for the same key wins', async () => {
            // The in-flight test above pins the two-party case; this pins the
            // invariant under real parallelism, where a lost update would show
            // up as a second `claimed` or as an unhandled unique violation.
            const key = `concurrent-${RUN_ID}`;

            const claims = await Promise.all(
                Array.from({ length: 8 }, () =>
                    webhookIdempotency.claimWebhookIdempotency(BOOK_GUID, 'transaction', key),
                ),
            );

            expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
            expect(claims.filter((claim) => claim.status === 'replay')).toHaveLength(7);

            const stored = await getTestPool().query<{ count: string }>(
                `SELECT count(*) AS count FROM gnucash_web_webhook_idempotency
                 WHERE book_guid = $1 AND endpoint = 'transaction' AND idempotency_key = $2`,
                [BOOK_GUID, key],
            );
            expect(Number(stored.rows[0].count)).toBe(1);
        });
    });
});
