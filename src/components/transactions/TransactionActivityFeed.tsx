'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import { Tip } from '@/components/ui/Tooltip';
import { TEXTAREA, inputClass } from '@/components/ui/form';
import { extractErrorMessage } from '@/lib/api-error';
import { MAX_COMMENT_LENGTH, type CommentThread, type TransactionComment } from '@/lib/transaction-comments';
import type { HistoryEvent } from '@/lib/transaction-history';

/**
 * The Zoho-style activity feed for one transaction: change history and
 * comment threads in a single chronological stream, with a composer.
 *
 * The two halves come from two endpoints and are merged here rather than on
 * the server, because a comment that answers a specific change is pinned under
 * that change (`auditId`) instead of floating at its own timestamp — a
 * placement rule about presentation, not about the data.
 */

interface Viewer {
    userId: number;
    role: 'readonly' | 'edit' | 'admin' | 'timekeeper';
}

type FeedItem =
    | { kind: 'event'; at: string; key: string; event: HistoryEvent; pinned: CommentThread[] }
    | { kind: 'thread'; at: string; key: string; thread: CommentThread };

/**
 * Merge events and threads into one stream.
 *
 * A thread that names an audit entry we are rendering is pinned under it; the
 * rest sort by their own timestamp. Newest last, so the composer at the bottom
 * continues the conversation in reading order.
 */
export function buildActivityFeed(events: HistoryEvent[], threads: CommentThread[]): FeedItem[] {
    const eventIds = new Set(events.map(event => event.auditId));
    const pinnedByAudit = new Map<number, CommentThread[]>();
    const floating: CommentThread[] = [];
    for (const thread of threads) {
        if (thread.auditId !== null && eventIds.has(thread.auditId)) {
            const list = pinnedByAudit.get(thread.auditId) ?? [];
            list.push(thread);
            pinnedByAudit.set(thread.auditId, list);
        } else {
            floating.push(thread);
        }
    }

    const items: FeedItem[] = [
        ...events.map((event): FeedItem => ({
            kind: 'event',
            at: event.at,
            key: `event-${event.auditId}`,
            event,
            pinned: pinnedByAudit.get(event.auditId) ?? [],
        })),
        ...floating.map((thread): FeedItem => ({
            kind: 'thread',
            at: thread.createdAt,
            key: `thread-${thread.id}`,
            thread,
        })),
    ];
    return items.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at.localeCompare(b.at)));
}

function formatTimestamp(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

/** `@name` renders as an accent chip so a mention is visible in the body. */
function CommentBody({ body }: { body: string }) {
    const parts = body.split(/(@[A-Za-z0-9][A-Za-z0-9._-]{0,63})/g);
    return (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {parts.map((part, index) =>
                part.startsWith('@')
                    ? <span key={index} className="font-medium text-primary">{part}</span>
                    : <span key={index}>{part}</span>)}
        </p>
    );
}

export function TransactionActivityFeed({
    transactionGuid,
    className,
}: {
    transactionGuid: string;
    className?: string;
}) {
    const [events, setEvents] = useState<HistoryEvent[]>([]);
    const [threads, setThreads] = useState<CommentThread[]>([]);
    const [viewer, setViewer] = useState<Viewer | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [replyTo, setReplyTo] = useState<number | null>(null);
    const [replyDraft, setReplyDraft] = useState('');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editDraft, setEditDraft] = useState('');
    const [busy, setBusy] = useState(false);
    // Guards a slow first load from overwriting a newer transaction's data.
    const requestedGuid = useRef(transactionGuid);

    const readJson = useCallback(async (response: Response, fallback: string) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(extractErrorMessage(body, fallback));
        return body;
    }, []);

    const load = useCallback(async () => {
        requestedGuid.current = transactionGuid;
        setLoading(true);
        setError(null);
        try {
            const [historyResponse, commentsResponse] = await Promise.all([
                fetch(`/api/transactions/${transactionGuid}/history`),
                fetch(`/api/transactions/${transactionGuid}/comments`),
            ]);
            const history = await readJson(historyResponse, 'Failed to load transaction history');
            const comments = await readJson(commentsResponse, 'Failed to load comments');
            if (requestedGuid.current !== transactionGuid) return;
            setEvents(history.events ?? []);
            setThreads(comments.threads ?? []);
            setViewer(comments.viewer ?? null);
        } catch (err) {
            if (requestedGuid.current !== transactionGuid) return;
            setError(err instanceof Error ? err.message : 'Failed to load activity');
        } finally {
            if (requestedGuid.current === transactionGuid) setLoading(false);
        }
    }, [transactionGuid, readJson]);

    useEffect(() => {
        void load();
    }, [load]);

    const mutate = useCallback(async (
        run: () => Promise<Response>,
        fallback: string,
    ): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
            await readJson(await run(), fallback);
            await load();
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : fallback);
            return false;
        } finally {
            setBusy(false);
        }
    }, [load, readJson]);

    const post = useCallback(async (body: string, parentId: number | null) => {
        const ok = await mutate(
            () => fetch(`/api/transactions/${transactionGuid}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body, parentId }),
            }),
            'Failed to post comment',
        );
        if (!ok) return;
        if (parentId === null) setDraft('');
        else {
            setReplyDraft('');
            setReplyTo(null);
        }
    }, [mutate, transactionGuid]);

    const saveEdit = useCallback(async (id: number, body: string) => {
        const ok = await mutate(
            () => fetch(`/api/transactions/${transactionGuid}/comments/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body }),
            }),
            'Failed to save comment',
        );
        if (ok) setEditingId(null);
    }, [mutate, transactionGuid]);

    const setResolved = useCallback((id: number, resolved: boolean) => mutate(
        () => fetch(`/api/transactions/${transactionGuid}/comments/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved }),
        }),
        resolved ? 'Failed to resolve thread' : 'Failed to reopen thread',
    ), [mutate, transactionGuid]);

    const remove = useCallback((id: number) => mutate(
        () => fetch(`/api/transactions/${transactionGuid}/comments/${id}`, { method: 'DELETE' }),
        'Failed to delete comment',
    ), [mutate, transactionGuid]);

    const feed = useMemo(() => buildActivityFeed(events, threads), [events, threads]);
    const canComment = viewer !== null && (viewer.role === 'edit' || viewer.role === 'admin');

    const canEdit = (comment: TransactionComment) =>
        !comment.deleted && viewer !== null && comment.author.id === viewer.userId;
    const canDelete = (comment: TransactionComment) =>
        !comment.deleted && viewer !== null
        && (viewer.role === 'admin' || comment.author.id === viewer.userId);

    const renderComment = (comment: TransactionComment, isRoot: boolean, thread: CommentThread) => (
        <div key={comment.id} className={isRoot ? '' : 'ml-6 border-l border-border pl-3'}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground">{comment.author.displayName}</span>
                <span className="font-mono text-xs text-foreground-muted">{formatTimestamp(comment.createdAt)}</span>
                {comment.editedAt && <span className="text-xs text-foreground-muted">(edited)</span>}
                {isRoot && thread.resolved && (
                    <span className="rounded-sm border border-success/40 px-1.5 py-0.5 text-xs text-success">Resolved</span>
                )}
            </div>

            {editingId === comment.id ? (
                <div className="mt-2 space-y-2">
                    <label className="sr-only" htmlFor={`edit-comment-${comment.id}`}>Edit comment</label>
                    <textarea
                        id={`edit-comment-${comment.id}`}
                        className={inputClass({ base: TEXTAREA })}
                        rows={3}
                        maxLength={MAX_COMMENT_LENGTH}
                        value={editDraft}
                        onChange={event => setEditDraft(event.target.value)}
                    />
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy || editDraft.trim() === ''}
                            onClick={() => void saveEdit(comment.id, editDraft)}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
                        >
                            Save
                        </button>
                        <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground-secondary transition-colors hover:bg-surface-hover"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <div className="mt-1">
                    {comment.deleted
                        ? <p className="text-sm italic text-foreground-muted">{comment.body}</p>
                        : <CommentBody body={comment.body} />}
                </div>
            )}

            {editingId !== comment.id && (
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-foreground-muted">
                    {canComment && isRoot && !comment.deleted && (
                        <button
                            type="button"
                            className="transition-colors hover:text-foreground"
                            onClick={() => { setReplyTo(comment.id); setReplyDraft(''); }}
                        >
                            Reply
                        </button>
                    )}
                    {canEdit(comment) && (
                        <button
                            type="button"
                            className="transition-colors hover:text-foreground"
                            onClick={() => { setEditingId(comment.id); setEditDraft(comment.body); }}
                        >
                            Edit
                        </button>
                    )}
                    {canDelete(comment) && (
                        <button
                            type="button"
                            disabled={busy}
                            className="transition-colors hover:text-error disabled:opacity-50"
                            onClick={() => void remove(comment.id)}
                        >
                            Delete
                        </button>
                    )}
                    {canComment && isRoot && !comment.deleted && (
                        <Tip content={thread.resolved
                            ? 'Reopen this thread so it returns to the Action Center'
                            : 'Close this thread and clear it from the Action Center'}>
                            <button
                                type="button"
                                disabled={busy}
                                className="transition-colors hover:text-foreground disabled:opacity-50"
                                onClick={() => void setResolved(comment.id, !thread.resolved)}
                            >
                                {thread.resolved ? 'Reopen' : 'Resolve'}
                            </button>
                        </Tip>
                    )}
                </div>
            )}
        </div>
    );

    const renderThread = (thread: CommentThread) => (
        <div
            key={`thread-${thread.id}`}
            className={`rounded-lg border p-3 ${thread.resolved ? 'border-border bg-background-secondary/40' : 'border-border bg-surface'}`}
        >
            <div className="space-y-3">
                {renderComment(thread, true, thread)}
                {thread.replies.map(reply => renderComment(reply, false, thread))}
            </div>
            {replyTo === thread.id && (
                <div className="mt-3 space-y-2">
                    <label className="sr-only" htmlFor={`reply-${thread.id}`}>Reply to this comment</label>
                    <textarea
                        id={`reply-${thread.id}`}
                        className={inputClass({ base: TEXTAREA })}
                        rows={2}
                        maxLength={MAX_COMMENT_LENGTH}
                        placeholder="Reply… use @name to notify a book member"
                        value={replyDraft}
                        onChange={event => setReplyDraft(event.target.value)}
                    />
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy || replyDraft.trim() === ''}
                            onClick={() => void post(replyDraft, thread.id)}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
                        >
                            Reply
                        </button>
                        <button
                            type="button"
                            onClick={() => setReplyTo(null)}
                            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground-secondary transition-colors hover:bg-surface-hover"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );

    return (
        <div className={className}>
            <ErrorLiveRegion message={error} />
            {error && (
                <div className="mb-3 rounded-lg border border-error/30 bg-error/10 p-3">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {loading ? (
                <p className="py-6 text-center text-sm text-foreground-secondary">Loading activity…</p>
            ) : feed.length === 0 ? (
                <p className="py-6 text-center text-sm text-foreground-muted">
                    No recorded changes or comments yet.
                </p>
            ) : (
                <ol className="space-y-3">
                    {feed.map(item => (
                        <li key={item.key} className="space-y-3">
                            {item.kind === 'event' ? (
                                <>
                                    <div className="border-l-2 border-border pl-3">
                                        <div className="flex flex-wrap items-baseline gap-x-2">
                                            <span className="text-sm text-foreground">{item.event.summary}</span>
                                            {item.event.undone && (
                                                <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-foreground-muted">
                                                    undone
                                                </span>
                                            )}
                                        </div>
                                        <span className="font-mono text-xs text-foreground-muted">
                                            {formatTimestamp(item.event.at)}
                                        </span>
                                    </div>
                                    {item.pinned.map(renderThread)}
                                </>
                            ) : (
                                renderThread(item.thread)
                            )}
                        </li>
                    ))}
                </ol>
            )}

            {canComment && (
                <div className="mt-4 space-y-2 border-t border-border pt-4">
                    <label className="sr-only" htmlFor={`comment-${transactionGuid}`}>Add a comment</label>
                    <textarea
                        id={`comment-${transactionGuid}`}
                        className={inputClass({ base: TEXTAREA })}
                        rows={3}
                        maxLength={MAX_COMMENT_LENGTH}
                        placeholder="Add a comment… use @name to notify a book member"
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                    />
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-foreground-muted">
                            Comments stay in this app — they never touch the GnuCash note.
                        </span>
                        <button
                            type="button"
                            disabled={busy || draft.trim() === ''}
                            onClick={() => void post(draft, null)}
                            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
                        >
                            Comment
                        </button>
                    </div>
                </div>
            )}
            {viewer && !canComment && (
                <p className="mt-4 border-t border-border pt-4 text-xs text-foreground-muted">
                    Your role can read this discussion but not add to it.
                </p>
            )}
        </div>
    );
}
