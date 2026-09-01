// POST /api/integrations/beez/transactions/verify
//
// Resolve a batch of external ids to what they currently point at, WITHOUT
// writing anything. This is the endpoint a beez-trackz install calls after it
// restores its own id mappings from a portable snapshot and before it turns
// sync back on: a restored mapping that no longer resolves to the transaction
// beez expects would, on the first sync pass, push beez's idea of the truth
// over folio's ledger. Proving the mapping first is what makes that impossible.
//
// POST, but not a write. The verb is POST because the request carries up to 500
// ids and a URL cannot; the handler takes no idempotency claim, stamps no
// `enter_date`, and mutates no link. `readonly` is therefore enough, and that
// is the point — a client whose only job is to check its mappings should not
// need a token that could also overwrite them.
//
// One result per requested id, in request order, so a caller can zip its own
// list against the response by index. Every id gets an answer: an id that does
// not resolve is `state: 'no-link'`, not an error that fails the other 499.
//
// ROUTE NOTE. This static segment shadows `[externalId]` for the literal id
// `verify`, so `GET .../transactions/verify` reaches this file (405) rather
// than a transaction named "verify". That one id is still fully readable —
// through this endpoint, which addresses ids in the body where nothing can
// shadow them.

import { NextResponse } from 'next/server';
import { parseBeezVerifyInput } from '@/lib/integrations/beez';
import {
    authorizeBeezRequest,
    beezErrorResponse,
    readJsonBody,
} from '@/lib/integrations/beez-route';
import { verifyBeezExternalIds } from '@/lib/services/beez-sync.service';

/**
 * @openapi
 * /api/integrations/beez/transactions/verify:
 *   post:
 *     tags: [beez-trackz integration]
 *     summary: Resolve a batch of external ids without writing anything.
 *     description: >
 *       Answers, for each of up to 500 external ids, what it currently resolves
 *       to in the token's book. Intended for proving a restored set of id
 *       mappings before sync is re-enabled: a mapping that has gone stale would
 *       otherwise be discovered by a write.
 *
 *
 *       THIS ENDPOINT WRITES NOTHING. No idempotency claim is taken, no
 *       `enter_date` is bumped, no link is touched, and no audit row is
 *       recorded. It is `readonly`-role on purpose, so a verification pass does
 *       not need a token that could also overwrite the ledger. It is POST only
 *       because 500 ids do not fit in a URL, and it may safely be repeated.
 *
 *
 *       RESULTS ARE IN REQUEST ORDER, one per requested entry — repeats
 *       included — so the response can be zipped against the request by index.
 *       An id that does not resolve is reported as `state: "no-link"`; it is
 *       not an error and does not fail the rest of the batch.
 *
 *
 *       THE THREE STATES. `linked` carries the full transaction for a field-by-
 *       field comparison. `no-link` means this book has no link for that id —
 *       it was never synced here, or the link has been removed. `orphan-link`
 *       means the link exists but its transaction was deleted in folio; that is
 *       the same tombstone `GET /changes` reports, and it is acknowledged with
 *       `DELETE /api/integrations/beez/transactions/{externalId}`, never
 *       repaired by re-POSTing.
 *
 *
 *       `reconciledOrFrozen` and `inClosedPeriod` tell the caller whether a
 *       divergence it finds could be corrected through this API at all: a
 *       reconciled ('y') or frozen ('f') split makes `PUT`/`DELETE` refuse with
 *       `409`, and a post date inside a closed period makes them refuse with
 *       `400 PERIOD_LOCKED`. Both need a human in folio.
 *
 *
 *       `unrepresentable: true` means at least one split is not an exact whole
 *       number of cents. `splits` is then empty and the amounts are
 *       UNCOMPARABLE — surface it for a human rather than reporting a mismatch.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [externalIds]
 *             properties:
 *               externalIds:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 500
 *                 items: { type: string, maxLength: 200 }
 *     responses:
 *       200:
 *         description: One result per requested id, in request order.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       externalId: { type: string }
 *                       state: { type: string, enum: [linked, no-link, orphan-link] }
 *                       transactionGuid: { type: string }
 *                       enterDate: { type: string, format: date-time, nullable: true }
 *                       postDate: { type: string, format: date, nullable: true }
 *                       description: { type: string, nullable: true }
 *                       num: { type: string, nullable: true }
 *                       reconciledOrFrozen: { type: boolean }
 *                       inClosedPeriod: { type: boolean }
 *                       unrepresentable: { type: boolean }
 *                       splits:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             accountGuid: { type: string }
 *                             amountCents: { type: integer }
 *                             memo: { type: string }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token does not grant access to its book.
 *       422:
 *         description: >
 *           The body is not a JSON object, `externalIds` is missing or not an
 *           array, it is empty, it names more than 500 ids, or one entry is not
 *           a string, is blank, or exceeds 200 characters.
 */
export async function POST(request: Request) {
    // `readonly`, deliberately: nothing below this line writes. The write verbs
    // on the sibling routes stay on `edit`.
    const authorized = await authorizeBeezRequest('readonly');
    if (authorized instanceof NextResponse) return authorized;

    const json = await readJsonBody(request);
    if (!json.ok) return json.response;

    const parsed = parseBeezVerifyInput(json.body);
    if (!parsed.ok) {
        return NextResponse.json({ error: 'validation', detail: parsed.detail }, { status: 422 });
    }

    try {
        const results = await verifyBeezExternalIds(authorized.context, parsed.externalIds);
        return NextResponse.json({ results });
    } catch (error) {
        return beezErrorResponse(error);
    }
}
