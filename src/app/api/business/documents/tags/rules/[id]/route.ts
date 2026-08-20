import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import {
    DocumentTagNotFoundError,
    DocumentTagValidationError,
    deleteDocumentTagRule,
    updateDocumentTagRule,
} from '@/lib/documents/document-tags';

type RouteParams = { params: Promise<{ id: string }> };

async function parseId(params: RouteParams['params']): Promise<number | null> {
    const { id } = await params;
    const parsed = parseInt(id, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * PUT /api/business/documents/tags/rules/[id]
 */
export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return validationErrorResponse([{ path: ['id'], message: 'Invalid rule ID' }]);
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return validationErrorResponse([{ path: ['body'], message: 'Invalid request body' }]);
        }
        const record = body as Record<string, unknown>;

        const rule = await updateDocumentTagRule(bookGuid, id, {
            matchField: record.matchField ?? record.match_field,
            matchValue: record.matchValue ?? record.match_value,
            tag: record.tag,
        });
        return NextResponse.json({ rule });
    } catch (error) {
        if (error instanceof DocumentTagValidationError) {
            return validationErrorResponse([{ message: error.message }]);
        }
        if (error instanceof DocumentTagNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error updating document tag rule:', error);
        return NextResponse.json({ error: 'Failed to update tag rule' }, { status: 500 });
    }
}

/**
 * DELETE /api/business/documents/tags/rules/[id]
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseId(params);
        if (id === null) {
            return validationErrorResponse([{ path: ['id'], message: 'Invalid rule ID' }]);
        }

        await deleteDocumentTagRule(bookGuid, id);
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof DocumentTagNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error deleting document tag rule:', error);
        return NextResponse.json({ error: 'Failed to delete tag rule' }, { status: 500 });
    }
}
