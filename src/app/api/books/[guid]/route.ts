import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

/**
 * GET /api/books/[guid]
 * Get book details.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        const book = await prisma.books.findUnique({
            where: { guid },
        });

        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        const rootAccount = await prisma.accounts.findUnique({
            where: { guid: book.root_account_guid },
            select: { name: true },
        });

        const accountCount = await prisma.$queryRaw<{ count: bigint }[]>`
            WITH RECURSIVE account_tree AS (
                SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
                UNION ALL
                SELECT a.guid FROM accounts a
                JOIN account_tree t ON a.parent_guid = t.guid
            )
            SELECT COUNT(*)::bigint as count FROM account_tree
            WHERE guid != ${book.root_account_guid}
        `;

        return NextResponse.json({
            guid: book.guid,
            name: rootAccount?.name || 'Unknown',
            rootAccountGuid: book.root_account_guid,
            rootTemplateGuid: book.root_template_guid,
            accountCount: Number(accountCount[0]?.count || 0),
        });
    } catch (error) {
        console.error('Error fetching book:', error);
        return NextResponse.json({ error: 'Failed to fetch book' }, { status: 500 });
    }
}

/**
 * PUT /api/books/[guid]
 * Update book (rename root account name).
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const body = await request.json();
        const { name } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json({ error: 'Name is required' }, { status: 400 });
        }

        const book = await prisma.books.findUnique({
            where: { guid },
        });

        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        await prisma.accounts.update({
            where: { guid: book.root_account_guid },
            data: { name: name.trim() },
        });

        return NextResponse.json({ guid, name: name.trim() });
    } catch (error) {
        console.error('Error updating book:', error);
        return NextResponse.json({ error: 'Failed to update book' }, { status: 500 });
    }
}

/**
 * DELETE /api/books/[guid]
 * Delete book and all associated accounts/transactions.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        const book = await prisma.books.findUnique({
            where: { guid },
        });

        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        // Check we're not deleting the last book
        const bookCount = await prisma.books.count();
        if (bookCount <= 1) {
            return NextResponse.json(
                { error: 'Cannot delete the last book' },
                { status: 400 }
            );
        }

        // Get all account GUIDs under this book's root
        const accountTree = await prisma.$queryRaw<{ guid: string }[]>`
            WITH RECURSIVE account_tree AS (
                SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
                UNION ALL
                SELECT a.guid FROM accounts a
                JOIN account_tree t ON a.parent_guid = t.guid
            )
            SELECT guid FROM account_tree
        `;

        const accountGuids = accountTree.map(a => a.guid);

        // Also get template root accounts
        const templateTree = await prisma.$queryRaw<{ guid: string }[]>`
            WITH RECURSIVE account_tree AS (
                SELECT guid FROM accounts WHERE guid = ${book.root_template_guid}
                UNION ALL
                SELECT a.guid FROM accounts a
                JOIN account_tree t ON a.parent_guid = t.guid
            )
            SELECT guid FROM account_tree
        `;
        const templateGuids = templateTree.map(a => a.guid);
        const allAccountGuids = [...accountGuids, ...templateGuids];

        await prisma.$transaction(async (tx) => {
            // Delete budget_amounts referencing these accounts
            await tx.budget_amounts.deleteMany({
                where: { account_guid: { in: allAccountGuids } },
            });

            // Delete splits for these accounts (which cascades to remove refs)
            await tx.splits.deleteMany({
                where: { account_guid: { in: allAccountGuids } },
            });

            // Delete transactions that now have no splits
            // (transactions whose splits were all in this book)
            await tx.$queryRaw`
                DELETE FROM transactions
                WHERE guid NOT IN (
                    SELECT DISTINCT tx_guid FROM splits
                )
            `;

            // Delete accounts (children first due to parent_guid FK)
            // Reverse order of depth to delete leaves first
            for (let i = allAccountGuids.length - 1; i >= 0; i--) {
                await tx.accounts.deleteMany({
                    where: { guid: allAccountGuids[i] },
                });
            }

            // Delete the book record
            await tx.books.delete({
                where: { guid },
            });
        });

        return NextResponse.json({ success: true, deleted: guid });
    } catch (error) {
        console.error('Error deleting book:', error);
        return NextResponse.json({ error: 'Failed to delete book' }, { status: 500 });
    }
}
