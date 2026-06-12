import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getTransactionTags, setTransactionTags } from '@/lib/services/tag.service';

/**
 * GET /api/transactions/{guid}/tags
 * Returns the tags assigned to a transaction.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const tx = await prisma.transactions.findUnique({ where: { guid }, select: { guid: true } });
        if (!tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        return NextResponse.json(await getTransactionTags(guid));
    } catch (error) {
        console.error('Error fetching transaction tags:', error);
        return NextResponse.json({ error: 'Failed to fetch transaction tags' }, { status: 500 });
    }
}

/**
 * PUT /api/transactions/{guid}/tags
 * Replaces the transaction's full tag list. Body: { tags: string[] } (tag
 * names; created on the fly when they don't exist yet).
 */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const tx = await prisma.transactions.findUnique({ where: { guid }, select: { guid: true } });
        if (!tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        const body = await request.json();
        if (!Array.isArray(body.tags)) {
            return NextResponse.json({ error: 'Body must include a "tags" array of tag names' }, { status: 400 });
        }

        try {
            const tags = await setTransactionTags(guid, body.tags);
            return NextResponse.json(tags);
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('Invalid tag name')) {
                return NextResponse.json({ error: err.message }, { status: 400 });
            }
            throw err;
        }
    } catch (error) {
        console.error('Error setting transaction tags:', error);
        return NextResponse.json({ error: 'Failed to set transaction tags' }, { status: 500 });
    }
}
