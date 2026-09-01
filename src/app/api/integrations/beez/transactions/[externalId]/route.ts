// GET / PUT / DELETE /api/integrations/beez/transactions/{externalId}
//
// Read, edit, and delete a folio transaction by the id beez-trackz knows it as.
// The external id is the address, so the caller never has to remember (or be
// trusted with) a folio GUID.
//
// GET is the odd one out and deliberately so. It is the only verb here that
// needs no more than a `readonly` token, because it writes nothing at all — no
// idempotency claim, no `enter_date` bump, no link mutation. It exists so a
// client that has just restored its own id mappings can PROVE each one still
// resolves to the transaction it expects before it re-enables a sync that would
// otherwise push its idea of the truth over folio's. It reports two flags the
// write verbs enforce as refusals — `reconciledOrFrozen` and `inClosedPeriod` —
// so a caller learns up front that a divergence it found cannot be corrected
// remotely, and answers an orphaned link with 200 and `state: 'orphan-link'`
// rather than 404, because "the link is stale" and "there is no link" call for
// different repairs.
//
// Two guards apply to both WRITE verbs and neither is negotiable (GET reports
// them as flags instead, which is the whole reason it reports them):
//   - a split marked reconciled ('y') or frozen ('f') pins the transaction to a
//     bank statement a human agreed to, so the request is refused with 409
//     rather than silently breaking that agreement. Both states are the
//     codebase-wide rule in src/lib/services/reconciled-split.service.ts;
//   - a closed period is closed, so a post date on or before the book's lock
//     date is refused the same way it is for a browser.

import { NextResponse } from 'next/server';
import { parseBeezTransactionInput } from '@/lib/integrations/beez';
import {
    authorizeBeezRequest,
    beezErrorResponse,
    parseExternalIdParam,
    readBeezIdempotencyKey,
    readJsonBody,
} from '@/lib/integrations/beez-route';
import {
    deleteBeezTransaction,
    getBeezTransactionByExternalId,
    replaceBeezTransaction,
} from '@/lib/services/beez-sync.service';

/**
 * @openapi
 * /api/integrations/beez/transactions/{externalId}:
 *   get:
 *     tags: [beez-trackz integration]
 *     summary: Read the folio transaction linked to an external id.
 *     description: >
 *       Read-only, and read-only in the strong sense: the call takes no
 *       idempotency claim, bumps no `enter_date`, and touches neither the link
 *       nor the ledger. `readonly` is therefore enough — a client verifying a
 *       restored mapping should not need a token that could also overwrite it.
 *
 *
 *       THREE OUTCOMES, and the difference between them is the point. `state:
 *       "linked"` returns the whole transaction so the caller can compare it
 *       field by field. `state: "orphan-link"` is `200`, not `404`: the link
 *       survived but the transaction it names was deleted in folio, which is
 *       the same tombstone `GET /changes` reports and is repaired by
 *       acknowledging it with `DELETE`, never by re-POSTing. A `404` means
 *       there is no link at all — the id was never synced into this book, or
 *       its link has already been removed.
 *
 *
 *       `reconciledOrFrozen` and `inClosedPeriod` say whether a divergence
 *       found here could be corrected through this API at all. A transaction
 *       with a reconciled ('y') or frozen ('f') split is refused by `PUT` and
 *       `DELETE` with `409`; one whose post date is inside a closed period is
 *       refused with `400 PERIOD_LOCKED`. Either way the fix needs a human in
 *       folio, so a client should surface it rather than queue a repair that
 *       will bounce.
 *
 *
 *       `unrepresentable: true` means at least one split is not a whole number
 *       of cents (GnuCash stores rationals). `splits` is then empty, and the
 *       amounts must be treated as UNCOMPARABLE — never as a mismatch, and
 *       never rounded.
 *
 *
 *       An external id of exactly `verify` is not reachable here, because
 *       `/transactions/verify` is the batch endpoint. Look that one id up
 *       through the batch endpoint, which has no such reservation.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: externalId
 *         required: true
 *         schema: { type: string, maxLength: 200 }
 *     responses:
 *       200:
 *         description: The link exists. Either the transaction, or an orphan-link marker.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 externalId: { type: string }
 *                 state: { type: string, enum: [linked, orphan-link] }
 *                 transactionGuid: { type: string }
 *                 enterDate: { type: string, format: date-time, nullable: true }
 *                 postDate: { type: string, format: date, nullable: true }
 *                 description: { type: string, nullable: true }
 *                 num: { type: string, nullable: true }
 *                 reconciledOrFrozen: { type: boolean }
 *                 inClosedPeriod: { type: boolean }
 *                 unrepresentable: { type: boolean }
 *                 splits:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       accountGuid: { type: string }
 *                       amountCents: { type: integer }
 *                       memo: { type: string }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token does not grant access to its book.
 *       404:
 *         description: "`{ error: 'unknown_external_id' }` — no link exists for this id in this book."
 *       422:
 *         description: The external id is empty or longer than 200 characters.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ externalId: string }> },
) {
    // `readonly`, deliberately: this handler cannot write, so requiring `edit`
    // would force a verification client to hold a token that can overwrite the
    // ledger it is only trying to read. The write verbs below stay on `edit`.
    const authorized = await authorizeBeezRequest('readonly');
    if (authorized instanceof NextResponse) return authorized;

    const external = parseExternalIdParam((await params).externalId);
    if (!external.ok) return external.response;

    try {
        const item = await getBeezTransactionByExternalId(authorized.context, external.externalId);
        return NextResponse.json(item);
    } catch (error) {
        return beezErrorResponse(error);
    }
}

/**
 * @openapi
 * /api/integrations/beez/transactions/{externalId}:
 *   put:
 *     tags: [beez-trackz integration]
 *     summary: Replace the folio transaction linked to an external id.
 *     description: >
 *       Replaces the description, post date, num, and the complete set of
 *       splits. There is no optimistic-lock token to send: the row is locked
 *       server-side for the duration of the write and its `enter_date` is
 *       bumped, which invalidates any folio browser tab holding a stale copy.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: externalId
 *         required: true
 *         schema: { type: string, maxLength: 200 }
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 200 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [postDate, description, splits]
 *             properties:
 *               postDate: { type: string, format: date }
 *               description: { type: string }
 *               num: { type: string }
 *               splits:
 *                 type: array
 *                 minItems: 2
 *                 items:
 *                   type: object
 *                   required: [accountGuid, amountCents]
 *                   properties:
 *                     accountGuid: { type: string }
 *                     amountCents: { type: integer }
 *                     memo: { type: string }
 *     responses:
 *       200:
 *         description: Replaced.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transactionGuid: { type: string }
 *                 enterDate: { type: string, format: date-time }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token grants readonly access; writes need the edit role.
 *       404:
 *         description: No transaction is linked to this external id, or an account was not found in this book.
 *       409:
 *         description: "`{ error: 'reconciled' }` when a split is reconciled ('y') or frozen ('f'), or an identical Idempotency-Key is still in flight."
 *       422:
 *         description: Validation failed, the splits do not sum to zero, or an account is a placeholder or foreign-currency.
 */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ externalId: string }> },
) {
    const authorized = await authorizeBeezRequest('edit');
    if (authorized instanceof NextResponse) return authorized;

    const external = parseExternalIdParam((await params).externalId);
    if (!external.ok) return external.response;

    const idempotency = readBeezIdempotencyKey(request);
    if (!idempotency.ok) return idempotency.response;

    const json = await readJsonBody(request);
    if (!json.ok) return json.response;

    const parsed = parseBeezTransactionInput(json.body, { requireExternalId: false });
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error, detail: parsed.detail }, { status: 422 });
    }

    try {
        const result = await replaceBeezTransaction(
            authorized.context, authorized.actor, external.externalId, parsed.data, idempotency.key,
        );
        return NextResponse.json(result);
    } catch (error) {
        return beezErrorResponse(error);
    }
}

/**
 * @openapi
 * /api/integrations/beez/transactions/{externalId}:
 *   delete:
 *     tags: [beez-trackz integration]
 *     summary: Delete the folio transaction linked to an external id.
 *     description: >
 *       Deletes the transaction, its splits, and the link. When the link exists
 *       but the transaction is already gone — the tombstone case the change
 *       feed reports — only the stale link is removed, and the response carries
 *       `orphanLinkRemoved: true`. That is how a client acknowledges a deletion
 *       made in folio.
 *
 *
 *       Send an `Idempotency-Key` if you retry on timeout. The key is claimed
 *       before the link is looked up, so a retry of a call that already
 *       succeeded replays the stored `{ deleted: true }` instead of 404-ing on
 *       the link its own first attempt removed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: externalId
 *         required: true
 *         schema: { type: string, maxLength: 200 }
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 200 }
 *     responses:
 *       200:
 *         description: Deleted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean, example: true }
 *                 orphanLinkRemoved: { type: boolean }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token grants readonly access; writes need the edit role.
 *       404:
 *         description: No transaction is linked to this external id.
 *       409:
 *         description: "`{ error: 'reconciled' }` when a split is reconciled ('y') or frozen ('f'), or an identical Idempotency-Key is still in flight."
 */
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ externalId: string }> },
) {
    const authorized = await authorizeBeezRequest('edit');
    if (authorized instanceof NextResponse) return authorized;

    const external = parseExternalIdParam((await params).externalId);
    if (!external.ok) return external.response;

    const idempotency = readBeezIdempotencyKey(request);
    if (!idempotency.ok) return idempotency.response;

    try {
        const result = await deleteBeezTransaction(
            authorized.context, authorized.actor, external.externalId, idempotency.key,
        );
        return NextResponse.json(result);
    } catch (error) {
        return beezErrorResponse(error);
    }
}
