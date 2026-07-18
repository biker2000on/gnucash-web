import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listItems, listDraftItems, createItem } from '@/lib/services/home.service';
import { handleHomeError, coerceItemInput } from '../_lib';

/**
 * GET /api/home/items — items for the book.
 *   ?roomId=<n>  one room's items
 *   ?draft=1     all draft (un-named) items book-wide, for bulk detailing
 */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);

        if (searchParams.get('draft') === '1') {
            const items = await listDraftItems(bookGuid);
            return NextResponse.json({ items });
        }

        const roomIdParam = searchParams.get('roomId');
        let roomId: number | undefined;
        if (roomIdParam !== null) {
            roomId = parseInt(roomIdParam, 10);
            if (!Number.isInteger(roomId) || roomId <= 0) {
                return NextResponse.json({ error: 'Invalid roomId' }, { status: 400 });
            }
        }

        const items = await listItems(bookGuid, roomId);
        return NextResponse.json({ items });
    } catch (error) {
        return handleHomeError(error, 'Error listing home items', 'Failed to list items');
    }
}

/** POST /api/home/items — create an item (photo uploads via [id]/photos). */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const item = await createItem(bookGuid, coerceItemInput(body));
        return NextResponse.json({ item }, { status: 201 });
    } catch (error) {
        return handleHomeError(error, 'Error creating home item', 'Failed to create item');
    }
}
