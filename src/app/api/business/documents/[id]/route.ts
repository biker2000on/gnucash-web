import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    updateEntityDocument,
    deleteEntityDocument,
    EntityDocumentNotFoundError,
    EntityDocumentValidationError,
    type UpdateEntityDocumentInput,
} from '@/lib/services/entity-documents.service';

type RouteParams = { params: Promise<{ id: string }> };

async function parseId(params: RouteParams['params']): Promise<number | null> {
    const { id } = await params;
    const parsed = parseInt(id, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const input: UpdateEntityDocumentInput = {
            title: body.title === undefined ? undefined : String(body.title),
            docType: body.docType === undefined ? undefined : String(body.docType),
            expiresOn:
                body.expiresOn === undefined
                    ? undefined
                    : body.expiresOn === null
                      ? null
                      : String(body.expiresOn),
            notes: body.notes === undefined ? undefined : body.notes === null ? null : String(body.notes),
        };

        const document = await updateEntityDocument(bookGuid, id, input);
        return NextResponse.json({ document });
    } catch (error) {
        if (error instanceof EntityDocumentValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof EntityDocumentNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error updating entity document:', error);
        return NextResponse.json({ error: 'Failed to update document' }, { status: 500 });
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });
        }

        await deleteEntityDocument(bookGuid, id);
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof EntityDocumentNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error deleting entity document:', error);
        return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
    }
}
