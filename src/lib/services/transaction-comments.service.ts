/**
 * Transaction comments — data access.
 *
 * Every read and write here is constrained to one book two ways: the
 * transaction must have a split in the caller's book, and the comment rows
 * themselves are filtered on `book_root_guid`. Either check alone would be
 * enough for well-formed data; both together mean a mis-stamped row cannot
 * leak across books in either direction.
 *
 * The table is created by `src/lib/db-init.ts` (which both the app and the
 * worker run at startup); nothing here does DDL.
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { createNotification } from '@/lib/notifications';
import {
    DELETED_COMMENT_BODY,
    buildCommentThreads,
    canDeleteComment,
    canEditComment,
    resolveMentionedMembers,
    type CommentThread,
    type CommentViewer,
    type TransactionComment,
} from '@/lib/transaction-comments';

/** Everything a call needs to be book-scoped and attributed. */
export interface CommentContext {
    /** books.guid — used for permissions, notifications and member lookup. */
    bookGuid: string;
    /** books.root_account_guid — what the comment rows are stamped with. */
    bookRootGuid: string;
    /** Account guids in the book, used to prove the transaction belongs to it. */
    bookAccountGuids: string[];
    viewer: CommentViewer;
}

interface CommentRow {
    id: number;
    txn_guid: string;
    parent_id: number | null;
    audit_id: number | null;
    user_id: number | null;
    username: string | null;
    display_name: string | null;
    body: string;
    resolved: boolean;
    created_at: Date;
    edited_at: Date | null;
    deleted_at: Date | null;
}

/** A soft-deleted comment keeps its place in the thread but not its words. */
function toComment(row: CommentRow): TransactionComment {
    const deleted = row.deleted_at !== null;
    return {
        id: row.id,
        txnGuid: row.txn_guid,
        parentId: row.parent_id,
        auditId: row.audit_id,
        author: {
            id: row.user_id,
            username: row.username ?? 'deleted-user',
            displayName: row.display_name || row.username || 'Removed user',
        },
        body: deleted ? DELETED_COMMENT_BODY : row.body,
        resolved: row.resolved,
        createdAt: row.created_at.toISOString(),
        editedAt: row.edited_at ? row.edited_at.toISOString() : null,
        deleted,
    };
}

/**
 * Build the scoping context for a request from what `requireRole` returned.
 *
 * Derived from the authorized book guid rather than the session, so a Bearer
 * token request (which carries no session book) is scoped to the book the
 * token was actually issued for.
 */
export async function buildCommentContext(auth: {
    user: { id: number };
    role: CommentViewer['role'];
    bookGuid: string;
}): Promise<CommentContext> {
    const book = await prisma.books.findUnique({
        where: { guid: auth.bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) throw new CommentAccessError('Book not found', 404);
    return {
        bookGuid: auth.bookGuid,
        bookRootGuid: book.root_account_guid,
        bookAccountGuids: await getAccountGuidsForBook(auth.bookGuid),
        viewer: { userId: auth.user.id, role: auth.role },
    };
}

/** Thrown for a request that is well-formed but not allowed / not found. */
export class CommentAccessError extends Error {
    constructor(message: string, readonly status: 403 | 404) {
        super(message);
        this.name = 'CommentAccessError';
    }
}

/**
 * Does this transaction belong to the caller's book?
 *
 * A transaction has no book column — its book is whichever root its splits'
 * accounts hang from, which is exactly what `bookAccountGuids` enumerates.
 */
export async function isTransactionInBook(
    txnGuid: string,
    bookAccountGuids: string[],
): Promise<boolean> {
    if (bookAccountGuids.length === 0) return false;
    const rows = await prisma.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS one
        FROM splits
        WHERE tx_guid = ${txnGuid}
          AND account_guid = ANY(${bookAccountGuids}::text[])
        LIMIT 1
    `;
    return rows.length > 0;
}

async function requireTransactionInBook(txnGuid: string, context: CommentContext): Promise<void> {
    if (!(await isTransactionInBook(txnGuid, context.bookAccountGuids))) {
        // Deliberately "not found": a transaction in another book must not be
        // distinguishable from one that does not exist.
        throw new CommentAccessError('Transaction not found', 404);
    }
}

const SELECT_COLUMNS = `
    c.id, c.txn_guid, c.parent_id, c.audit_id, c.user_id,
    u.username, u.display_name,
    c.body, c.resolved, c.created_at, c.edited_at, c.deleted_at
`;

/** Every comment on a transaction, assembled into threads. */
export async function listTransactionComments(
    txnGuid: string,
    context: CommentContext,
): Promise<CommentThread[]> {
    await requireTransactionInBook(txnGuid, context);
    const rows = await prisma.$queryRawUnsafe<CommentRow[]>(
        `SELECT ${SELECT_COLUMNS}
         FROM gnucash_web_transaction_comments c
         LEFT JOIN gnucash_web_users u ON u.id = c.user_id
         WHERE c.txn_guid = $1 AND c.book_root_guid = $2
         ORDER BY c.created_at ASC, c.id ASC`,
        txnGuid,
        context.bookRootGuid,
    );
    return buildCommentThreads(rows.map(toComment));
}

/**
 * Comment counts per transaction guid for a batch of rows.
 *
 * One call for a whole ledger page: the alternative is a request per row, and
 * the badge is not worth 50 round trips. Soft-deleted comments do not count —
 * a badge that says "1" and opens onto "This comment was deleted." is noise.
 */
export async function commentCountsForTransactions(
    txnGuids: string[],
    context: Pick<CommentContext, 'bookRootGuid'>,
): Promise<Record<string, number>> {
    if (txnGuids.length === 0) return {};
    const rows = await prisma.$queryRaw<Array<{ txn_guid: string; count: bigint }>>`
        SELECT txn_guid, COUNT(*)::bigint AS count
        FROM gnucash_web_transaction_comments
        WHERE book_root_guid = ${context.bookRootGuid}
          AND deleted_at IS NULL
          AND txn_guid = ANY(${txnGuids}::text[])
        GROUP BY txn_guid
    `;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.txn_guid] = Number(row.count);
    return counts;
}

/** Total unresolved thread roots in the book, for the Action Center source. */
export interface UnresolvedThreadSummary {
    id: number;
    txnGuid: string;
    body: string;
    createdAt: Date;
    authorName: string;
    replyCount: number;
}

export async function listUnresolvedThreads(
    bookRootGuid: string,
    limit = 100,
): Promise<UnresolvedThreadSummary[]> {
    const rows = await prisma.$queryRaw<Array<{
        id: number;
        txn_guid: string;
        body: string;
        created_at: Date;
        username: string | null;
        display_name: string | null;
        reply_count: bigint;
    }>>`
        SELECT c.id, c.txn_guid, c.body, c.created_at, u.username, u.display_name,
               (SELECT COUNT(*)::bigint
                  FROM gnucash_web_transaction_comments r
                 WHERE r.parent_id = c.id AND r.deleted_at IS NULL) AS reply_count
        FROM gnucash_web_transaction_comments c
        LEFT JOIN gnucash_web_users u ON u.id = c.user_id
        WHERE c.book_root_guid = ${bookRootGuid}
          AND c.parent_id IS NULL
          AND c.resolved = FALSE
          AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC
        LIMIT ${limit}
    `;
    return rows.map(row => ({
        id: row.id,
        txnGuid: row.txn_guid,
        body: row.body,
        createdAt: row.created_at,
        authorName: row.display_name || row.username || 'Removed user',
        replyCount: Number(row.reply_count),
    }));
}

async function loadComment(id: number, context: CommentContext): Promise<CommentRow> {
    const rows = await prisma.$queryRawUnsafe<CommentRow[]>(
        `SELECT ${SELECT_COLUMNS}
         FROM gnucash_web_transaction_comments c
         LEFT JOIN gnucash_web_users u ON u.id = c.user_id
         WHERE c.id = $1 AND c.book_root_guid = $2
         LIMIT 1`,
        id,
        context.bookRootGuid,
    );
    const row = rows[0];
    if (!row) throw new CommentAccessError('Comment not found', 404);
    return row;
}

/** Book members who can be @-mentioned. */
async function bookMembers(bookGuid: string): Promise<Array<{ id: number; username: string }>> {
    return prisma.$queryRaw<Array<{ id: number; username: string }>>`
        SELECT u.id, u.username
        FROM gnucash_web_book_permissions p
        JOIN gnucash_web_users u ON u.id = p.user_id
        WHERE p.book_guid = ${bookGuid}
    `;
}

/**
 * Notify the people a comment names, and the parent author on a reply.
 *
 * Best effort by design: a comment that is already committed must not fail
 * because the notification insert did, and the author gets no notification for
 * their own comment.
 */
async function notifyMentionsAndReply(input: {
    context: CommentContext;
    comment: TransactionComment;
    parentAuthorId: number | null;
}): Promise<void> {
    const { context, comment, parentAuthorId } = input;
    try {
        const members = await bookMembers(context.bookGuid);
        const targets = new Map<number, 'mention' | 'reply'>();
        if (parentAuthorId !== null && parentAuthorId !== context.viewer.userId) {
            targets.set(parentAuthorId, 'reply');
        }
        for (const member of resolveMentionedMembers(comment.body, members, {
            excludeUserId: context.viewer.userId,
        })) {
            targets.set(member.id, 'mention');
        }

        const preview = comment.body.length > 140 ? `${comment.body.slice(0, 137)}…` : comment.body;
        for (const [userId, kind] of targets) {
            await createNotification({
                userId,
                bookGuid: context.bookGuid,
                type: 'transaction_comment',
                severity: 'info',
                title: kind === 'mention'
                    ? `${comment.author.displayName} mentioned you on a transaction`
                    : `${comment.author.displayName} replied to your comment`,
                message: preview,
                href: `/ledger?transaction=${comment.txnGuid}`,
                source: 'transaction_comment',
                sourceId: String(comment.id),
            });
        }
    } catch (error) {
        console.warn('Transaction comment notification failed:', error);
    }
}

export interface CreateCommentInput {
    txnGuid: string;
    body: string;
    parentId?: number | null;
    auditId?: number | null;
}

/**
 * Add a comment or a reply.
 *
 * Replies are one level deep: replying to a reply attaches to that reply's
 * thread root instead of nesting further, so a thread never becomes a tree the
 * feed cannot render.
 */
export async function createTransactionComment(
    input: CreateCommentInput,
    context: CommentContext,
): Promise<TransactionComment> {
    await requireTransactionInBook(input.txnGuid, context);

    let parentId: number | null = null;
    let parentAuthorId: number | null = null;
    if (input.parentId !== null && input.parentId !== undefined) {
        const parent = await loadComment(input.parentId, context);
        if (parent.txn_guid !== input.txnGuid) {
            throw new CommentAccessError('Parent comment belongs to another transaction', 404);
        }
        parentId = parent.parent_id ?? parent.id;
        parentAuthorId = parent.user_id;
    }

    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
        INSERT INTO gnucash_web_transaction_comments
            (entity_type, txn_guid, book_root_guid, user_id, parent_id, audit_id, body)
        VALUES ('transaction', ${input.txnGuid}, ${context.bookRootGuid}, ${context.viewer.userId},
                ${parentId}, ${input.auditId ?? null}, ${input.body})
        RETURNING id
    `;
    const created = toComment(await loadComment(rows[0].id, context));
    await notifyMentionsAndReply({ context, comment: created, parentAuthorId });
    return created;
}

/** Edit a comment's body. Authors only — see `canEditComment`. */
export async function updateTransactionComment(
    id: number,
    body: string,
    context: CommentContext,
): Promise<TransactionComment> {
    const existing = await loadComment(id, context);
    await requireTransactionInBook(existing.txn_guid, context);
    if (!canEditComment(context.viewer, toComment(existing))) {
        throw new CommentAccessError('Only the author can edit a comment', 403);
    }
    await prisma.$executeRaw`
        UPDATE gnucash_web_transaction_comments
        SET body = ${body}, edited_at = NOW()
        WHERE id = ${id} AND book_root_guid = ${context.bookRootGuid}
    `;
    return toComment(await loadComment(id, context));
}

/**
 * Resolve or reopen a thread.
 *
 * Only the root carries the flag, so resolving from a reply resolves the
 * thread it belongs to rather than half of it. Any editor may resolve — the
 * question a thread asks is usually answered by someone other than the asker.
 */
export async function setThreadResolved(
    id: number,
    resolved: boolean,
    context: CommentContext,
): Promise<TransactionComment> {
    const existing = await loadComment(id, context);
    await requireTransactionInBook(existing.txn_guid, context);
    const rootId = existing.parent_id ?? existing.id;
    await prisma.$executeRaw`
        UPDATE gnucash_web_transaction_comments
        SET resolved = ${resolved}
        WHERE id = ${rootId} AND book_root_guid = ${context.bookRootGuid}
    `;
    return toComment(await loadComment(rootId, context));
}

/** Soft-delete: authors delete their own, admins delete any. */
export async function deleteTransactionComment(
    id: number,
    context: CommentContext,
): Promise<TransactionComment> {
    const existing = await loadComment(id, context);
    await requireTransactionInBook(existing.txn_guid, context);
    if (!canDeleteComment(context.viewer, toComment(existing))) {
        throw new CommentAccessError('Only the author or an admin can delete a comment', 403);
    }
    await prisma.$executeRaw`
        UPDATE gnucash_web_transaction_comments
        SET deleted_at = NOW()
        WHERE id = ${id} AND book_root_guid = ${context.bookRootGuid}
    `;
    return toComment(await loadComment(id, context));
}
