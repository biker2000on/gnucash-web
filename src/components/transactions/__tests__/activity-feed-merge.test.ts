/**
 * The interleaving rule for the transaction activity feed.
 *
 * Pure merge logic, exercised without rendering: a comment left on a specific
 * audit entry is pinned under that entry, everything else sorts by time.
 */

import { describe, expect, it } from 'vitest';
import { buildActivityFeed } from '../TransactionActivityFeed';
import type { CommentThread } from '@/lib/transaction-comments';
import type { HistoryEvent } from '@/lib/transaction-history';

const TX = 't'.repeat(32);

function event(auditId: number, at: string): HistoryEvent {
    return {
        auditId,
        at,
        actor: { kind: 'user', id: '7', label: 'Justin' },
        kind: 'updated',
        entityType: 'TRANSACTION',
        entityGuid: TX,
        summary: `Justin changed amount (#${auditId})`,
        changes: [],
        undone: false,
    };
}

function thread(id: number, at: string, auditId: number | null = null): CommentThread {
    return {
        id,
        txnGuid: TX,
        parentId: null,
        auditId,
        author: { id: 7, username: 'justin', displayName: 'Justin' },
        body: `comment ${id}`,
        resolved: false,
        createdAt: at,
        editedAt: null,
        deleted: false,
        replies: [],
    };
}

describe('buildActivityFeed', () => {
    it('orders events and free-standing threads by time, oldest first', () => {
        const feed = buildActivityFeed(
            [event(1, '2026-08-19T10:00:00.000Z'), event(2, '2026-08-19T14:00:00.000Z')],
            [thread(5, '2026-08-19T12:00:00.000Z')],
        );
        expect(feed.map(item => item.key)).toEqual(['event-1', 'thread-5', 'event-2']);
    });

    it('pins a comment about a change directly under that change', () => {
        const feed = buildActivityFeed(
            [event(1, '2026-08-19T10:00:00.000Z'), event(2, '2026-08-19T14:00:00.000Z')],
            [thread(5, '2026-08-20T09:00:00.000Z', 1)],
        );
        expect(feed.map(item => item.key)).toEqual(['event-1', 'event-2']);
        const first = feed[0];
        expect(first.kind === 'event' && first.pinned.map(pinned => pinned.id)).toEqual([5]);
    });

    it('floats a comment whose audit entry is not in the visible history', () => {
        // The history query is capped; a comment must never disappear because
        // the entry it answers fell outside that window.
        const feed = buildActivityFeed(
            [event(1, '2026-08-19T10:00:00.000Z')],
            [thread(5, '2026-08-20T09:00:00.000Z', 999)],
        );
        expect(feed.map(item => item.key)).toEqual(['event-1', 'thread-5']);
    });

    it('handles a transaction with no history and no comments', () => {
        expect(buildActivityFeed([], [])).toEqual([]);
    });

    it('breaks a same-timestamp tie deterministically', () => {
        const at = '2026-08-19T10:00:00.000Z';
        const feed = buildActivityFeed([event(2, at), event(1, at)], [thread(5, at)]);
        expect(feed.map(item => item.key)).toEqual(['event-1', 'event-2', 'thread-5']);
    });
});
