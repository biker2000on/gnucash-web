import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import { publishDataChange } from '@/lib/data-events';
import { validateCommentBody } from '@/lib/transaction-comments';
import {
    CommentAccessError,
    buildCommentContext,
    createTransactionComment,
    listTransactionComments,
} from '@/lib/services/transaction-comments.service';

/** Map a service access failure onto its HTTP answer. */
function accessResponse(error: CommentAccessError): NextResponse {
    return NextResponse.json({ error: error.message }, { status: error.status });
}

/**
 * GET /api/transactions/{guid}/comments
 * Threaded comments on a transaction. Viewers may read.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> },
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const context = await buildCommentContext(roleResult);
        return NextResponse.json({
            threads: await listTransactionComments(guid, context),
            viewer: { userId: context.viewer.userId, role: context.viewer.role },
        });
    } catch (error) {
        if (error instanceof CommentAccessError) return accessResponse(error);
        console.error('Error listing transaction comments:', error);
        return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 });
    }
}

/**
 * POST /api/transactions/{guid}/comments
 * Body: `{ body: string, parentId?: number, auditId?: number }`.
 *
 * Commenting is an edit-role action: a read-only viewer can read the
 * discussion but not add to it.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ guid: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const payload = await request.json().catch(() => null);
        if (!payload || typeof payload !== 'object') {
            return validationErrorResponse([{ path: ['body'], message: 'A JSON body is required' }]);
        }

        const body = validateCommentBody((payload as { body?: unknown }).body);
        if (!body.ok) return validationErrorResponse(body.issues);

        const parentId = parseOptionalId((payload as { parentId?: unknown }).parentId);
        if (parentId === 'invalid') {
            return validationErrorResponse([{ path: ['parentId'], message: 'parentId must be a positive integer' }]);
        }
        const auditId = parseOptionalId((payload as { auditId?: unknown }).auditId);
        if (auditId === 'invalid') {
            return validationErrorResponse([{ path: ['auditId'], message: 'auditId must be a positive integer' }]);
        }

        const context = await buildCommentContext(roleResult);
        const comment = await createTransactionComment(
            { txnGuid: guid, body: body.value!, parentId, auditId },
            context,
        );
        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });
        return NextResponse.json(comment, { status: 201 });
    } catch (error) {
        if (error instanceof CommentAccessError) return accessResponse(error);
        console.error('Error creating transaction comment:', error);
        return NextResponse.json({ error: 'Failed to post comment' }, { status: 500 });
    }
}

/** `undefined`/`null` → null; a positive integer → itself; anything else → 'invalid'. */
function parseOptionalId(raw: unknown): number | null | 'invalid' {
    if (raw === undefined || raw === null) return null;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 'invalid';
    return value;
}
