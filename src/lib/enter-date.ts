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
 * how both defects arrived. Two mechanisms answer that, and they are deliberately
 * layered because neither is sufficient alone.
 *
 * ## 1. The stamper, for the writers that can use it
 *
 * The beez mutations, `PUT /api/transactions/[guid]`, the bulk edit, the
 * reconcile/lot split routes, and the audit undo restore stamp through
 * {@link stampEnterDate} / {@link stampEnterDates}; the feed orders through
 * {@link enterDateHorizonSql}. Between them they hold ONE invariant, FOR THOSE
 * WRITERS:
 *
 *   **Every cursor the feed can issue is <= every subsequent stamper write.**
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
 * argument — for a row written through the stamper.
 *
 * ## 2. The overlap, for every other writer
 *
 * Most feed-visible writes in this repository do NOT go through the stamper and
 * are not going to: SimpleFin sync, the invoice engine, the Stripe webhook, the
 * inbound webhook, the CSV/QIF/QBO/settlement importers, `reconcile.ts`,
 * `statement-reconcile-data.ts`, `lot-assignment.ts`, `lot-scrub.ts`,
 * `transaction.service.ts`, and so on all write a bare `NOW()` / `new Date()`.
 * Converting them one by one is a list nobody can keep complete, and the next
 * writer somebody adds would silently reopen the hole.
 *
 * So the READER absorbs them instead, with {@link BEEZ_FEED_OVERLAP}: a drained
 * sweep restarts two hours below its own high watermark, which covers every
 * writer whose clock is within an hour of true time. See that constant for the
 * derivation, and `getBeezChanges` for the mechanism.
 *
 * What the overlap does NOT cover is a write stamped far in the PAST — a
 * restore replaying a historical timestamp. There is no bounded window that
 * catches an arbitrarily old value, so those writers, and only those, are
 * converted to the stamper.
 *
 * What neither closes, because nothing stamped before COMMIT can: two writers
 * may still COMMIT out of stamp order. The overlap shrinks that window from
 * "one write's duration" to "one write's duration, re-checked for two hours",
 * which is the practical answer. See `getBeezChanges`.
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
 * How far BELOW its own watermark the beez change feed re-scans when it starts
 * a fresh sweep — the bounded-overlap half of the no-loss argument.
 *
 * WHY AN OVERLAP EXISTS AT ALL. `stampEnterDate` is the ordering-safe way to
 * write this column, but it is not the ONLY writer: dozens of paths across this
 * repository (the SimpleFin sync, the invoice engine, the Stripe webhook, the
 * CSV/QIF/QBO importers, the reconcile and lot-scrub engines, the inbound
 * webhook, …) stamp a bare `NOW()` / `new Date()`, and converting every one of
 * them is neither reviewable nor enforceable against the next one somebody
 * writes. Such a row can land BELOW a cursor the feed already issued — the
 * cursor may sit up to {@link ENTER_DATE_SKEW_TOLERANCE} ahead of the wall
 * clock — and a strictly-forward watermark would skip it permanently.
 *
 * So the feed does not rely on every writer being disciplined. When its ordered
 * sweep drains, it restarts the next sweep this far below its own high
 * watermark and re-emits whatever it finds. The wire contract already requires
 * idempotent apply by `transactionGuid`, so a re-emitted row costs the client
 * nothing.
 *
 * WHY TWO HOURS. The guarantee it buys is exactly `overlap - horizon`:
 *
 *   A write is delivered if its stamp is no more than (overlap - horizon)
 *   behind true wall-clock time at the moment it is written.
 *
 * because the highest cursor the feed can issue is at most `horizon` ahead of
 * the clock, so the floor of the next sweep is at most `horizon - overlap`
 * ahead of it — i.e. one hour BEHIND it at these values. Every bare-clock
 * writer in the repository is within a hour of true time on any host running
 * NTP, so all of them are covered without being touched. Two hours is also
 * strictly greater than the horizon, which is what keeps the margin positive at
 * all; a value at or below it would guarantee nothing.
 *
 * The cost is proportional: a client that has caught up re-reads the last two
 * hours of writes on its next sweep. That is bounded by the book's write rate,
 * it is paged like any other sweep, and it is the same bargain the quarantine
 * set and the deletion tombstones already make.
 *
 * What the overlap CANNOT cover is a writer that stamps a time far in the past —
 * a restore that replays a historical `enter_date`. Those are converted to
 * {@link stampEnterDate} instead; see src/lib/services/audit.service.ts.
 */
export const BEEZ_FEED_OVERLAP = '2 hours';

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
