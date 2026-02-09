import { NextRequest, NextResponse } from 'next/server';
import { AccountService, UpdateAccountSchema } from '@/lib/services/account.service';
import { isAccountInActiveBook } from '@/lib/book-scope';

/**
 * @openapi
 * /api/accounts/{guid}:
 *   get:
 *     description: Get a single account by GUID.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Account details.
 *       404:
 *         description: Account not found.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const account = await AccountService.getById(guid);
        if (!account) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        return NextResponse.json(account);
    } catch (error) {
        console.error('Error fetching account:', error);
        return NextResponse.json({ error: 'Failed to fetch account' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/accounts/{guid}:
 *   put:
 *     description: Update an account.
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
 *             properties:
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *               description:
 *                 type: string
 *               hidden:
 *                 type: integer
 *               placeholder:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Account updated successfully.
 *       400:
 *         description: Validation error.
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
        const parseResult = UpdateAccountSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const account = await AccountService.update(guid, parseResult.data);
        return NextResponse.json(account);
    } catch (error) {
        console.error('Error updating account:', error);
        if (error instanceof Error) {
            if (error.message.includes('not found')) {
                return NextResponse.json({ error: error.message }, { status: 404 });
            }
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/accounts/{guid}:
 *   delete:
 *     description: Delete an account (only if it has no transactions).
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Account deleted successfully.
 *       400:
 *         description: Cannot delete account with transactions.
 *       404:
 *         description: Account not found.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const result = await AccountService.delete(guid);
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error deleting account:', error);
        if (error instanceof Error) {
            if (error.message.includes('not found')) {
                return NextResponse.json({ error: error.message }, { status: 404 });
            }
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
    }
}
