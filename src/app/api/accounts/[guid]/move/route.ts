import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/services/account.service';
import { z } from 'zod';
import { isAccountInActiveBook } from '@/lib/book-scope';

const MoveAccountSchema = z.object({
    newParentGuid: z.string().length(32).nullable(),
});

/**
 * @openapi
 * /api/accounts/{guid}/move:
 *   put:
 *     description: Move an account to a new parent.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - newParentGuid
 *             properties:
 *               newParentGuid:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Account moved successfully.
 *       400:
 *         description: Invalid move (circular reference, etc).
 *       404:
 *         description: Account not found.
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const body = await request.json();

        // Validate input
        const parseResult = MoveAccountSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const account = await AccountService.move(guid, parseResult.data.newParentGuid);
        return NextResponse.json(account);
    } catch (error) {
        console.error('Error moving account:', error);
        if (error instanceof Error) {
            if (error.message.includes('not found')) {
                return NextResponse.json({ error: error.message }, { status: 404 });
            }
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to move account' }, { status: 500 });
    }
}
