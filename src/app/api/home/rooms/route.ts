import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listRooms, createRoom } from '@/lib/services/home.service';
import { handleHomeError } from '../_lib';

/** GET /api/home/rooms — the book's rooms in sort order. */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const rooms = await listRooms(bookGuid);
        return NextResponse.json({ rooms });
    } catch (error) {
        return handleHomeError(error, 'Error listing home rooms', 'Failed to list rooms');
    }
}

/** POST /api/home/rooms — create a room. */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const room = await createRoom(bookGuid, {
            name: String(body.name ?? ''),
            sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
        });
        return NextResponse.json({ room }, { status: 201 });
    } catch (error) {
        return handleHomeError(error, 'Error creating home room', 'Failed to create room');
    }
}
