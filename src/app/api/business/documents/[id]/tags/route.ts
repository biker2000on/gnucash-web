import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import {
    DocumentTagNotFoundError,
    DocumentTagValidationError,
    getDocumentTags,
    setDocumentTags,
} from '@/lib/documents/document-tags';

type RouteParams = { params: Promise<{ id: string }> };

async function parseId(params: RouteParams['params']): Promise<number | null> {
    const { id } = await params;
    const parsed = parseInt(id, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * GET /api/business/documents/[id]/tags → { tags: string[] }
 */
export async function GET(_request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return validationErrorResponse([{ path: ['id'], message: 'Invalid document ID' }]);
        }

        const tags = await getDocumentTags(bookGuid, id);
        return NextResponse.json({ tags });
    } catch (error) {
        if (error instanceof DocumentTagNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error loading document tags:', error);
        return NextResponse.json({ error: 'Failed to load document tags' }, { status: 500 });
    }
}

/**
 * PUT /api/business/documents/[id]/tags — replace the tag set. Body: { tags: string[] }.
 */
export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return validationErrorResponse([{ path: ['id'], message: 'Invalid document ID' }]);
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object' || !Array.isArray((body as { tags?: unknown }).tags)) {
            return validationErrorResponse([{ path: ['tags'], message: 'tags must be an array of strings' }]);
        }
        const rawTags = (body as { tags: unknown[] }).tags;
        if (rawTags.some((tag) => typeof tag !== 'string')) {
            return validationErrorResponse([{ path: ['tags'], message: 'tags must be an array of strings' }]);
        }

        const tags = await setDocumentTags(bookGuid, id, rawTags as string[]);
        return NextResponse.json({ tags });
    } catch (error) {
        if (error instanceof DocumentTagValidationError) {
            return validationErrorResponse([{ path: ['tags'], message: error.message }]);
        }
        if (error instanceof DocumentTagNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error saving document tags:', error);
        return NextResponse.json({ error: 'Failed to save document tags' }, { status: 500 });
    }
}
