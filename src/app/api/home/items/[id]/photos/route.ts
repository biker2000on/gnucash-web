import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { addItemPhoto } from '@/lib/services/home.service';
import { handleHomeError, parseRouteId } from '../../../_lib';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/home/items/[id]/photos — multipart upload, appends a photo (JPEG/PNG, 10MB). */
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
        const item = await addItemPhoto(bookGuid, id, { buffer, filename: file.name });
        return NextResponse.json({ item }, { status: 201 });
    } catch (error) {
        return handleHomeError(error, 'Home item photo upload error', 'Photo upload failed');
    }
}
