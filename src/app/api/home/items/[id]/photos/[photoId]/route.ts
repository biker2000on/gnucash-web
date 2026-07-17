import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getItemPhoto, deleteItemPhoto } from '@/lib/services/home.service';
import { handleHomeError } from '../../../../_lib';

type RouteParams = { params: Promise<{ id: string; photoId: string }> };

async function parseIds(
    params: RouteParams['params'],
): Promise<{ id: number; photoId: number } | null> {
    const { id, photoId } = await params;
    const itemId = parseInt(id, 10);
    const pid = parseInt(photoId, 10);
    if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    return { id: itemId, photoId: pid };
}

/** GET /api/home/items/[id]/photos/[photoId] — serve the stored photo inline. */
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const ids = await parseIds(params);
        if (ids === null) return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });

        const photo = await getItemPhoto(bookGuid, ids.id, ids.photoId);
        return new Response(new Uint8Array(photo.buffer), {
            headers: {
                'Content-Type': photo.mimeType,
                'Cache-Control': 'private, max-age=86400',
            },
        });
    } catch (error) {
        return handleHomeError(error, 'Home item photo download error', 'Failed to load photo');
    }
}

/** DELETE /api/home/items/[id]/photos/[photoId] — remove one photo from the gallery. */
export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const ids = await parseIds(params);
        if (ids === null) return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });

        const item = await deleteItemPhoto(bookGuid, ids.id, ids.photoId);
        return NextResponse.json({ item });
    } catch (error) {
        return handleHomeError(error, 'Home item photo delete error', 'Failed to delete photo');
    }
}
