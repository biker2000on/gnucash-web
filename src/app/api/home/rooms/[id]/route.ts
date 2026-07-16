import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { updateRoom, deleteRoom } from '@/lib/services/home.service';
import { handleHomeError, parseRouteId } from '../../_lib';

type RouteParams = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid room ID' }, { status: 400 });

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const room = await updateRoom(bookGuid, id, {
            name: body.name === undefined ? undefined : String(body.name),
            sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
        });
        return NextResponse.json({ room });
    } catch (error) {
        return handleHomeError(error, 'Error updating home room', 'Failed to update room');
    }
}

/** DELETE /api/home/rooms/[id] — items in the room cascade-delete. */
export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid room ID' }, { status: 400 });

        await deleteRoom(bookGuid, id);
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleHomeError(error, 'Error deleting home room', 'Failed to delete room');
    }
}
