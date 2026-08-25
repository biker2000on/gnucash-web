// POST /api/integrations/beez/transactions
//
// Create the folio ledger entry for one beez-trackz record. The caller names
// the record with `externalId`, and that name — not the request, and not the
// Idempotency-Key — is what makes the operation safe to repeat forever: the
// second POST for an id that is already linked returns the original transaction
// with `alreadyLinked: true` and writes nothing.
//
// Amounts are integer cents and must sum to exactly 0. Nothing is parsed from a
// decimal string and nothing is rounded; see the cents discipline at the top of
// src/lib/integrations/beez.ts for why that is a hard rule and not a
// simplification.

import { NextResponse } from 'next/server';
import { parseBeezTransactionInput } from '@/lib/integrations/beez';
import {
    authorizeBeezRequest,
    beezErrorResponse,
    readBeezIdempotencyKey,
    readJsonBody,
} from '@/lib/integrations/beez-route';
import { createBeezTransaction } from '@/lib/services/beez-sync.service';

/**
 * @openapi
 * /api/integrations/beez/transactions:
 *   post:
 *     tags: [beez-trackz integration]
 *     summary: Create the folio transaction for a beez-trackz record.
 *     description: >
 *       Writes a balanced transaction into the token's book and links it to
 *       `externalId`. Repeating the call for an id that is already linked
 *       returns 200 with `alreadyLinked: true` and changes nothing. Every
 *       account must be in the token's book, must not be a placeholder, and
 *       must be denominated in the book's base currency.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 200 }
 *         description: >
 *           Optional. Makes an interrupted retry return the original response
 *           instead of attempting a second write.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [externalId, postDate, description, splits]
 *             properties:
 *               externalId: { type: string, maxLength: 200 }
 *               postDate: { type: string, format: date, example: "2026-08-25" }
 *               description: { type: string }
 *               num: { type: string }
 *               splits:
 *                 type: array
 *                 minItems: 2
 *                 items:
 *                   type: object
 *                   required: [accountGuid, amountCents]
 *                   properties:
 *                     accountGuid: { type: string, description: 32-character hex GUID }
 *                     amountCents: { type: integer, description: Signed cents; all splits must sum to 0 }
 *                     memo: { type: string }
 *     responses:
 *       201:
 *         description: Created.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transactionGuid: { type: string }
 *                 enterDate: { type: string, format: date-time }
 *                 externalId: { type: string }
 *       200:
 *         description: This external id was already linked; nothing was written.
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token grants readonly access; writes need the edit role.
 *       404:
 *         description: An account was not found in this book.
 *       409:
 *         description: >
 *           An identical Idempotency-Key is still in flight, or the external id
 *           is linked to a transaction that was deleted in folio and the
 *           tombstone has not been acknowledged with DELETE.
 *       422:
 *         description: Validation failed, the splits do not sum to zero, or an account is a placeholder or foreign-currency.
 */
export async function POST(request: Request) {
    const authorized = await authorizeBeezRequest('edit');
    if (authorized instanceof NextResponse) return authorized;

    const idempotency = readBeezIdempotencyKey(request);
    if (!idempotency.ok) return idempotency.response;

    const json = await readJsonBody(request);
    if (!json.ok) return json.response;

    const parsed = parseBeezTransactionInput(json.body, { requireExternalId: true });
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error, detail: parsed.detail }, { status: 422 });
    }

    try {
        const { result, status } = await createBeezTransaction(
            authorized.context, authorized.actor, parsed.data, idempotency.key,
        );
        return NextResponse.json(result, { status });
    } catch (error) {
        return beezErrorResponse(error);
    }
}
