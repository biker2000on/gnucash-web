// GET /api/integrations/beez/status
//
// The handshake a beez-trackz install performs before it syncs anything: it
// proves the token works and names the exact book and currency it is about to
// write into. Cheap enough to poll, and the only endpoint that is safe to hit
// while a user is still deciding whether a token is the right one.

import { NextResponse } from 'next/server';
import { authorizeBeezRequest, beezErrorResponse } from '@/lib/integrations/beez-route';

/**
 * @openapi
 * /api/integrations/beez/status:
 *   get:
 *     tags: [beez-trackz integration]
 *     summary: Confirm the token and identify its book.
 *     description: >
 *       Returns the book the calling `gcw_` token is scoped to and that book's
 *       base currency. Version 1 of this integration writes book-currency
 *       amounts only, so `rootCurrency` is the currency every `amountCents`
 *       value on the other endpoints is denominated in.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The token is valid.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 bookGuid: { type: string }
 *                 bookName: { type: string, nullable: true }
 *                 rootCurrency: { type: string, example: USD }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token does not grant access to its book.
 *       422:
 *         description: The book's root account has no commodity, so it has no base currency.
 */
export async function GET() {
    const authorized = await authorizeBeezRequest('readonly');
    if (authorized instanceof NextResponse) return authorized;

    try {
        const { context } = authorized;
        return NextResponse.json({
            ok: true,
            bookGuid: context.bookGuid,
            bookName: context.bookName,
            rootCurrency: context.rootCurrency,
        });
    } catch (error) {
        return beezErrorResponse(error);
    }
}
