import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    DocumentValidationError,
    ensureCanonicalDocumentPlatform,
    listDocumentsPage,
} from '@/lib/documents';

function integerParam(value: string | null, fallback: number): number {
    if (value === null || value.trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
}

/**
 * GET /api/documents — book-scoped canonical document metadata for pickers.
 * Search-backed and paged: `q` filters, `offset`/`hasMore` walk past one page.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        await ensureCanonicalDocumentPlatform();
        const { documents, hasMore, nextOffset } = await listDocumentsPage({
            bookGuid: roleResult.bookGuid,
            query: request.nextUrl.searchParams.get('q')?.trim() || undefined,
            limit: integerParam(request.nextUrl.searchParams.get('limit'), 100),
            offset: integerParam(request.nextUrl.searchParams.get('offset'), 0),
        });
        return NextResponse.json({
            hasMore,
            nextOffset,
            documents: documents.map(document => ({
                id: document.id,
                title: document.title,
                filename: document.filename,
                mimeType: document.mimeType,
                sizeBytes: document.sizeBytes === null ? null : Number(document.sizeBytes),
                sourceKind: document.sourceKind,
                sourceId: document.sourceId,
                extractionStatus: document.extractionStatus,
                extractedAt: document.extractedAt?.toISOString() ?? null,
                createdAt: document.createdAt.toISOString(),
                updatedAt: document.updatedAt.toISOString(),
            })),
        });
    } catch (error) {
        if (error instanceof DocumentValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Failed to list canonical documents', error);
        return NextResponse.json({ error: 'Failed to list documents' }, { status: 500 });
    }
}
