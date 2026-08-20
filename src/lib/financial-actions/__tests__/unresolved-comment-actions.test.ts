/**
 * Action Center source: unresolved transaction comment threads.
 *
 * The comments service is mocked (it is exercised by its own suite); what is
 * asserted here is the adapter contract — book resolution, stable keys,
 * severity, evidence and the operations the Action Center renders.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueBook = vi.hoisted(() => vi.fn());
const listUnresolvedThreads = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ default: { books: { findUnique: findUniqueBook } } }));
vi.mock('@/lib/services/transaction-comments.service', () => ({ listUnresolvedThreads }));

import { unresolvedCommentActions } from '../sources';

const BOOK = 'b'.repeat(32);
const ROOT = 'r'.repeat(32);
const TX = 't'.repeat(32);

function thread(overrides: Record<string, unknown> = {}) {
    return {
        id: 12,
        txnGuid: TX,
        body: 'Asked the vendor for a corrected invoice.',
        createdAt: new Date('2026-08-19T14:02:00.000Z'),
        authorName: 'Justin',
        replyCount: 0,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    findUniqueBook.mockResolvedValue({ root_account_guid: ROOT });
    listUnresolvedThreads.mockResolvedValue([]);
});

describe('unresolvedCommentActions', () => {
    it('reads threads under the book root, not the book guid', async () => {
        await unresolvedCommentActions(BOOK);
        expect(listUnresolvedThreads).toHaveBeenCalledWith(ROOT);
    });

    it('returns nothing for a book that no longer exists', async () => {
        findUniqueBook.mockResolvedValue(null);
        expect(await unresolvedCommentActions(BOOK)).toEqual([]);
        expect(listUnresolvedThreads).not.toHaveBeenCalled();
    });

    it('raises one action per open thread, keyed by comment id', async () => {
        listUnresolvedThreads.mockResolvedValue([thread(), thread({ id: 13 })]);
        const actions = await unresolvedCommentActions(BOOK);
        expect(actions.map(action => action.stableKey))
            .toEqual(['transaction-comment:12', 'transaction-comment:13']);
        expect(actions[0].origin).toBe('comment');
        expect(actions[0].lane).toBe('decide');
        expect(actions[0].title).toBe('Unresolved comment from Justin');
    });

    it('treats an answered-but-still-open thread as more urgent', async () => {
        listUnresolvedThreads.mockResolvedValue([thread({ replyCount: 2 })]);
        const [action] = await unresolvedCommentActions(BOOK);
        expect(action.severity).toBe('warning');
        expect(action.summary).toContain('2 replies');
    });

    it('stays informational while nobody has replied', async () => {
        listUnresolvedThreads.mockResolvedValue([thread()]);
        const [action] = await unresolvedCommentActions(BOOK);
        expect(action.severity).toBe('info');
        expect(action.summary).toContain('no reply yet');
    });

    it('links to the transaction and offers a resolve operation', async () => {
        listUnresolvedThreads.mockResolvedValue([thread()]);
        const [action] = await unresolvedCommentActions(BOOK);
        expect(action.operations).toEqual([
            { id: 'open', label: 'Open transaction', kind: 'link', href: `/ledger?transaction=${TX}`, primary: true },
            { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
        ]);
    });

    it('carries both the comment and the transaction as evidence', async () => {
        listUnresolvedThreads.mockResolvedValue([thread()]);
        const [action] = await unresolvedCommentActions(BOOK);
        expect(action.trace.evidence.map(item => item.kind)).toEqual(['comment', 'transaction']);
        expect(action.trace.evidence.map(item => item.id)).toEqual(['12', TX]);
    });

    it('truncates a long body in the summary rather than flooding the card', async () => {
        listUnresolvedThreads.mockResolvedValue([thread({ body: 'x'.repeat(400) })]);
        const [action] = await unresolvedCommentActions(BOOK);
        expect(action.summary).toContain('…');
        expect(action.summary.length).toBeLessThan(200);
    });

    it('records the thread identity in metadata for the drill-down', async () => {
        listUnresolvedThreads.mockResolvedValue([thread({ replyCount: 1 })]);
        const [action] = await unresolvedCommentActions(BOOK);
        expect(action.metadata).toEqual({ commentId: 12, txnGuid: TX, replyCount: 1 });
    });
});
