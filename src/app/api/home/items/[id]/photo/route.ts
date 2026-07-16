import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    setItemPhoto,
    getItemPhoto,
    deleteItemPhoto,
} from '@/lib/services/home.service';
import { handleHomeError, parseRouteId } from '../../../_lib';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/home/items/[id]/photo — serve the stored photo inline. */
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid item ID' }, { status: 400 });

        const photo = await getItemPhoto(bookGuid, id);
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

/** POST /api/home/items/[id]/photo — multipart upload/replace (JPEG/PNG, 10MB). */
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid item ID' }, { status: 400 });

        const formData = await request.formData();
        const file = formData.get('file');
        if (!(file instanceof File)) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const item = await setItemPhoto(bookGuid, id, { buffer, filename: file.name });
        return NextResponse.json({ item }, { status: 201 });
    } catch (error) {
        return handleHomeError(error, 'Home item photo upload error', 'Photo upload failed');
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid item ID' }, { status: 400 });

        const item = await deleteItemPhoto(bookGuid, id);
        return NextResponse.json({ item });
    } catch (error) {
        return handleHomeError(error, 'Home item photo delete error', 'Failed to delete photo');
    }
}
