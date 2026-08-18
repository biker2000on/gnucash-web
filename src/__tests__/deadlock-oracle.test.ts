/**
 * Unit tests for the deadlock oracle (src/__tests__/integration/deadlock.ts).
 *
 * The oracle is a pure function, so it is tested HERE, in the unit tier, where
 * it runs on every `vitest run` rather than only when someone has a database.
 * That placement is the point: every deadlock proof on this branch is judged
 * by `isDeadlock`, so if it silently becomes permissive again, all of those
 * proofs weaken at once and none of them fails to say so. This file is the
 * thing that fails instead.
 *
 * The error shapes below are TRANSCRIBED from real output captured against
 * PostgreSQL 16 on this branch, not invented — see the fixtures' comments.
 */
import { describe, expect, it } from 'vitest';
import { isDeadlock, sqlstateOf, describeSettled } from './integration/deadlock';

/**
 * A real Prisma deadlock, as captured from the pre-fix trading-account
 * reproduction. Prisma reports its own P2010 and parks the server's SQLSTATE
 * in the adapter cause.
 */
const PRISMA_DEADLOCK = Object.assign(new Error('Raw query failed. Code: `40P01`.'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: {
        driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
                kind: 'postgres',
                originalCode: '40P01',
                originalMessage: 'deadlock detected',
                code: '40P01',
                severity: 'ERROR',
                detail: 'Process 89 waits for ExclusiveLock on advisory lock ...; blocked by process 88.',
            },
        },
    },
});

/** The same wrapper carrying a SERIALIZATION FAILURE instead. Not a deadlock. */
const PRISMA_SERIALIZATION = Object.assign(new Error('Raw query failed. Code: `40001`.'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: {
        driverAdapterError: {
            name: 'DriverAdapterError',
            cause: { kind: 'postgres', originalCode: '40001', originalMessage: 'could not serialize access', code: '40001' },
        },
    },
});

/** node-postgres raw: `code` is the SQLSTATE itself. */
const PG_DEADLOCK = Object.assign(new Error('deadlock detected'), { name: 'error', code: '40P01' });

describe('sqlstateOf — reads the SERVER code, never the prose', () => {
    it('unwraps a Prisma adapter error to the SQLSTATE underneath', () => {
        expect(sqlstateOf(PRISMA_DEADLOCK)).toBe('40P01');
    });

    it('does NOT mistake Prisma\'s own P2010 for a SQLSTATE', () => {
        // "P2010" is five alphanumerics and matches the SQLSTATE shape. If the
        // direct-code branch ran first it would return P2010 and the 40P01
        // underneath would never be seen — every Prisma deadlock proof would
        // then read as "no deadlock" and pass vacuously.
        expect(sqlstateOf(PRISMA_DEADLOCK)).not.toBe('P2010');
    });

    it('reads a raw node-postgres error directly', () => {
        expect(sqlstateOf(PG_DEADLOCK)).toBe('40P01');
    });

    it('returns null for a Prisma code with no driver error behind it', () => {
        // P2034 alone says nothing about SQLSTATE, so there is nothing to read.
        expect(sqlstateOf(Object.assign(new Error('write conflict or deadlock'), {
            name: 'PrismaClientKnownRequestError', code: 'P2034',
        }))).toBeNull();
    });

    it('returns null for shapes it does not recognise, rather than guessing', () => {
        expect(sqlstateOf(null)).toBeNull();
        expect(sqlstateOf('40P01')).toBeNull();
        expect(sqlstateOf(new Error('deadlock detected'))).toBeNull();
    });
});

describe('isDeadlock — 40P01 and nothing else', () => {
    it('accepts a real deadlock from either driver shape', () => {
        expect(isDeadlock(PRISMA_DEADLOCK)).toBe(true);
        expect(isDeadlock(PG_DEADLOCK)).toBe(true);
    });

    it('REJECTS Prisma P2034, which also means plain write conflict', () => {
        // THE REGRESSION THIS FILE EXISTS FOR. Prisma documents P2034 as
        // "write conflict OR deadlock" — one code for two different events.
        // Accepting it lets an ordinary serialization conflict, which implies
        // nothing at all about lock ordering, satisfy a deadlock proof.
        const p2034 = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
            name: 'PrismaClientKnownRequestError', code: 'P2034',
        });
        expect(isDeadlock(p2034)).toBe(false);
    });

    it('REJECTS a serialization failure wrapped exactly like a deadlock', () => {
        expect(isDeadlock(PRISMA_SERIALIZATION)).toBe(false);
    });

    it('REJECTS an error that merely says "deadlock" in its message', () => {
        // The invariant in src/lib/account-lock-order.ts names SQLSTATE 40P01
        // in its own explanation. It is the fix WORKING, and must never be
        // counted as the database deadlocking.
        expect(isDeadlock(new Error(
            'Out-of-order account name lock: ... deadlocks against this one (SQLSTATE 40P01).',
        ))).toBe(false);
    });

    it('REJECTS a null/undefined reason', () => {
        expect(isDeadlock(null)).toBe(false);
        expect(isDeadlock(undefined)).toBe(false);
    });
});

describe('describeSettled — shows why a proof stopped firing', () => {
    it('prints the Prisma code and the resolved SQLSTATE separately', () => {
        const text = describeSettled({ status: 'rejected', reason: PRISMA_DEADLOCK });
        expect(text).toContain('code=P2010');
        expect(text).toContain('sqlstate=40P01');
    });

    it('marks an unrecognised shape as such instead of implying a SQLSTATE', () => {
        const text = describeSettled({ status: 'rejected', reason: new Error('boom') });
        expect(text).toContain('sqlstate=unrecognised');
    });

    it('says so plainly when nothing was rejected', () => {
        expect(describeSettled({ status: 'fulfilled', value: 1 })).toBe('fulfilled');
    });
});
