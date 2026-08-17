/**
 * The transaction-scoped advisory-lock helpers must never SAY they locked when
 * they did not.
 *
 * `pg_advisory_xact_lock` is released at COMMIT/ROLLBACK. A statement sent on a
 * top-level Prisma client runs in its own implicit single-statement
 * transaction, so the lock is taken and dropped before the caller's very next
 * query — the caller's post-lock re-check races exactly as if no lock existed,
 * while the helper returns `true`. That is the failure mode this file pins:
 * a guard that silently becomes a no-op reads as "already fixed" at every call
 * site, which is how the create-if-missing race survived an audit that had
 * already "closed" it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    AdvisoryLockOutsideTransactionError,
    SiblingKeyAdoptedError,
    acquireBookLock,
    acquireNamedXactLock,
    isTopLevelPrismaClient,
    tryAcquireBookLock,
    withAdoptionRetry,
    type MaybeRawClient,
} from '../book-lock';

/** The fakes are structural; `MaybeRawClient`'s generic $queryRaw resists them. */
const asClient = (fake: unknown) => fake as MaybeRawClient;

/** Records the SQL text each lock call sent, so it can be asserted on. */
function rawSpy(sent: string[]) {
    return vi.fn(async (...args: unknown[]) => {
        sent.push(Array.isArray(args[0]) ? (args[0] as string[]).join('?') : String(args[0]));
        return [{ locked: true }];
    });
}

/**
 * Stands in for the real `prisma` singleton: raw-capable, and NOT in a
 * transaction. Shapes verified against this project's $extends-ed client.
 */
const topLevelClient = (sent: string[] = []) => ({
    $queryRaw: rawSpy(sent),
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
});

/**
 * Stands in for the client Prisma hands a `$transaction` callback. It KEEPS
 * `$transaction` on purpose: on an extended client the runtime object still
 * carries it even though the types deny it, which is why `$connect` — stripped
 * for real — is the discriminator.
 */
const transactionClient = (sent: string[] = []) => ({
    $queryRaw: rawSpy(sent),
    $transaction: vi.fn(),
});

/** An in-memory fake with no raw support at all. */
const testDouble = () => ({});

describe('transaction-scoped advisory locks', () => {
    it('tells a top-level client apart from an interactive-transaction client', () => {
        expect(isTopLevelPrismaClient(asClient(topLevelClient()))).toBe(true);
        expect(isTopLevelPrismaClient(asClient(transactionClient()))).toBe(false);
        expect(isTopLevelPrismaClient(asClient(testDouble()))).toBe(false);
    });

    it('refuses to take a named lock outside a transaction, instead of no-oping', async () => {
        const sent: string[] = [];
        const client = topLevelClient(sent);

        await expect(acquireNamedXactLock(asClient(client), 'account:parent:Cash'))
            .rejects.toBeInstanceOf(AdvisoryLockOutsideTransactionError);

        // And it did not send the lock statement: a lock that excludes nobody
        // is worse than no lock, because it looks like one.
        expect(sent).toEqual([]);
    });

    it('names the key it refused, so the failure points at the call site', async () => {
        await expect(acquireNamedXactLock(asClient(topLevelClient()), 'account:p:Cash'))
            .rejects.toThrow(/account:p:Cash/);
        await expect(acquireNamedXactLock(asClient(topLevelClient()), 'account:p:Cash'))
            .rejects.toThrow(/outside a transaction/);
    });

    it('applies the same refusal to the book locks', async () => {
        await expect(acquireBookLock(asClient(topLevelClient()), 'book-guid'))
            .rejects.toBeInstanceOf(AdvisoryLockOutsideTransactionError);
        await expect(tryAcquireBookLock(asClient(topLevelClient()), 'book-guid'))
            .rejects.toBeInstanceOf(AdvisoryLockOutsideTransactionError);
    });

    it('locks normally on an interactive-transaction client', async () => {
        const sent: string[] = [];

        await expect(acquireNamedXactLock(asClient(transactionClient(sent)), 'account:parent:Cash'))
            .resolves.toBe(true);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('pg_advisory_xact_lock');
    });

    it('still degrades quietly for raw-less test doubles — but reports false', async () => {
        // These cannot exist in production (a real Prisma client always has
        // $queryRaw), and they answer honestly rather than claiming a lock, so
        // callers skip the re-check that would prove nothing.
        await expect(acquireNamedXactLock(asClient(testDouble()), 'account:parent:Cash')).resolves.toBe(false);
        await expect(acquireBookLock(asClient(testDouble()), 'book-guid')).resolves.toBeUndefined();
    });
});

/**
 * The escape hatch that keeps the level-2-before-level-3 ordering real where a
 * find-or-create adopts a row it would otherwise have to UPDATE from under a
 * claimed sibling key. See `SiblingKeyAdoptedError` and `accountNameLockKey`.
 */
describe('withAdoptionRetry', () => {
    it('returns the first attempt`s value when nothing was adopted', async () => {
        const attempt = vi.fn(async () => 'done');
        await expect(withAdoptionRetry(attempt)).resolves.toBe('done');
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('re-runs the whole attempt after an adoption, so the retry starts a NEW transaction', async () => {
        // The advisory locks a failed attempt took are only released when its
        // transaction rolls back, which is why the unit of retry has to be the
        // attempt itself rather than the statement that lost.
        const attempt = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new SiblingKeyAdoptedError('Inventory'))
            .mockResolvedValueOnce('reconciled');
        await expect(withAdoptionRetry(attempt)).resolves.toBe('reconciled');
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('gives up loudly rather than spinning when the budget is exhausted', async () => {
        const attempt = vi.fn(async () => {
            throw new SiblingKeyAdoptedError('Accounts Receivable');
        });
        await expect(withAdoptionRetry(attempt, 3)).rejects.toBeInstanceOf(SiblingKeyAdoptedError);
        expect(attempt).toHaveBeenCalledTimes(3);
    });

    it('never retries any other error', async () => {
        const attempt = vi.fn(async () => {
            throw new Error('constraint violated');
        });
        await expect(withAdoptionRetry(attempt)).rejects.toThrow('constraint violated');
        expect(attempt).toHaveBeenCalledTimes(1);
    });
});
