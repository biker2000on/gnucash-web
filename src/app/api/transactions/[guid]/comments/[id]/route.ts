import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import { publishDataChange } from '@/lib/data-events';
import { validateCommentBody, type TransactionComment } from '@/lib/transaction-comments';
import {
    CommentAccessError,
    buildCommentContext,
    deleteTransactionComment,
    setThreadResolved,
    updateTransactionComment,
} from '@/lib/services/transaction-comments.service';

function accessResponse(error: CommentAccessError): NextResponse {
    if (error.status === 400) {
        return validationErrorResponse([{ path: error.field ? [error.field] : [], message: error.message }]);
    }
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
 *
 * Both together are one atomic write. They used to be two sequential calls, so
 * a failed resolve left an edit committed, and the response was whichever ran
 * last — an "edit my reply and resolve the thread" PATCH answered with the
 * *root* comment, which is not the comment the caller edited.
 */
export async function PATCH(
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

        let validBody: string | undefined;
        if (rawBody !== undefined) {
            const body = validateCommentBody(rawBody);
            if (!body.ok) return validationErrorResponse(body.issues);
            validBody = body.value!;
        }

        const context = await buildCommentContext(roleResult);
        const { comment, threadResolved } = await prisma.$transaction(async tx => {
            let edited: TransactionComment | null = null;
            let root: TransactionComment | null = null;
            if (validBody !== undefined) {
                edited = await updateTransactionComment(guid, id, validBody, context, tx);
            }
            if (resolved !== undefined) {
                root = await setThreadResolved(guid, id, resolved, context, tx);
            }
            // The edited comment is the answer whenever there is one: it is the
            // row the caller changed, and the thread's resolved state rides
            // alongside it.
            return { comment: edited ?? root, threadResolved: root?.resolved };
        });

        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });
        return NextResponse.json(
            threadResolved === undefined ? comment : { ...comment, threadResolved },
        );
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
        const comment = await deleteTransactionComment(guid, id, context);
        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });
        return NextResponse.json(comment);
    } catch (error) {
        if (error instanceof CommentAccessError) return accessResponse(error);
        console.error('Error deleting transaction comment:', error);
        return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
    }
}
