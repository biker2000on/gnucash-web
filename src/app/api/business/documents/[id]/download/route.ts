import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    getEntityDocumentFile,
    EntityDocumentNotFoundError,
} from '@/lib/services/entity-documents.service';
import { buildDocumentServeHeaders } from '@/lib/document-preview';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Streamed download following the receipts serve pattern.
 *
 * `?disposition=inline` opts into in-browser preview, which is honoured only for
 * the safelisted MIME types in `@/lib/document-preview`; every other request —
 * including one with no parameter — still gets `attachment`. Auth and book
 * scoping are unchanged.
 */
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
            headers: buildDocumentServeHeaders({
                mimeType: file.mimeType,
                fileName: file.fileName,
                requestedDisposition: new URL(request.url).searchParams.get('disposition'),
            }),
        });
    } catch (error) {
        if (error instanceof EntityDocumentNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Document download error:', error);
        return NextResponse.json({ error: 'Failed to download document' }, { status: 500 });
    }
}
