/**
 * `transactions.enter_date` — the one monotonic clock this repository writes.
 *
 * `enter_date` does double duty, and both jobs demand the same property:
 *
 *  - it is the ORDERING KEY the beez change feed pages on
 *    (src/lib/services/beez-sync.service.ts), read by a client that only ever
 *    moves forward. A write that lands below a cursor that client already holds
 *    is never delivered — silent, permanent loss;
 *  - it is the OPTIMISTIC-LOCK TOKEN the transaction editor round-trips
 *    (src/app/api/transactions/[guid]/route.ts). A write that leaves the value
 *    inside the same JavaScript millisecond leaves a stale tab's token still
 *    matching, and that tab overwrites this write without ever seeing a
 *    conflict.
 *
 * Neither is served by `new Date()`, and each writer having its own opinion is
 * how both defects arrived. So every feed-visible writer stamps through
 * {@link stampEnterDate} / {@link stampEnterDates}, and the feed orders through
 * {@link enterDateHorizonSql}. Between them they hold ONE invariant:
 *
 *   **Every cursor the feed can issue is <= every subsequent writer's floor.**
 *
 * The two halves that make that true:
 *
 *  1. A writer stamps strictly above `max(enter_date)` over the rows the
 *     horizon admits, so it is above anything a reader could be holding.
 *  2. The feed refuses to ORDER a row the horizon excludes, so it can never
 *     issue a cursor above what a writer's watermark query would have seen.
 *     Excluded rows are not dropped — they are served by the always-emitted
 *     quarantine set, on every poll, until the clock catches up with them.
 *
 * Because `clock_timestamp()` is monotonic, a writer running at t_write >= a
 * reader's t_read has a horizon at least as far out as that reader's, so the
 * row the reader's cursor names is inside the writer's watermark range. The
 * stamp is therefore strictly greater than the cursor. That is the whole
 * argument.
 *
 * What this does NOT close, because nothing stamped before COMMIT can: two
 * writers may still COMMIT out of stamp order. See the staleness window
 * documented on `getBeezChanges`.
 */

import { Prisma } from '@prisma/client';
import type { DbClient } from '@/lib/scheduled-transactions';
import { ENTER_DATE_PG_FORMAT } from '@/lib/integrations/beez';

/**
 * How far ahead of the database clock a stored `enter_date` is still treated as
 * a real position — one the feed may order and a writer must climb above —
 * rather than as corrupt data.
 *
 * Host clock skew is measured in seconds in any deployment that runs NTP, so an
 * hour is generously past every honest case. Beyond it lies data that a broken
 * writer produced — a row dated the year 3000 — and chasing THAT would drag
 * every later `enter_date` in the book into the year 3000 with it, permanently.
 * The bound is the line between absorbing skew and inheriting corruption.
 *
 * The SAME bound governs both sides. Capping only the writer's watermark, as an
 * earlier revision did, is worse than not capping at all: the feed would issue
 * a cursor at the year 3000 while writers kept stamping at the wall clock, and
 * every later write would sort behind that cursor forever.
 */
export const ENTER_DATE_SKEW_TOLERANCE = '1 hour';

/**
 * The horizon itself: the latest `enter_date` this system will treat as a
 * position. Writers use it to bound their watermark; the feed uses it to bound
 * what it will order. One expression, so the two cannot drift apart.
 *
 * `AT TIME ZONE 'UTC'` puts `clock_timestamp()` on the same scale as the Prisma
 * writers that serialize a JS `Date` into this `timestamp(6)` column; a
 * database session on a local `TimeZone` would otherwise shift the two families
 * of writers hours apart.
 */
export const enterDateHorizonSql = Prisma.sql`(
    (clock_timestamp() AT TIME ZONE 'UTC') + ${ENTER_DATE_SKEW_TOLERANCE}::interval
)`;

/**
 * The value to stamp, for a row already aliased as `t` in the enclosing UPDATE.
 *
 * Three terms, because they are three faces of one requirement — the value
 * written must be greater than anything a reader could already be holding:
 *
 * 1. THE DATABASE CLOCK, never the app host's `new Date()`. The two are
 *    different machines, and this column is compared across writers from both.
 *    `clock_timestamp()` — not `now()`, which is frozen at transaction start
 *    and would land BEFORE the idempotency claim and row locks the caller
 *    waited on — is read at the moment of the UPDATE, the latest point a writer
 *    controls.
 *
 * 2. ABOVE THE FEED. A cursor only ever names a row that exists AND that the
 *    horizon admits, so stamping above the greatest admitted `enter_date` makes
 *    this row unmissable by any cursor issued before it. This is what closes
 *    the inverse-skew hole: if a fast writer stamped a row in the future and a
 *    poll advanced the cursor onto it, a plain `clock_timestamp()` here would
 *    land BELOW that cursor and the write would never be delivered. The maximum
 *    is read through `idx_transactions_enter_date_guid`, so it is a one-row
 *    backward index scan.
 *
 * 3. A MILLISECOND CLEAR OF THE PREVIOUS VALUE. The browser's optimistic-lock
 *    token is a JS `Date` and compares at MILLISECOND precision. A
 *    microsecond-only bump — `…123000` to `…123456` — leaves a stale token
 *    still matching. Truncating to the millisecond and adding one guarantees a
 *    strictly later millisecond. (`GREATEST` cannot undo it: any term that wins
 *    is larger still.)
 */
const stampExpressionSql = Prisma.sql`GREATEST(
    (clock_timestamp() AT TIME ZONE 'UTC'),
    date_trunc('millisecond', t.enter_date) + interval '1 millisecond',
    date_trunc('millisecond', (
        SELECT max(m.enter_date) FROM transactions m
        WHERE m.enter_date <= ${enterDateHorizonSql}
    )) + interval '1 millisecond'
)`;

/** The row named for stamping was gone by the time the UPDATE ran. */
export class EnterDateStampError extends Error {
    constructor(message = 'Transaction vanished while stamping enter_date') {
        super(message);
        this.name = 'EnterDateStampError';
    }
}

/**
 * Stamp one transaction and return the value written, rendered in
 * {@link ENTER_DATE_PG_FORMAT}.
 *
 * The rendering matters: an API response and the change-feed payload for the
 * same row must be byte-identical, and a JS `Date` round trip would truncate
 * the microseconds off one of them.
 *
 * Callers must already hold the row lock — every path here takes it as part of
 * its canonical lock order; this statement does not establish one of its own.
 */
export async function stampEnterDate(database: DbClient, txGuid: string): Promise<string> {
    const stamped = await database.$queryRaw<Array<{ enter_date: string }>>`
        UPDATE transactions t
        SET enter_date = ${stampExpressionSql}
        WHERE t.guid = ${txGuid}
        RETURNING to_char(t.enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
    `;
    if (stamped.length === 0) throw new EnterDateStampError();
    return stamped[0].enter_date;
}

/**
 * Stamp a set of transactions in one statement, for the bulk paths.
 *
 * Every row in the set lands on the SAME value — the watermark subquery reads
 * the pre-UPDATE snapshot — which is exactly what the bulk callers want and
 * what their `new Date()` predecessors did. `(enter_date, guid)` is the feed's
 * order, so a shared timestamp is still a total order.
 *
 * Returns the number of rows stamped. Unlike {@link stampEnterDate} this does
 * not refuse a short count: the bulk callers have already proven their guids
 * exist and locked them, and each has its own, more informative failure to
 * raise.
 */
export async function stampEnterDates(database: DbClient, txGuids: string[]): Promise<number> {
    if (txGuids.length === 0) return 0;
    return database.$executeRaw`
        UPDATE transactions t
        SET enter_date = ${stampExpressionSql}
        WHERE t.guid = ANY(${txGuids}::text[])
    `;
}
