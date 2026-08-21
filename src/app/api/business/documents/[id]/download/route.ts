import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    getEntityDocumentFile,
    getEntityDocumentFileMeta,
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

/**
 * Headers-only HEAD. Explicit on purpose: without this export Next serves a
 * HEAD by running GET — which authenticates and reads the ENTIRE object from
 * storage per probe. A stalled storage read on that implicit path is what
 * froze the vault preview (2026-08-21). This answers from the database row
 * alone and never touches the storage backend.
 */
export async function HEAD(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id } = await params;
        const documentId = parseInt(id, 10);
        if (!Number.isInteger(documentId) || documentId <= 0) {
            return new Response(null, { status: 400 });
        }

        const meta = await getEntityDocumentFileMeta(bookGuid, documentId);
        const headers = buildDocumentServeHeaders({
            mimeType: meta.mimeType,
            fileName: meta.fileName,
            requestedDisposition: new URL(request.url).searchParams.get('disposition'),
        });
        if (meta.sizeBytes !== null) headers['Content-Length'] = String(meta.sizeBytes);
        return new Response(null, { headers });
    } catch (error) {
        if (error instanceof EntityDocumentNotFoundError) {
            return new Response(null, { status: 404 });
        }
        console.error('Document HEAD error:', error);
        return new Response(null, { status: 500 });
    }
}
