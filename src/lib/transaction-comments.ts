/**
 * Transaction comments — the pure half.
 *
 * Body validation, @-mention parsing, thread assembly and the RBAC predicates
 * live here so they can be unit tested without a database and shared by the
 * API route, the service and the client feed. Everything that touches the
 * `gnucash_web_transaction_comments` table lives in
 * `src/lib/services/transaction-comments.service.ts`.
 *
 * Comments are NOT the GnuCash note. The note round-trips to the desktop app
 * and stays the bookkeeping description; a comment is app-side discussion with
 * an author, a timestamp and a thread, and never touches the GnuCash schema.
 */

/** Bodies longer than this are rejected rather than silently truncated. */
export const MAX_COMMENT_LENGTH = 4000;

/** What a soft-deleted comment renders as — the thread shape is preserved. */
export const DELETED_COMMENT_BODY = 'This comment was deleted.';

export interface CommentAuthor {
    id: number | null;
    /** Login name, used for @-mentions. */
    username: string;
    /** Display name when the account has one, else the username. */
    displayName: string;
}

export interface TransactionComment {
    id: number;
    txnGuid: string;
    parentId: number | null;
    /** Audit entry this comment is answering, when it was left on one. */
    auditId: number | null;
    author: CommentAuthor;
    body: string;
    resolved: boolean;
    createdAt: string;
    editedAt: string | null;
    deleted: boolean;
}

export interface CommentThread extends TransactionComment {
    replies: TransactionComment[];
}

/**
 * `@name` where the name is a username: letters, digits, dot, dash,
 * underscore. Deliberately narrow — an email address in a comment body
 * ("mail bob@example.com") must not read as a mention of `example`, which is
 * why the pattern requires a boundary that is not part of a word before the
 * `@`.
 */
const MENTION_PATTERN = /(^|[^\w@.-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;

/** Usernames mentioned in a body, lower-cased and de-duplicated, in order. */
export function parseMentions(body: string): string[] {
    const seen = new Set<string>();
    const found: string[] = [];
    for (const match of body.matchAll(MENTION_PATTERN)) {
        // A trailing dot/dash is punctuation, not part of the name.
        const name = match[2].replace(/[._-]+$/, '').toLowerCase();
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        found.push(name);
    }
    return found;
}

/**
 * Intersect a body's mentions with the book's members.
 *
 * Only members are returned: mentioning someone with no access to the book
 * must not notify them about a transaction they cannot open, and must not
 * confirm to the author that the account exists.
 */
export function resolveMentionedMembers<T extends { id: number; username: string }>(
    body: string,
    members: readonly T[],
    options?: { excludeUserId?: number | null },
): T[] {
    const mentioned = new Set(parseMentions(body));
    if (mentioned.size === 0) return [];
    return members.filter(
        member =>
            mentioned.has(member.username.toLowerCase())
            && member.id !== options?.excludeUserId,
    );
}

export interface CommentValidation {
    ok: boolean;
    /** Trimmed body, present only when `ok`. */
    value?: string;
    /** Zod-shaped issues so the route can hand them to `validationErrorResponse`. */
    issues: Array<{ path: string[]; message: string }>;
}

/** Validate a comment body: non-empty after trimming, within the length cap. */
export function validateCommentBody(raw: unknown): CommentValidation {
    if (typeof raw !== 'string') {
        return { ok: false, issues: [{ path: ['body'], message: 'A comment body is required' }] };
    }
    const value = raw.trim();
    if (value === '') {
        return { ok: false, issues: [{ path: ['body'], message: 'A comment cannot be empty' }] };
    }
    if (value.length > MAX_COMMENT_LENGTH) {
        return {
            ok: false,
            issues: [{
                path: ['body'],
                message: `A comment cannot exceed ${MAX_COMMENT_LENGTH} characters (received ${value.length})`,
            }],
        };
    }
    return { ok: true, value, issues: [] };
}

/**
 * Assemble flat rows into threads: roots in creation order, each with its
 * replies in creation order.
 *
 * Replies are one level deep by construction — a reply to a reply is re-parented
 * onto the thread root when it is written — but a row that points at a missing
 * or already-deleted parent is still possible (a hard delete in the database,
 * a partial page). Such orphans surface as roots rather than vanishing:
 * silently dropping a user's comment is the worse failure.
 */
export function buildCommentThreads(comments: readonly TransactionComment[]): CommentThread[] {
    const byId = new Map(comments.map(comment => [comment.id, comment]));
    const threads = new Map<number, CommentThread>();
    const ordered = [...comments].sort((a, b) =>
        a.createdAt === b.createdAt ? a.id - b.id : a.createdAt.localeCompare(b.createdAt));

    for (const comment of ordered) {
        if (comment.parentId === null || !byId.has(comment.parentId)) {
            threads.set(comment.id, { ...comment, replies: [] });
        }
    }
    for (const comment of ordered) {
        if (comment.parentId === null) continue;
        const thread = threads.get(comment.parentId);
        if (thread) thread.replies.push(comment);
    }
    return [...threads.values()];
}

export interface CommentViewer {
    userId: number;
    role: 'readonly' | 'edit' | 'admin' | 'timekeeper';
}

/** Only the author edits their own words — an admin may delete, never rewrite. */
export function canEditComment(viewer: CommentViewer, comment: Pick<TransactionComment, 'author' | 'deleted'>): boolean {
    if (comment.deleted) return false;
    return comment.author.id !== null && comment.author.id === viewer.userId;
}

/** Authors delete their own; admins delete any. */
export function canDeleteComment(viewer: CommentViewer, comment: Pick<TransactionComment, 'author' | 'deleted'>): boolean {
    if (comment.deleted) return false;
    if (viewer.role === 'admin') return true;
    return comment.author.id !== null && comment.author.id === viewer.userId;
}

/** Unresolved thread roots, oldest first — what the Action Center raises. */
export function unresolvedThreads(threads: readonly CommentThread[]): CommentThread[] {
    return threads.filter(thread => !thread.resolved && !thread.deleted);
}
