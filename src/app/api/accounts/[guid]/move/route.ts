import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/services/account.service';
import { BookBusyError } from '@/lib/book-lock';
import { z } from 'zod';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { cacheInvalidateAllForBook } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { requireRole } from '@/lib/auth';

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
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

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

        // The new parent must belong to the same active book: a cross-book
        // reparent escapes the per-book lock (each request locks a different
        // book), letting two opposing moves re-create the account-cycle
        // corruption the lock exists to prevent — and even alone it grafts an
        // account into a tree the caller may not own.
        const { newParentGuid } = parseResult.data;
        if (newParentGuid !== null && !await isAccountInActiveBook(newParentGuid)) {
            return NextResponse.json({ error: 'Parent account not found' }, { status: 404 });
        }

        const account = await AccountService.move(guid, newParentGuid);
        void cacheInvalidateAllForBook(roleResult.bookGuid);
        void publishDataChange(roleResult.bookGuid, 'accounts', { guid, action: 'update' });
        return NextResponse.json(account);
    } catch (error) {
        if (error instanceof BookBusyError) {
            return NextResponse.json(
                { error: 'Another operation on this book is in progress. Try again shortly.' },
                { status: 409 }
            );
        }
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
