import { describe, it, expect, vi } from 'vitest';
import { bootstrapIfEmpty, SCHEMA_BOOTSTRAP_LOCK, type BootstrapLock } from '../db-bootstrap';

const BOOKS_PROBE = "SELECT 1 FROM information_schema.tables WHERE table_name = 'books' LIMIT 1";

const silent = { log: () => {}, warn: () => {} };

/**
 * A lock stub that records, per query, whether it was issued while the lock was
 * held. This is the whole point of the fix: the emptiness re-check must happen
 * inside the critical section, not before it.
 */
function makeLockRecorder() {
    const state = { held: false, acquisitions: 0, lockNames: [] as string[] };
    const withLock: BootstrapLock = async (lockName, operation) => {
        state.lockNames.push(lockName);
        state.acquisitions++;
        state.held = true;
        try {
            return await operation();
        } finally {
            state.held = false;
        }
    };
    return { state, withLock };
}

describe('bootstrapIfEmpty', () => {
    it('skips without taking the lock when the schema already exists', async () => {
        const { state, withLock } = makeLockRecorder();
        const query = vi.fn(async () => ({ rowCount: 1 }));

        const outcome = await bootstrapIfEmpty(query, withLock, {
            ...silent,
            readBootstrapSql: () => 'CREATE TABLE books ();',
        });

        expect(outcome).toBe('existing');
        expect(state.acquisitions).toBe(0);
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('re-checks emptiness INSIDE the advisory lock before applying bootstrap.sql', async () => {
        const { state, withLock } = makeLockRecorder();
        const heldDuring: Array<{ text: string; held: boolean }> = [];
        const query = vi.fn(async (text: string) => {
            heldDuring.push({ text, held: state.held });
            return { rowCount: 0 };
        });

        const outcome = await bootstrapIfEmpty(query, withLock, {
            ...silent,
            readBootstrapSql: () => 'CREATE TABLE books ();',
        });

        expect(outcome).toBe('bootstrapped');
        expect(state.acquisitions).toBe(1);
        expect(state.lockNames).toEqual([SCHEMA_BOOTSTRAP_LOCK]);

        // Fast-path probe outside the lock, then probe AND DDL inside it.
        expect(heldDuring).toEqual([
            { text: BOOKS_PROBE, held: false },
            { text: BOOKS_PROBE, held: true },
            { text: 'CREATE TABLE books ();', held: true },
        ]);
    });

    it('does not replay bootstrap.sql when another container won the race', async () => {
        // Models two containers on a fresh install: both pass the unlocked
        // pre-check, the other one bootstraps while we wait for the lock.
        const { state, withLock } = makeLockRecorder();
        let probes = 0;
        const query = vi.fn(async (text: string) => {
            if (text === BOOKS_PROBE) {
                probes++;
                // 1st probe (pre-lock): empty. 2nd probe (in-lock): populated.
                return { rowCount: probes === 1 ? 0 : 1 };
            }
            throw new Error(`bootstrap.sql must not run: ${text.slice(0, 40)}`);
        });

        const outcome = await bootstrapIfEmpty(query, withLock, {
            ...silent,
            readBootstrapSql: () => 'CREATE TABLE books ();',
        });

        expect(outcome).toBe('existing-after-lock');
        expect(state.acquisitions).toBe(1);
        expect(probes).toBe(2);
    });

    it('serializes two concurrent callers so only one applies the DDL', async () => {
        // One shared "database" and one shared mutex, two entrypoints racing.
        let booksExists = false;
        let ddlRuns = 0;
        let chain: Promise<unknown> = Promise.resolve();
        const withLock: BootstrapLock = <T,>(_name: string, operation: () => Promise<T>) => {
            const next = chain.then(() => operation());
            chain = next.catch(() => {});
            return next;
        };
        const query = async (text: string) => {
            if (text === BOOKS_PROBE) return { rowCount: booksExists ? 1 : 0 };
            ddlRuns++;
            // The real bootstrap is not instantaneous; yield so the loser has a
            // chance to interleave if the lock were not honoured.
            await new Promise(resolve => setTimeout(resolve, 0));
            booksExists = true;
            return { rowCount: 0 };
        };

        const opts = { ...silent, readBootstrapSql: () => 'CREATE TABLE books ();' };
        const [a, b] = await Promise.all([
            bootstrapIfEmpty(query, withLock, opts),
            bootstrapIfEmpty(query, withLock, opts),
        ]);

        expect(ddlRuns).toBe(1);
        expect([a, b].filter(o => o === 'bootstrapped')).toHaveLength(1);
        expect([a, b].filter(o => o === 'existing-after-lock')).toHaveLength(1);
    });

    it('reports a missing bootstrap.sql instead of failing the container', async () => {
        const { withLock } = makeLockRecorder();
        const query = vi.fn(async () => ({ rowCount: 0 }));
        const warn = vi.fn();

        const outcome = await bootstrapIfEmpty(query, withLock, {
            log: () => {},
            warn,
            readBootstrapSql: () => null,
            sqlPath: '/nowhere/bootstrap.sql',
        });

        expect(outcome).toBe('missing-sql');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('/nowhere/bootstrap.sql'));
    });
});
