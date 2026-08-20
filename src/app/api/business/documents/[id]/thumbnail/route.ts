import { createHash } from 'node:crypto';
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
 *
 * Caching: `max-age=0, must-revalidate` rather than a week of `private`
 * freshness. A `private` week is still reusable from the browser cache after
 * the user logs out (and by the next user of a shared profile) with no
 * round-trip that could re-check the session. The ETag — derived from the
 * immutable thumbnail storage key — keeps the revalidation cheap: unchanged
 * thumbnails come back as a bodyless 304 that still passes through auth.
 */
function thumbnailEtag(thumbnailKey: string): string {
    return `"${createHash('sha256').update(thumbnailKey).digest('hex').slice(0, 32)}"`;
}

export async function GET(request: Request, { params }: RouteParams) {
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

        const etag = thumbnailEtag(row.thumbnailKey);
        const cacheHeaders = {
            'Cache-Control': 'private, max-age=0, must-revalidate',
            ETag: etag,
            'X-Content-Type-Options': 'nosniff',
        };

        if (request.headers.get('if-none-match') === etag) {
            return new Response(null, { status: 304, headers: cacheHeaders });
        }

        const storage = await getStorageBackend();
        const buffer = await storage.get(row.thumbnailKey);

        return new Response(new Uint8Array(buffer), {
            headers: {
                ...cacheHeaders,
                'Content-Type': DOCUMENT_THUMBNAIL_MIME,
            },
        });
    } catch (error) {
        console.error('Document thumbnail serve error:', error);
        return NextResponse.json({ error: 'Failed to serve thumbnail' }, { status: 500 });
    }
}
