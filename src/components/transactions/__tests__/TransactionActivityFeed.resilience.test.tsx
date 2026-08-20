/**
 * MED-A / MED-C — the feed's two halves are independent, and long ones are
 * windowed.
 *
 * History and comments come from two endpoints. They used to be awaited in
 * sequence, so a history failure (404 on a transaction outside the book, or
 * one deleted while the modal sat open) threw before the comments — already
 * fetched, already fine — were applied: an error banner and no discussion at
 * all, which is exactly when someone most needs to read the discussion.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionActivityFeed } from '../TransactionActivityFeed';

const TX = 't'.repeat(32);

const comment = (id: number, body: string) => ({
    id,
    txnGuid: TX,
    parentId: null,
    auditId: null,
    author: { id: 7, username: 'justin', displayName: 'Justin' },
    body,
    resolved: false,
    createdAt: new Date(Date.UTC(2026, 7, 19, 14, 0, 0) + id * 60_000).toISOString(),
    editedAt: null,
    deleted: false,
    replies: [],
});

const event = (auditId: number) => ({
    auditId,
    // Strictly increasing, so entry N really is newer than entry N-1.
    at: new Date(Date.UTC(2026, 7, 18, 10, 0, 0) + auditId * 60_000).toISOString(),
    actor: { kind: 'user' as const, id: '7', label: 'Justin' },
    kind: 'updated' as const,
    entityType: 'TRANSACTION',
    entityGuid: TX,
    summary: `Justin changed description v${auditId}`,
    changes: [],
    undone: false,
});

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

/** Route each request by URL so the two halves can fail independently. */
function mockFetch(handlers: { history: () => Response; comments: () => Response }) {
    const fetchMock = vi.fn(async (url: string) =>
        url.includes('/history') ? handlers.history() : handlers.comments());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const viewer = { userId: 7, role: 'edit' as const };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('independent load (MED-A)', () => {
    it('renders the discussion even when the history request 404s', async () => {
        mockFetch({
            history: () => jsonResponse({ error: 'Transaction not found' }, 404),
            comments: () => jsonResponse({ threads: [comment(1, 'Is this the May reimbursement?')], viewer }),
        });

        render(<TransactionActivityFeed transactionGuid={TX} />);

        expect(await screen.findByText('Is this the May reimbursement?')).toBeTruthy();
        // The failure is still reported — scoped to the half that failed.
        // (Banner plus the assertive live region, hence `getAllByText`.)
        expect(screen.getAllByText('Transaction not found').length).toBeGreaterThan(0);
    });

    it('renders the change history even when the comments request fails', async () => {
        mockFetch({
            history: () => jsonResponse({ events: [event(1)] }),
            comments: () => jsonResponse({ error: 'Failed to load comments' }, 500),
        });

        render(<TransactionActivityFeed transactionGuid={TX} />);

        expect(await screen.findByText('Justin changed description v1')).toBeTruthy();
        expect(screen.getAllByText('Failed to load comments').length).toBeGreaterThan(0);
    });

    it('shows no banner when both halves land', async () => {
        mockFetch({
            history: () => jsonResponse({ events: [event(1)] }),
            comments: () => jsonResponse({ threads: [comment(1, 'looks right')], viewer }),
        });

        render(<TransactionActivityFeed transactionGuid={TX} />);

        expect(await screen.findByText('looks right')).toBeTruthy();
        expect(screen.queryByText(/Failed to load/)).toBeNull();
    });
});

describe('windowed rendering (MED-C)', () => {
    it('renders the newest entries with a "show earlier" affordance', async () => {
        mockFetch({
            history: () => jsonResponse({ events: Array.from({ length: 60 }, (_, i) => event(i + 1)) }),
            comments: () => jsonResponse({ threads: [], viewer }),
        });

        render(<TransactionActivityFeed transactionGuid={TX} />);

        // Newest is last in reading order, so v60 is rendered and v1 is not.
        expect(await screen.findByText('Justin changed description v60')).toBeTruthy();
        expect(screen.queryByText('Justin changed description v1')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /Show earlier activity \(10 more\)/ }));
        await waitFor(() => expect(screen.getByText('Justin changed description v1')).toBeTruthy());
    });

    it('says so when the server truncated the history rather than truncating silently', async () => {
        mockFetch({
            history: () => jsonResponse({ events: [event(1)], hasMore: true }),
            comments: () => jsonResponse({ threads: [], viewer, hasMore: false }),
        });

        render(<TransactionActivityFeed transactionGuid={TX} />);
        expect(await screen.findByText('Older changes are not shown.')).toBeTruthy();
    });

    it('says so when the server truncated the comments', async () => {
        mockFetch({
            history: () => jsonResponse({ events: [event(1)], hasMore: false }),
            comments: () => jsonResponse({ threads: [comment(1, 'hi')], viewer, hasMore: true }),
        });

        render(<TransactionActivityFeed transactionGuid={TX} />);
        expect(await screen.findByText('Older comments are not shown.')).toBeTruthy();
    });
});
