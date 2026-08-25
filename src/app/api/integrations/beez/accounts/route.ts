// GET /api/integrations/beez/accounts
//
// The chart of accounts a beez-trackz install maps its own categories onto.
// Returned whole rather than paginated: a book's account tree is hundreds of
// rows, the client needs all of them to build a mapping UI, and a partial list
// would silently hide the account a user was looking for.
//
// `placeholder` and `hidden` are reported rather than filtered out. A hidden
// account still holds history the client may need to name, and a placeholder
// must be VISIBLE so the mapping UI can grey it out — dropping it just makes
// the user wonder where a branch of their tree went.

import { NextResponse } from 'next/server';
import { authorizeBeezRequest, beezErrorResponse } from '@/lib/integrations/beez-route';
import { listBeezAccounts } from '@/lib/services/beez-sync.service';

/**
 * @openapi
 * /api/integrations/beez/accounts:
 *   get:
 *     tags: [beez-trackz integration]
 *     summary: List every account in the token's book.
 *     description: >
 *       Returns all accounts under the book root, with a colon-joined
 *       `fullName` path (the root itself is not part of the path). Only
 *       accounts whose `commodityMnemonic` equals the book's `rootCurrency` and
 *       whose `placeholder` is false can be posted to by version 1 of this
 *       integration.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The book's chart of accounts.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accounts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       guid: { type: string }
 *                       name: { type: string }
 *                       fullName: { type: string, example: "Expenses:Farm:Bee Supplies" }
 *                       type: { type: string, example: EXPENSE }
 *                       commodityMnemonic: { type: string, nullable: true }
 *                       placeholder: { type: boolean }
 *                       hidden: { type: boolean }
 *       401:
 *         description: Missing, invalid, revoked, or expired token.
 *       403:
 *         description: The token does not grant access to its book.
 */
export async function GET() {
    const authorized = await authorizeBeezRequest('readonly');
    if (authorized instanceof NextResponse) return authorized;

    try {
        const accounts = await listBeezAccounts(authorized.context);
        return NextResponse.json({ accounts });
    } catch (error) {
        return beezErrorResponse(error);
    }
}
