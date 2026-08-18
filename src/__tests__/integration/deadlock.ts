/**
 * Recognising a REAL PostgreSQL deadlock, and NOTHING else.
 *
 * Every deadlock proof on this branch is judged by this one predicate, so its
 * precision is not a detail of the tests — it is the strength of all of them.
 * A permissive oracle does not fail loudly; it silently downgrades every proof
 * that runs through it into "something went wrong around here".
 *
 * ## Two rejected implementations, and why each was wrong
 *
 * 1. A REGEX OVER THE MESSAGE — `/40P01|deadlock detected/i`. Wrong because
 *    the invariant these tests exist to check (src/lib/account-lock-order.ts)
 *    EXPLAINS ITSELF by naming SQLSTATE 40P01 in its own message:
 *
 *      "…a concurrent transaction taking these two keys in the canonical
 *       order deadlocks against this one (SQLSTATE 40P01)."
 *
 *    So the text match reported "the database deadlocked" when what actually
 *    happened was "the invariant stopped the code BEFORE the database could".
 *    Those are opposite outcomes — one is the bug, the other is the fix
 *    working — and an oracle that cannot tell them apart cannot prove either.
 *
 * 2. ACCEPTING PRISMA'S `P2034`. This replaced (1) and is wrong for the same
 *    reason one level down. Prisma documents P2034 as
 *
 *      "Transaction failed due to a WRITE CONFLICT OR A DEADLOCK."
 *
 *    — one code for two different events. An ordinary serialization conflict
 *    (40001), a retryable write conflict with no cycle involved and no lock
 *    ordering implication whatsoever, arrives as P2034 exactly as a real
 *    deadlock does. Accepting it means a proof can go green on a conflict that
 *    proves nothing about lock order. Same defect class as (1), re-entering
 *    through an error code instead of message text.
 *
 * ## What this does instead
 *
 * It reads the SQLSTATE the SERVER sent, out of the driver's structured error,
 * and compares it to 40P01. Nothing is inferred from prose, and no code that
 * merely CAN mean deadlock is accepted. Two shapes are reachable here:
 *
 *   - node-postgres raw: `DatabaseError.code` IS the SQLSTATE.
 *   - Prisma + @prisma/adapter-pg: `P2010`, carrying the untranslated driver
 *     error at `meta.driverAdapterError.cause`, whose `originalCode`/`code`
 *     are the SQLSTATE.
 *
 * A driver shape neither branch recognises returns FALSE. That direction is
 * deliberate: an unrecognised error failing a "no deadlock happened" assertion
 * would be a false alarm, while an unrecognised error failing a "a deadlock
 * DID happen" assertion is exactly the loud failure that sends someone to look
 * — the proof cannot quietly pass on an error nobody classified.
 */

/** Five alphanumerics — the shape of every PostgreSQL SQLSTATE. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/** The SQLSTATE PostgreSQL reports for `deadlock detected`. */
export const DEADLOCK_SQLSTATE = '40P01';

/**
 * The SQLSTATE from the driver's structured error, or null when no branch
 * recognises the shape.
 *
 * Only fields the driver fills in from the server's error response are
 * consulted. `message` is never parsed — see the header.
 */
export function sqlstateOf(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;

    // Prisma via @prisma/adapter-pg FIRST, because its own `code` would
    // otherwise be mistaken for a SQLSTATE: "P2010" is five alphanumerics and
    // matches the SQLSTATE shape exactly. Reading the wrapper's code and
    // stopping there would return "P2010" for every wrapped driver error and
    // never reach the 40P01 underneath — every Prisma-side deadlock proof
    // would then read as "not a deadlock". Order matters; do not swap these.
    const meta = (error as { meta?: unknown }).meta;
    const adapter = (meta as { driverAdapterError?: unknown })?.driverAdapterError;
    const cause = (adapter as { cause?: unknown })?.cause;
    for (const field of ['originalCode', 'code'] as const) {
        const value = (cause as Record<string, unknown> | undefined)?.[field];
        if (typeof value === 'string' && SQLSTATE_SHAPE.test(value)) return value;
    }

    // node-postgres DatabaseError: `code` IS the SQLSTATE verbatim. Skipped
    // for a Prisma error, whose `code` belongs to Prisma's own P-namespace and
    // is not a SQLSTATE at all — that is precisely the P2034 confusion this
    // module exists to end.
    if (typeof (error as { name?: unknown }).name === 'string'
        && (error as { name: string }).name.startsWith('PrismaClient')) {
        return null;
    }
    const direct = (error as { code?: unknown }).code;
    if (typeof direct === 'string' && SQLSTATE_SHAPE.test(direct)) return direct;

    return null;
}

/**
 * True ONLY for an abort the server reported as SQLSTATE 40P01.
 *
 * Deliberately NOT true for Prisma's P2034, which also covers plain write
 * conflicts, nor for anything matched out of an error message. See the header.
 */
export function isDeadlock(error: unknown): boolean {
    return sqlstateOf(error) === DEADLOCK_SQLSTATE;
}

/**
 * A one-line rendering of a settled promise, for assertion messages.
 *
 * Prints the Prisma code AND the resolved SQLSTATE separately, so a proof that
 * stops firing shows WHY at a glance — a P2034 with no 40P01 behind it is a
 * write conflict wearing a deadlock's clothes, and this is where that becomes
 * visible instead of being silently counted as a deadlock.
 */
export function describeSettled<T>(settled: PromiseSettledResult<T>): string {
    if (settled.status === 'fulfilled') return 'fulfilled';
    const reason = settled.reason as { name?: string; code?: unknown; message?: string };
    const sqlstate = sqlstateOf(reason);
    return [
        reason?.name ?? 'Error',
        `code=${String(reason?.code)}`,
        `sqlstate=${sqlstate ?? 'unrecognised'}`,
        String(reason?.message ?? '').split('\n').filter(Boolean).slice(0, 3).join(' / '),
    ].filter(Boolean).join(' ');
}
