import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    getEntityDocumentSuggestions,
    requeueEntityDocumentExtraction,
    EntityDocumentNotFoundError,
} from '@/lib/services/entity-documents.service';

type RouteParams = { params: Promise<{ id: string }> };

async function parseId(params: RouteParams['params']): Promise<number | null> {
    const { id } = await params;
    const parsed = parseInt(id, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * GET /api/business/documents/[id]/suggestions — AI classification
 * suggestions from the extraction pipeline (advisory; the client applies
 * accepted values through the ordinary PUT).
 */
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });
        }

        const suggestions = await getEntityDocumentSuggestions(bookGuid, id);
        return NextResponse.json(suggestions);
    } catch (error) {
        if (error instanceof EntityDocumentNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error loading document suggestions:', error);
        return NextResponse.json({ error: 'Failed to load suggestions' }, { status: 500 });
    }
}

/**
 * POST /api/business/documents/[id]/suggestions — re-run extraction (and
 * the AI suggestion pass) for an already-uploaded document.
 */
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid, user } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });
        }

        await requeueEntityDocumentExtraction(bookGuid, id, user.id);
        return NextResponse.json({ queued: true });
    } catch (error) {
        if (error instanceof EntityDocumentNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error re-running document extraction:', error);
        return NextResponse.json({ error: 'Failed to re-run extraction' }, { status: 500 });
    }
}
