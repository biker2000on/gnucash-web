import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    getEntityDocumentFile,
    EntityDocumentNotFoundError,
} from '@/lib/services/entity-documents.service';

type RouteParams = { params: Promise<{ id: string }> };

/** Streamed download following the receipts serve pattern. */
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

        const file = await getEntityDocumentFile(bookGuid, documentId);

        return new Response(new Uint8Array(file.buffer), {
            headers: {
                'Content-Type': file.mimeType,
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
                'Cache-Control': 'private, max-age=86400',
            },
        });
    } catch (error) {
        if (error instanceof EntityDocumentNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Document download error:', error);
        return NextResponse.json({ error: 'Failed to download document' }, { status: 500 });
    }
}
