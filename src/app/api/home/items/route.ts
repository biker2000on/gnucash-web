import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listItems, createItem } from '@/lib/services/home.service';
import { handleHomeError, coerceItemInput } from '../_lib';

/** GET /api/home/items?roomId= — items for the book, optionally one room. */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
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

/** POST /api/home/items — create an item (photo uploads via [id]/photo). */
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
