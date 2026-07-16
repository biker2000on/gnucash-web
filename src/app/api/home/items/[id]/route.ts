import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { updateItem, deleteItem } from '@/lib/services/home.service';
import { handleHomeError, parseRouteId, coerceItemInput } from '../../_lib';

type RouteParams = { params: Promise<{ id: string }> };

/** PUT /api/home/items/[id] — edit fields, move rooms, link a receipt. */
export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid item ID' }, { status: 400 });

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const item = await updateItem(bookGuid, id, coerceItemInput(body));
        return NextResponse.json({ item });
    } catch (error) {
        return handleHomeError(error, 'Error updating home item', 'Failed to update item');
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid item ID' }, { status: 400 });

        await deleteItem(bookGuid, id);
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleHomeError(error, 'Error deleting home item', 'Failed to delete item');
    }
}
