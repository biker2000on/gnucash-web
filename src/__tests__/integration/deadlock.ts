/**
 * Recognising a REAL PostgreSQL deadlock, and nothing else.
 *
 * ## Why this is not a regex over the message
 *
 * It used to be. `/40P01|deadlock detected/i` over the error text looks
 * equivalent and is actively wrong here, because the thing these tests exist
 * to check — the acquisition-order invariant in src/lib/account-lock-order.ts
 * — EXPLAINS ITSELF by naming SQLSTATE 40P01 in its own message:
 *
 *   "…a concurrent transaction taking these two keys in the canonical order
 *    deadlocks against this one (SQLSTATE 40P01)."
 *
 * So a text match reports "the database deadlocked" when what actually
 * happened is "the invariant stopped the code before the database could".
 * Those are opposite outcomes — one is the bug, the other is the fix working —
 * and a test that cannot tell them apart cannot prove either.
 *
 * This matches on the SQLSTATE the server sent, wherever the driver stashed
 * it. Three shapes are reachable from this codebase:
 *
 *   - node-postgres, raw: `err.code === '40P01'`.
 *   - Prisma + @prisma/adapter-pg: `P2010`, with the original SQLSTATE at
 *     `meta.driverAdapterError.cause.originalCode`.
 *   - Prisma's own transaction-abort code, `P2034`.
 */

/** The SQLSTATE for `deadlock detected`. */
export const DEADLOCK_SQLSTATE = '40P01';

function originalCodeOf(error: unknown): unknown {
    const meta = (error as { meta?: unknown })?.meta;
    const adapter = (meta as { driverAdapterError?: unknown })?.driverAdapterError;
    const cause = (adapter as { cause?: unknown })?.cause;
    return (cause as { originalCode?: unknown })?.originalCode
        ?? (cause as { code?: unknown })?.code;
}

/** True only for an abort the SERVER reported as 40P01 (or Prisma's P2034). */
export function isDeadlock(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    if (code === DEADLOCK_SQLSTATE || code === 'P2034') return true;
    return originalCodeOf(error) === DEADLOCK_SQLSTATE;
}

/** A one-line rendering of a settled promise, for assertion messages. */
export function describeSettled<T>(settled: PromiseSettledResult<T>): string {
    if (settled.status === 'fulfilled') return 'fulfilled';
    const reason = settled.reason as { name?: string; code?: unknown; message?: string };
    const sqlstate = originalCodeOf(reason);
    return [
        reason?.name ?? 'Error',
        `code=${String(reason?.code)}`,
        sqlstate ? `sqlstate=${String(sqlstate)}` : null,
        String(reason?.message ?? '').split('\n').filter(Boolean).slice(0, 3).join(' / '),
    ].filter(Boolean).join(' ');
}
