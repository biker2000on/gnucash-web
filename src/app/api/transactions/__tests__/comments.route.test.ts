/**
 * Route behaviour for the transaction-comment endpoints.
 *
 * The service is mocked here — its own tests cover the SQL. What is asserted
 * is what the routes are responsible for: that a combined edit+resolve PATCH
 * is ONE database transaction and answers with the edited comment, that a bad
 * `auditId` becomes a named-field 400 rather than a 500, and that the batched
 * count endpoint rejects anything that is not a guid before querying.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    publishDataChangeMock,
    serviceMock,
    CommentAccessError,
} = vi.hoisted(() => ({
    prismaMock: { $transaction: vi.fn() },
    requireRoleMock: vi.fn(),
    publishDataChangeMock: vi.fn(),
    serviceMock: {
        buildCommentContext: vi.fn(),
        commentCountsForTransactions: vi.fn(),
        createTransactionComment: vi.fn(),
        deleteTransactionComment: vi.fn(),
        listTransactionComments: vi.fn(),
        setThreadResolved: vi.fn(),
        updateTransactionComment: vi.fn(),
    },
    // Stand-in for the real class: the routes branch on `instanceof`, so the
    // one the module under test imports must be the one the mocks throw.
    CommentAccessError: class CommentAccessError extends Error {
        status: 400 | 403 | 404;
        field?: string;
        constructor(message: string, status: 400 | 403 | 404, field?: string) {
            super(message);
            this.name = 'CommentAccessError';
            this.status = status;
            this.field = field;
        }
    },
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: publishDataChangeMock }));
vi.mock('@/lib/services/transaction-comments.service', () => ({
    ...serviceMock,
    CommentAccessError,
    MAX_COMMENTS_PER_TRANSACTION: 200,
}));

import { PATCH } from '../[guid]/comments/[id]/route';
import { GET, POST } from '../[guid]/comments/route';
import { POST as COUNTS } from '../comment-counts/route';

const TX = 't'.repeat(32);
const OTHER_TX = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const CONTEXT = {
    bookGuid: 'b'.repeat(32),
    bookRootGuid: 'r'.repeat(32),
    bookAccountGuids: ['1'.repeat(32)],
    viewer: { userId: 7, role: 'edit' as const },
};

const params = <T extends Record<string, string>>(extra?: T) =>
    ({ params: Promise.resolve({ guid: TX, ...(extra ?? ({} as T)) }) });

function patchRequest(body: unknown): Request {
    return new Request('http://test/api/transactions/x/comments/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const comment = (overrides: Record<string, unknown> = {}) => ({
    id: 5, txnGuid: TX, parentId: 1, body: 'edited', resolved: false, ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ user: { id: 7 }, role: 'edit', bookGuid: CONTEXT.bookGuid });
    serviceMock.buildCommentContext.mockResolvedValue(CONTEXT);
    // Run the interactive-transaction callback against the same mocked client.
    prismaMock.$transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run(prismaMock));
});

describe('PATCH body + resolved (M5)', () => {
    it('runs both legs inside ONE database transaction', async () => {
        serviceMock.updateTransactionComment.mockResolvedValue(comment());
        serviceMock.setThreadResolved.mockResolvedValue(comment({ id: 1, parentId: null, body: 'root', resolved: true }));

        await PATCH(patchRequest({ body: 'edited', resolved: true }), params({ id: '5' }));

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        // Both service calls received the transaction client, not the base one.
        expect(serviceMock.updateTransactionComment).toHaveBeenCalledWith(TX, 5, 'edited', CONTEXT, prismaMock);
        expect(serviceMock.setThreadResolved).toHaveBeenCalledWith(TX, 5, true, CONTEXT, prismaMock);
    });

    it('answers with the EDITED comment, not the thread root', async () => {
        serviceMock.updateTransactionComment.mockResolvedValue(comment());
        serviceMock.setThreadResolved.mockResolvedValue(comment({ id: 1, parentId: null, body: 'root', resolved: true }));

        const response = await PATCH(patchRequest({ body: 'edited', resolved: true }), params({ id: '5' }));
        const payload = await response.json();

        expect(payload).toMatchObject({ id: 5, body: 'edited', threadResolved: true });
    });

    it('leaves no partial write when the second leg fails', async () => {
        serviceMock.updateTransactionComment.mockResolvedValue(comment());
        serviceMock.setThreadResolved.mockRejectedValue(new CommentAccessError('This thread has been deleted', 403));
        // A real interactive transaction rolls back on a thrown callback; the
        // mock reproduces the propagation the route depends on.
        prismaMock.$transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run(prismaMock));

        const response = await PATCH(patchRequest({ body: 'edited', resolved: true }), params({ id: '5' }));

        expect(response.status).toBe(403);
        // The edit was issued only against the transaction client, so the
        // rollback takes it with the failed resolve.
        expect(serviceMock.updateTransactionComment).toHaveBeenCalledWith(TX, 5, 'edited', CONTEXT, prismaMock);
        expect(publishDataChangeMock).not.toHaveBeenCalled();
    });

    it('still answers with the thread root for a resolve-only PATCH', async () => {
        serviceMock.setThreadResolved.mockResolvedValue(comment({ id: 1, parentId: null, body: 'root', resolved: true }));
        const response = await PATCH(patchRequest({ resolved: true }), params({ id: '5' }));
        expect(await response.json()).toMatchObject({ id: 1, threadResolved: true });
        expect(serviceMock.updateTransactionComment).not.toHaveBeenCalled();
    });

    it('passes the URL transaction guid through so the service can own-check it (CODEX-9)', async () => {
        serviceMock.updateTransactionComment.mockRejectedValue(new CommentAccessError('Comment not found', 404));
        const response = await PATCH(patchRequest({ body: 'x' }), params({ id: '5' }));
        expect(response.status).toBe(404);
    });
});

describe('POST auditId (M6)', () => {
    it('answers 400 with the named field, never a raw 500', async () => {
        serviceMock.createTransactionComment.mockRejectedValue(
            new CommentAccessError('auditId must reference a change to this transaction', 400, 'auditId'),
        );
        const request = new Request('http://test/x', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'hi', auditId: 12345 }),
        });
        const response = await POST(request, params());
        expect(response.status).toBe(400);
        const payload = await response.json();
        expect(payload.error).toContain('auditId');
        expect(payload.errors[0].path).toEqual(['auditId']);
    });
});

describe('GET comments (CODEX-6b)', () => {
    it('reports the window the service returned', async () => {
        serviceMock.listTransactionComments.mockResolvedValue({ threads: [], hasMore: true });
        const response = await GET(new Request('http://test/x'), params());
        expect(await response.json()).toMatchObject({ threads: [], hasMore: true, limit: 200 });
    });
});

describe('POST comment-counts guid validation (CODEX-6a)', () => {
    const countsRequest = (txnGuids: unknown) => new Request('http://test/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txnGuids }),
    });

    it('rejects an element that is not a 32-char lowercase hex guid', async () => {
        for (const bad of [['not-a-guid'], [TX.toUpperCase()], ['x'.repeat(32)], [123], [null], ['a'.repeat(31)]]) {
            const response = await COUNTS(countsRequest(bad));
            expect(response.status).toBe(400);
            expect(serviceMock.commentCountsForTransactions).not.toHaveBeenCalled();
        }
    });

    it('names the offending index', async () => {
        const response = await COUNTS(countsRequest([OTHER_TX, 'nope']));
        const payload = await response.json();
        expect(payload.errors[0].path).toEqual(['txnGuids', 1]);
    });

    it('queries once every element is a guid', async () => {
        serviceMock.commentCountsForTransactions.mockResolvedValue({ [OTHER_TX]: 2 });
        const response = await COUNTS(countsRequest([OTHER_TX, OTHER_TX]));
        expect(response.status).toBe(200);
        // Deduped before the query.
        expect(serviceMock.commentCountsForTransactions).toHaveBeenCalledWith([OTHER_TX], CONTEXT);
        expect(await response.json()).toEqual({ counts: { [OTHER_TX]: 2 } });
    });
});
