/**
 * The `$connect` discriminator, checked against the REAL client.
 *
 * `isTopLevelPrismaClient` (src/lib/book-lock.ts) decides whether a client is
 * inside an interactive transaction by duck-typing `$connect` — a property
 * Prisma strips from the transaction client and keeps on the top-level one.
 * That is an undocumented detail of Prisma's internals, and package.json
 * permits `^7.3.0`, so a semver-compatible update could invert it in either
 * direction WITHOUT a single type error:
 *
 *   - `$connect` stops being stripped from the tx client → every real lock
 *     throws AdvisoryLockOutsideTransactionError, and account creation,
 *     SimpleFin sync and the importers all start failing;
 *   - `$connect` disappears from the top-level client too → the refusal stops
 *     firing, `acquireNamedXactLock` goes back to taking autocommit locks that
 *     are released before the caller's re-check, and every create-if-missing
 *     race silently reopens while the code still LOOKS guarded.
 *
 * The second one is the dangerous one and it is invisible to a unit test: the
 * sibling file `book-lock-transaction-scope.test.ts` asserts the helpers'
 * behaviour against HAND-BUILT fakes whose shapes this file's author chose, so
 * it re-confirms the assumption rather than testing it. Only the real
 * `$extends`-ed singleton, inside a real `$transaction`, against a real
 * PostgreSQL backend, can tell us the assumption still holds.
 *
 * So the assertions here are deliberately not "the helper returned true". They
 * are: a SECOND connection is excluded while the lock is held, and is not
 * excluded once the transaction ends. That is the property the guard exists to
 * protect, and no shape-check can substitute for it.
 *
 * DATA: this file writes no rows. It takes advisory locks on a per-run random
 * key and releases everything it takes — see the residue assertion in afterAll.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
    AdvisoryLockOutsideTransactionError,
    acquireNamedXactLock,
    isTopLevelPrismaClient,
    tryAcquireBookLock,
    bookLockKey,
    type MaybeRawClient,
} from '@/lib/book-lock';
import { getTestPool, withTestClient } from '@/__tests__/integration/db';
import { hasTestDatabaseUrl } from '@/__tests__/integration/env';

const HAS_TEST_DATABASE = hasTestDatabaseUrl();
const describeWithDatabase = describe.skipIf(!HAS_TEST_DATABASE);

/** Per-run keys, so a concurrent run of this file cannot collide with it. */
const RUN = randomUUID().replace(/-/g, '');
const NAMED_KEY = `gnucash-web:itest:named:${RUN}`;
const BOOK_GUID = RUN.slice(0, 32);

/**
 * Can an outside connection take this key right now? Non-blocking, and it
 * releases anything it manages to take, so probing never leaves residue.
 *
 * Session-level `pg_advisory_lock` and transaction-level
 * `pg_advisory_xact_lock` share one key space, so this genuinely contends with
 * what the helpers take.
 */
async function keyIsFree(key: string): Promise<boolean> {
    return withTestClient(async (client) => {
        const { rows } = await client.query<{ got: boolean }>(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS got',
            [key],
        );
        if (rows[0].got) {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        }
        return rows[0].got;
    });
}

/** Advisory locks still held anywhere on this database for `key`. */
async function advisoryLockCount(key: string): Promise<number> {
    const { rows } = await getTestPool().query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND objid::bigint = (hashtext($1)::bigint & 4294967295)
            AND granted`,
        [key],
    );
    return Number(rows[0].n);
}

describeWithDatabase('book-lock helpers against the real extended Prisma client', () => {
    afterAll(async () => {
        if (!HAS_TEST_DATABASE) return;
        const { default: prisma } = await import('@/lib/prisma');
        await prisma.$disconnect();
    });

    it('the real singleton is classified as top-level, and the tx client is not', async () => {
        const { default: prisma } = await import('@/lib/prisma');

        // Direction B of the inversion: if this ever reads false, the refusal
        // below stops firing and every named lock silently degrades to a
        // no-op taken in autocommit.
        expect(isTopLevelPrismaClient(prisma as unknown as MaybeRawClient)).toBe(true);

        const insideVerdict = await prisma.$transaction(async (tx) => isTopLevelPrismaClient(tx as unknown as MaybeRawClient));

        // Direction A: if this ever reads true, every real lock throws.
        expect(insideVerdict).toBe(false);
    });

    it('a named lock taken inside a real transaction EXCLUDES another connection', async () => {
        const { default: prisma } = await import('@/lib/prisma');

        expect(await keyIsFree(NAMED_KEY)).toBe(true);

        const observed = await prisma.$transaction(async (tx) => {
            const locked = await acquireNamedXactLock(tx, NAMED_KEY);
            // Probed from a SEPARATE pg connection while this transaction is
            // still open. `false` here is the whole test: the lock is real and
            // it is still held.
            return { locked, freeWhileHeld: await keyIsFree(NAMED_KEY) };
        });

        expect(observed.locked).toBe(true);
        expect(observed.freeWhileHeld).toBe(false);

        // pg_advisory_xact_lock is released at COMMIT — nothing to unlock, and
        // nothing left behind.
        expect(await keyIsFree(NAMED_KEY)).toBe(true);
    });

    it('the same holds for the book try-lock, and a second holder is refused', async () => {
        const { default: prisma } = await import('@/lib/prisma');
        const key = bookLockKey(BOOK_GUID);

        const observed = await prisma.$transaction(async (tx) => {
            const locked = await tryAcquireBookLock(tx, BOOK_GUID);
            return { locked, freeWhileHeld: await keyIsFree(key) };
        });

        expect(observed.locked).toBe(true);
        expect(observed.freeWhileHeld).toBe(false);
        expect(await keyIsFree(key)).toBe(true);
    });

    it('a try-lock inside a real transaction returns FALSE when someone else holds the key', async () => {
        const { default: prisma } = await import('@/lib/prisma');
        const key = bookLockKey(BOOK_GUID);

        await withTestClient(async (holder) => {
            const { rows } = await holder.query<{ got: boolean }>(
                'SELECT pg_try_advisory_lock(hashtext($1)) AS got',
                [key],
            );
            expect(rows[0].got).toBe(true);
            try {
                const locked = await prisma.$transaction(async (tx) => tryAcquireBookLock(tx, BOOK_GUID));
                // Not "the helper returned something" — the helper correctly
                // reported that it did NOT get the lock, which is what turns
                // into a 409 instead of a corrupt interleaving.
                expect(locked).toBe(false);
            } finally {
                await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
            }
        });
    });

    it('refuses a named lock on the real top-level client, and takes nothing', async () => {
        const { default: prisma } = await import('@/lib/prisma');
        const key = `${NAMED_KEY}:toplevel`;

        await expect(
            acquireNamedXactLock(prisma as unknown as MaybeRawClient, key),
        ).rejects.toBeInstanceOf(AdvisoryLockOutsideTransactionError);

        // And it did not take-then-drop one either: the refusal happens before
        // the statement is sent. A lock that excludes nobody is worse than no
        // lock, because it reads as one at the call site.
        expect(await keyIsFree(key)).toBe(true);
        expect(await advisoryLockCount(key)).toBe(0);
    });

    it('leaves no advisory lock behind on any key it used', async () => {
        for (const key of [NAMED_KEY, `${NAMED_KEY}:toplevel`, bookLockKey(BOOK_GUID)]) {
            expect(await advisoryLockCount(key)).toBe(0);
        }
    });
});
