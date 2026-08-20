import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import { publishDataChange } from '@/lib/data-events';
import { validateCommentBody } from '@/lib/transaction-comments';
import {
    CommentAccessError,
    buildCommentContext,
    deleteTransactionComment,
    setThreadResolved,
    updateTransactionComment,
} from '@/lib/services/transaction-comments.service';

function accessResponse(error: CommentAccessError): NextResponse {
    return NextResponse.json({ error: error.message }, { status: error.status });
}

function parseId(raw: string): number | null {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * PATCH /api/transactions/{guid}/comments/{id}
 * Body: `{ body }` to edit (author only), `{ resolved }` to resolve or reopen
 * the thread (any editor — the person who answers a question is usually not
 * the person who asked it).
 */
export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ guid: string; id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id: rawId } = await params;
        const id = parseId(rawId);
        if (id === null) {
            return validationErrorResponse([{ path: ['id'], message: 'Comment id must be a positive integer' }]);
        }

        const payload = await request.json().catch(() => null);
        if (!payload || typeof payload !== 'object') {
            return validationErrorResponse([{ path: ['body'], message: 'A JSON body is required' }]);
        }
        const { body: rawBody, resolved } = payload as { body?: unknown; resolved?: unknown };
        if (rawBody === undefined && resolved === undefined) {
            return validationErrorResponse([{ path: [], message: 'Provide "body" to edit or "resolved" to resolve the thread' }]);
        }
        if (resolved !== undefined && typeof resolved !== 'boolean') {
            return validationErrorResponse([{ path: ['resolved'], message: 'resolved must be a boolean' }]);
        }

        const context = await buildCommentContext(roleResult);
        let comment = null;
        if (rawBody !== undefined) {
            const body = validateCommentBody(rawBody);
            if (!body.ok) return validationErrorResponse(body.issues);
            comment = await updateTransactionComment(id, body.value!, context);
        }
        if (resolved !== undefined) {
            comment = await setThreadResolved(id, resolved, context);
        }

        const { guid } = await params;
        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });
        return NextResponse.json(comment);
    } catch (error) {
        if (error instanceof CommentAccessError) return accessResponse(error);
        console.error('Error updating transaction comment:', error);
        return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
    }
}

/**
 * DELETE /api/transactions/{guid}/comments/{id}
 * Soft-delete. Authors delete their own; admins delete any. The row stays so
 * the replies under it keep their place in the thread.
 */
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ guid: string; id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid, id: rawId } = await params;
        const id = parseId(rawId);
        if (id === null) {
            return validationErrorResponse([{ path: ['id'], message: 'Comment id must be a positive integer' }]);
        }

        const context = await buildCommentContext(roleResult);
        const comment = await deleteTransactionComment(id, context);
        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });
        return NextResponse.json(comment);
    } catch (error) {
        if (error instanceof CommentAccessError) return accessResponse(error);
        console.error('Error deleting transaction comment:', error);
        return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
    }
}
