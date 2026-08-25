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
// a row stored at `.123456` re-emit on every poll. Rows whose `enter_date` is
// NULL have no place in that order, so the cursor carries a SECOND watermark
// for them: a guid position in the NULL set, paged on its own budget and reset
// to the start whenever that set drains, which is what keeps a NULL row that
// appears later reachable. Apply items idempotently by `transactionGuid` /
// `externalId`: this endpoint guarantees no loss, and bounded repetition is how
// it pays for that.

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
 *       DUPLICATES ARE POSSIBLE; LOSS IS NOT. Apply every item idempotently,
 *       keyed by `transactionGuid` (or `externalId`). Items with
 *       `enterDate: null` (GnuCash allows a NULL enter_date) have no position in
 *       the time order, so they are paged separately by guid and that set is
 *       re-sent from its start each time it drains; `deleted: true` tombstones
 *       repeat until acknowledged. `hasMore` covers BOTH streams, so keep
 *       polling while it is true. Separately, `enter_date` is read from
 *       the database clock just before the write rather than at commit, so two
 *       concurrent writers can commit slightly out of timestamp order; a
 *       transaction that commits
 *       behind an already-advanced cursor can be missed by a client that only
 *       ever moves forward. The window is bounded by one write's duration. If
 *       your book cannot tolerate it, re-poll periodically from a cursor a few
 *       minutes old — repeated items are safe, which is the whole point of the
 *       idempotent-apply rule above.
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
