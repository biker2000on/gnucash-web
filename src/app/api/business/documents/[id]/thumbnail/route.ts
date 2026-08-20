import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { getDocumentThumbnail } from '@/lib/documents/thumbnail-store';
import { DOCUMENT_THUMBNAIL_MIME } from '@/lib/documents/thumbnail';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/business/documents/[id]/thumbnail
 *
 * Serves the rasterized first-page WebP thumbnail. 404 when not yet rendered
 * or the render failed. Never streams the original bytes.
 */
export async function GET(_request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id } = await params;
        const documentId = parseInt(id, 10);
        if (!Number.isInteger(documentId) || documentId <= 0) {
            return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });
        }

        const row = await getDocumentThumbnail(bookGuid, documentId);
        if (!row || row.thumbnailStatus !== 'complete' || !row.thumbnailKey) {
            return NextResponse.json({ error: 'Thumbnail not found' }, { status: 404 });
        }

        const storage = await getStorageBackend();
        const buffer = await storage.get(row.thumbnailKey);

        return new Response(new Uint8Array(buffer), {
            headers: {
                'Content-Type': DOCUMENT_THUMBNAIL_MIME,
                'Cache-Control': 'private, max-age=604800',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (error) {
        console.error('Document thumbnail serve error:', error);
        return NextResponse.json({ error: 'Failed to serve thumbnail' }, { status: 500 });
    }
}
