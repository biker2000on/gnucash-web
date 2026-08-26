// GET /api/integrations/beez/changes
//
// The pull side of the sync: everything entered into the book since the cursor
// the client last stored, oldest first, so beez can mirror edits a human made
// directly in folio.
//
// The feed reports what it can prove. A transaction whose splits are not all
// exactly expressible in integer cents is delivered with `unrepresentable:
// true` and NO splits rather than a rounded set that would not balance on the
// beez side — rounding here would invent money. Deleted transactions surface as
// `{ externalId, deleted: true }` tombstones that repeat until the client
// acknowledges them with DELETE.
//
// The cursor is a `(enter_date, guid)` watermark carried at the database's full
// microsecond precision — never through a millisecond JS Date, which would make
// a row stored at `.123456` re-emit on every poll. Two kinds of row have no
// place in that order: one with a NULL `enter_date`, and one stamped further
// ahead of the database clock than any writer's watermark will chase
// (src/lib/enter-date.ts). Both go to the QUARANTINE set — flagged
// `quarantined: true`, carried by a SECOND watermark in the cursor, paged on
// its own budget and reset to the start whenever that set drains, which is what
// keeps a row that appears later reachable.
//
// The ordered stream is a SWEEP, not a strict watermark. Most writers in this
// application stamp `enter_date` from a bare clock, and a cursor may sit up to
// an hour ahead of that clock, so such a write can land underneath a cursor a
// client already holds. Rather than trust every writer, the feed re-reads: when
// a sweep drains, the next one restarts two hours below the high watermark and
// re-emits that band. The guarantee is the difference between the two bounds —
// a write is delivered if its timestamp is no more than an hour behind true
// time when it is written, which covers every writer in the codebase.
//
// Apply items idempotently by `transactionGuid` / `externalId`: this endpoint
// guarantees no loss, and bounded repetition is how it pays for that. A
// re-emitted row carries a byte-identical `enterDate`, so
// `transactionGuid + enterDate` is a usable dedup key.

import { NextResponse } from 'next/server';
import { parseChangesLimit } from '@/lib/integrations/beez';
import { authorizeBeezRequest, beezErrorResponse } from '@/lib/integrations/beez-route';
import { getBeezChanges } from '@/lib/services/beez-sync.service';

/**
 * @openapi
 * /api/integrations/beez/changes:
 *   get:
 *     tags: [beez-trackz integration]
 *     summary: Transactions entered since a cursor, plus deletion tombstones.
 *     description: >
 *       Pages transactions in `(enter_date, guid)` order — the only total order
 *       that stays stable while rows are still being written — at the database's
 *       full microsecond precision. Store `nextCursor` and send it back as
 *       `since` on the next poll; an empty page returns the cursor you sent, so
 *       polling never rewinds.
 *
 *
 *       DUPLICATES ARE EXPECTED; LOSS IS NOT. Apply every item idempotently,
 *       keyed by `transactionGuid` (or `externalId`); `enterDate` repeats byte
 *       for byte across re-emissions, so `transactionGuid + enterDate` is a
 *       usable dedup key.
 *
 *
 *       Duplicates come from three places, all deliberate. First, the ordered
 *       stream is a SWEEP: while `hasMore` is true it moves strictly forward,
 *       but once it drains, the next sweep restarts TWO HOURS below the high
 *       watermark and re-sends that band. That is what makes the feed lossless
 *       without requiring every writer in the server to cooperate — a write is
 *       guaranteed delivered as long as its timestamp is no more than an hour
 *       behind true time at the moment it is written, which is true of every
 *       writer on a host running NTP. The cost is that a caught-up client
 *       re-reads the last two hours of activity on each new sweep. Second,
 *       items flagged `quarantined: true` have no position in the time order at
 *       all — either `enterDate` is null (GnuCash allows it) or it is stamped
 *       more than an hour ahead of the server clock, which is corruption rather
 *       than skew and cannot be allowed to move the cursor. They are paged
 *       separately by guid and re-sent from the start of that set each time it
 *       drains. Third, `deleted: true` tombstones repeat until acknowledged.
 *
 *
 *       `hasMore` covers BOTH streams, so keep polling while it is true. It
 *       goes false at the end of a sweep, which is exactly when the next sweep
 *       will rewind — that is normal, not a signal to stop syncing.
 *
 *
 *       An item with `unrepresentable: true` has at least one split whose
 *       stored value is not an exact whole number of cents (GnuCash stores
 *       rationals, and the denominator is not always a power of ten). Its
 *       `splits` array is empty and the item should be surfaced as a conflict
 *       for a human, never rounded.
 *
 *
 *       An item with `deleted: true` carries only `externalId`. It repeats on
 *       every response until the client calls
 *       `DELETE /api/integrations/beez/transactions/{externalId}`, which is how
 *       the acknowledgement is recorded.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string }
 *         description: An opaque cursor from a previous response. Omit for the start of the feed.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, minimum: 1, maximum: 500 }
 *     responses:
 *       200:
 *         description: A page of changes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       transactionGuid: { type: string }
 *                       externalId: { type: string, nullable: true }
 *                       postDate: { type: string, format: date, nullable: true }
 *                       enterDate: { type: string, format: date-time, nullable: true }
 *                       description: { type: string, nullable: true }
 *                       deleted: { type: boolean }
 *                       unrepresentable: { type: boolean }
 *                       quarantined: { type: boolean }
 *                       splits:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             accountGuid: { type: string }
 *                             amountCents: { type: integer }
 *                             memo: { type: string }
 *                             reconcileState: { type: string, example: n }
 *                 nextCursor: { type: string, nullable: true }
 *                 hasMore: { type: boolean }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token does not grant access to its book.
 *       422:
 *         description: >
 *           `limit` is malformed or out of range, or `since` is not a cursor
 *           this endpoint issued — corrupted in transit, or naming an
 *           impossible instant. Never a silent restart from the beginning of the
 *           ledger: store `nextCursor` verbatim and send it back unchanged.
 */
export async function GET(request: Request) {
    const authorized = await authorizeBeezRequest('readonly');
    if (authorized instanceof NextResponse) return authorized;

    const { searchParams } = new URL(request.url);
    const limit = parseChangesLimit(searchParams.get('limit'));
    if (!limit.ok) {
        return NextResponse.json({ error: 'validation', detail: limit.detail }, { status: 422 });
    }

    try {
        const changes = await getBeezChanges(authorized.context, {
            since: searchParams.get('since'),
            limit: limit.limit,
        });
        return NextResponse.json(changes);
    } catch (error) {
        return beezErrorResponse(error);
    }
}
