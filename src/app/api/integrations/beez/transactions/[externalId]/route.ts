// PUT / DELETE /api/integrations/beez/transactions/{externalId}
//
// Edit and delete a folio transaction by the id beez-trackz knows it as. The
// external id is the address, so the caller never has to remember (or be
// trusted with) a folio GUID.
//
// Two guards apply to both verbs and neither is negotiable:
//   - a split marked reconciled ('y') pins the transaction to a bank statement
//     a human agreed to, so the request is refused with 409 rather than
//     silently breaking that agreement;
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
import { deleteBeezTransaction, replaceBeezTransaction } from '@/lib/services/beez-sync.service';

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
 *         description: "`{ error: 'reconciled' }` when a split is reconciled, or an identical Idempotency-Key is still in flight."
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
 *         description: "`{ error: 'reconciled' }` when a split is reconciled, or an identical Idempotency-Key is still in flight."
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
