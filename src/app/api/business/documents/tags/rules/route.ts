import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import {
    DocumentTagValidationError,
    createDocumentTagRule,
    listDocumentTagRules,
} from '@/lib/documents/document-tags';

/**
 * GET /api/business/documents/tags/rules
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const rules = await listDocumentTagRules(bookGuid);
        return NextResponse.json({ rules });
    } catch (error) {
        console.error('Error listing document tag rules:', error);
        return NextResponse.json({ error: 'Failed to list tag rules' }, { status: 500 });
    }
}

/**
 * POST /api/business/documents/tags/rules
 * Body: { matchField | match_field, matchValue | match_value, tag }
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return validationErrorResponse([{ path: ['body'], message: 'Invalid request body' }]);
        }
        const record = body as Record<string, unknown>;

        const rule = await createDocumentTagRule(bookGuid, {
            matchField: record.matchField ?? record.match_field,
            matchValue: record.matchValue ?? record.match_value,
            tag: record.tag,
        });
        return NextResponse.json({ rule }, { status: 201 });
    } catch (error) {
        if (error instanceof DocumentTagValidationError) {
            return validationErrorResponse([{ message: error.message }]);
        }
        console.error('Error creating document tag rule:', error);
        return NextResponse.json({ error: 'Failed to create tag rule' }, { status: 500 });
    }
}
