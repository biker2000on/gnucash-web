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
 *       that stays stable while rows are still being written. Store
 *       `nextCursor` and send it back as `since` on the next poll; an empty
 *       page returns the cursor you sent, so polling never rewinds.
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
 *         description: "`limit` is malformed or out of range, or `since` is not a cursor this endpoint issued."
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
