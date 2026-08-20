/**
 * Transaction comments service.
 *
 * Prisma is mocked with a dispatcher that answers on the SQL text, so every
 * assertion here is about the statements the service actually issues — the
 * book-scoping predicates in particular, which are the security property this
 * module is responsible for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.hoisted(() => vi.fn());
const queryRawUnsafe = vi.hoisted(() => vi.fn());
const executeRaw = vi.hoisted(() => vi.fn());
const findUniqueBook = vi.hoisted(() => vi.fn());
const createNotification = vi.hoisted(() => vi.fn(async () => ({})));
const getAccountGuidsForBook = vi.hoisted(() => vi.fn(async () => ACCOUNTS));

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: queryRaw,
        $queryRawUnsafe: queryRawUnsafe,
        $executeRaw: executeRaw,
        books: { findUnique: findUniqueBook },
    },
}));
vi.mock('@/lib/notifications', () => ({ createNotification }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook }));

const TX = 't'.repeat(32);
const OTHER_TX = 'o'.repeat(32);
const ROOT = 'r'.repeat(32);
const BOOK = 'b'.repeat(32);
const ACCOUNTS = ['1'.repeat(32), '2'.repeat(32)];

import {
    CommentAccessError,
    buildCommentContext,
    commentCountsForTransactions,
    createTransactionComment,
    deleteCommentsForTransaction,
    deleteTransactionComment,
    listTransactionComments,
    setThreadResolved,
    updateTransactionComment,
} from '../transaction-comments.service';

/** Rows the fake `gnucash_web_transaction_comments` table returns, by id. */
const rows = new Map<number, Record<string, unknown>>();

function storedRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        txn_guid: TX,
        parent_id: null,
        audit_id: null,
        user_id: 7,
        username: 'justin',
        display_name: 'Justin',
        body: 'Why did this change?',
        resolved: false,
        created_at: new Date('2026-08-19T14:02:00.000Z'),
        edited_at: null,
        deleted_at: null,
        ...overrides,
    };
}

const context = (role: 'readonly' | 'edit' | 'admin' = 'edit', userId = 7) => ({
    bookGuid: BOOK,
    bookRootGuid: ROOT,
    bookAccountGuids: ACCOUNTS,
    viewer: { userId, role } as const,
});

/** Splits that exist, keyed by transaction guid — drives the book-scope check. */
let splitsByTx: Record<string, boolean> = { [TX]: true };
let members: Array<{ id: number; username: string }> = [];
let insertedId = 99;
let lastInsertValues: unknown[] = [];
/** Audit ids the fake `gnucash_web_audit` table holds for each transaction. */
let auditIdsByTx: Record<string, number[]> = { [TX]: [42] };

function sqlOf(strings: TemplateStringsArray | string): string {
    return typeof strings === 'string' ? strings : strings.join(' ');
}

beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    splitsByTx = { [TX]: true };
    members = [];
    insertedId = 99;
    lastInsertValues = [];
    auditIdsByTx = { [TX]: [42] };
    findUniqueBook.mockResolvedValue({ root_account_guid: ROOT });

    queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlOf(strings);
        if (sql.includes('FROM gnucash_web_audit')) {
            const [auditId, txGuid] = values as [number, string];
            return (auditIdsByTx[txGuid] ?? []).includes(auditId) ? [{ one: 1 }] : [];
        }
        if (sql.includes('FROM splits')) {
            const [txGuid, accountGuids] = values as [string, string[]];
            expect(accountGuids).toEqual(ACCOUNTS);
            return splitsByTx[txGuid] ? [{ one: 1 }] : [];
        }
        if (sql.includes('INSERT INTO gnucash_web_transaction_comments')) {
            lastInsertValues = values;
            const [txGuid, bookRootGuid, userId, parentId, auditId, body] = values as [
                string, string, number, number | null, number | null, string,
            ];
            rows.set(insertedId, storedRow({
                id: insertedId,
                txn_guid: txGuid,
                parent_id: parentId,
                audit_id: auditId,
                user_id: userId,
                body,
            }));
            expect(bookRootGuid).toBe(ROOT);
            return [{ id: insertedId }];
        }
        if (sql.includes('FROM gnucash_web_book_permissions')) return members;
        if (sql.includes('COUNT(*)::bigint AS count')) {
            const [bookRootGuid, entityType, guids] = values as [string, string, string[]];
            expect(bookRootGuid).toBe(ROOT);
            expect(entityType).toBe('transaction');
            return guids.includes(TX) ? [{ txn_guid: TX, count: 3n }] : [];
        }
        return [];
    });

    queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('WHERE c.id = $1')) {
            const [id, bookRootGuid, entityType] = params as [number, string, string];
            expect(bookRootGuid).toBe(ROOT);
            // Every read names the entity type this module owns (L3).
            expect(entityType).toBe('transaction');
            const row = rows.get(id);
            return row ? [row] : [];
        }
        if (sql.includes('WHERE c.txn_guid = $1')) {
            const [txGuid, bookRootGuid, entityType, limit] = params as [string, string, string, number];
            expect(bookRootGuid).toBe(ROOT);
            expect(entityType).toBe('transaction');
            // Newest first, capped at limit+1 so the service can see "more".
            return [...rows.values()]
                .filter(row => row.txn_guid === txGuid)
                .sort((a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime()
                    || (b.id as number) - (a.id as number))
                .slice(0, limit);
        }
        return [];
    });

    executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlOf(strings);
        if (sql.includes('DELETE FROM gnucash_web_transaction_comments')) {
            const [txGuid, bookRootGuid, entityType] = values as [string, string, string];
            expect(bookRootGuid).toBe(ROOT);
            expect(entityType).toBe('transaction');
            let removed = 0;
            for (const [id, row] of [...rows]) {
                if (row.txn_guid === txGuid) { rows.delete(id); removed += 1; }
            }
            return removed;
        }
        const id = values[values.length - 2] as number;
        const bookRootGuid = values[values.length - 1] as string;
        expect(bookRootGuid).toBe(ROOT);
        const row = rows.get(id);
        if (!row) return 0;
        if (sql.includes('SET body')) {
            row.body = values[0];
            row.edited_at = new Date('2026-08-20T09:00:00.000Z');
        } else if (sql.includes('SET resolved')) {
            row.resolved = values[0];
        } else if (sql.includes('SET deleted_at')) {
            row.deleted_at = new Date('2026-08-20T09:00:00.000Z');
        }
        return 1;
    });
});

describe('buildCommentContext', () => {
    it('derives the root guid and account list from the authorized book', async () => {
        const built = await buildCommentContext({ user: { id: 7 }, role: 'edit', bookGuid: BOOK });
        expect(built).toEqual({
            bookGuid: BOOK,
            bookRootGuid: ROOT,
            bookAccountGuids: ACCOUNTS,
            viewer: { userId: 7, role: 'edit' },
        });
        expect(getAccountGuidsForBook).toHaveBeenCalledWith(BOOK);
    });

    it('404s when the authorized book has vanished', async () => {
        findUniqueBook.mockResolvedValue(null);
        await expect(buildCommentContext({ user: { id: 7 }, role: 'edit', bookGuid: BOOK }))
            .rejects.toMatchObject({ status: 404 });
    });
});

describe('book scoping', () => {
    it('reports a transaction from another book as not found', async () => {
        await expect(listTransactionComments(OTHER_TX, context())).rejects.toBeInstanceOf(CommentAccessError);
        await expect(listTransactionComments(OTHER_TX, context())).rejects.toMatchObject({ status: 404 });
    });

    it('refuses to post onto a transaction outside the book', async () => {
        await expect(createTransactionComment({ txnGuid: OTHER_TX, body: 'hi' }, context()))
            .rejects.toMatchObject({ status: 404 });
    });

    it('never treats an empty account list as "the whole database"', async () => {
        await expect(listTransactionComments(TX, { ...context(), bookAccountGuids: [] }))
            .rejects.toMatchObject({ status: 404 });
    });
});

describe('createTransactionComment', () => {
    it('stamps the book root, the author and the transaction', async () => {
        const created = await createTransactionComment({ txnGuid: TX, body: 'Why?' }, context());
        expect(created.id).toBe(99);
        expect(created.author.displayName).toBe('Justin');
        expect(lastInsertValues).toEqual([TX, ROOT, 7, null, null, 'Why?']);
    });

    it('links a comment to the audit entry it answers', async () => {
        await createTransactionComment({ txnGuid: TX, body: 'Why?', auditId: 42 }, context());
        expect(lastInsertValues[4]).toBe(42);
    });

    it('re-parents a reply-to-a-reply onto the thread root', async () => {
        rows.set(1, storedRow({ id: 1 }));
        rows.set(2, storedRow({ id: 2, parent_id: 1, user_id: 9 }));
        await createTransactionComment({ txnGuid: TX, body: 'me too', parentId: 2 }, context());
        expect(lastInsertValues[3]).toBe(1);
    });

    it('rejects a parent that belongs to another transaction', async () => {
        rows.set(1, storedRow({ id: 1, txn_guid: OTHER_TX }));
        await expect(createTransactionComment({ txnGuid: TX, body: 'x', parentId: 1 }, context()))
            .rejects.toMatchObject({ status: 404 });
    });

    it('notifies a mentioned book member, not the author, not a stranger', async () => {
        members = [{ id: 7, username: 'justin' }, { id: 9, username: 'dana' }];
        await createTransactionComment({ txnGuid: TX, body: '@dana @justin @stranger look', }, context());
        expect(createNotification).toHaveBeenCalledTimes(1);
        expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
            userId: 9,
            bookGuid: BOOK,
            type: 'transaction_comment',
        }));
    });

    it('notifies the parent author on a reply', async () => {
        members = [{ id: 7, username: 'justin' }, { id: 9, username: 'dana' }];
        rows.set(1, storedRow({ id: 1, user_id: 9 }));
        await createTransactionComment({ txnGuid: TX, body: 'answered', parentId: 1 }, context());
        expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }));
    });

    it('sends one notification for a member mentioned twice (CODEX-6c)', async () => {
        members = [{ id: 9, username: 'dana' }];
        await createTransactionComment({ txnGuid: TX, body: '@dana and again @dana' }, context());
        expect(createNotification).toHaveBeenCalledTimes(1);
    });

    it('never notifies the author, even for a self-mention on their own reply', async () => {
        members = [{ id: 7, username: 'justin' }];
        rows.set(1, storedRow({ id: 1, user_id: 7 }));
        await createTransactionComment({ txnGuid: TX, body: '@justin note to self', parentId: 1 }, context('edit', 7));
        expect(createNotification).not.toHaveBeenCalled();
    });

    it('collapses a mention of the parent author into the one reply notification', async () => {
        members = [{ id: 9, username: 'dana' }];
        rows.set(1, storedRow({ id: 1, user_id: 9 }));
        await createTransactionComment({ txnGuid: TX, body: '@dana yes', parentId: 1 }, context());
        expect(createNotification).toHaveBeenCalledTimes(1);
    });

    it('does not fail the comment when notification delivery fails', async () => {
        members = [{ id: 9, username: 'dana' }];
        createNotification.mockRejectedValueOnce(new Error('notifications down'));
        await expect(createTransactionComment({ txnGuid: TX, body: '@dana hi' }, context()))
            .resolves.toMatchObject({ id: 99 });
    });
});

describe('updateTransactionComment', () => {
    it('lets the author rewrite their own comment', async () => {
        rows.set(1, storedRow({ id: 1 }));
        const updated = await updateTransactionComment(TX, 1, 'clarified', context('edit', 7));
        expect(updated.body).toBe('clarified');
        expect(updated.editedAt).not.toBeNull();
    });

    it('refuses a non-author, admin included', async () => {
        rows.set(1, storedRow({ id: 1 }));
        await expect(updateTransactionComment(TX, 1, 'nope', context('edit', 9))).rejects.toMatchObject({ status: 403 });
        await expect(updateTransactionComment(TX, 1, 'nope', context('admin', 9))).rejects.toMatchObject({ status: 403 });
    });

    it('404s on a comment from another book', async () => {
        await expect(updateTransactionComment(TX, 1234, 'x', context())).rejects.toMatchObject({ status: 404 });
    });
});

describe('the URL transaction must own the comment (CODEX-9)', () => {
    // /api/transactions/{A}/comments/{id-on-B} used to check only the id, so
    // A's path could rewrite or delete B's comment.
    beforeEach(() => {
        splitsByTx = { [TX]: true, [OTHER_TX]: true };
        rows.set(1, storedRow({ id: 1, txn_guid: OTHER_TX }));
    });

    it('refuses an edit routed through the wrong transaction', async () => {
        await expect(updateTransactionComment(TX, 1, 'hijacked', context('edit', 7)))
            .rejects.toMatchObject({ status: 404 });
        expect(rows.get(1)!.body).toBe('Why did this change?');
    });

    it('refuses a delete routed through the wrong transaction', async () => {
        await expect(deleteTransactionComment(TX, 1, context('admin', 9)))
            .rejects.toMatchObject({ status: 404 });
        expect(rows.get(1)!.deleted_at).toBeNull();
    });

    it('refuses a resolve routed through the wrong transaction', async () => {
        await expect(setThreadResolved(TX, 1, true, context('edit', 9)))
            .rejects.toMatchObject({ status: 404 });
        expect(rows.get(1)!.resolved).toBe(false);
    });

    it('still works through the comment\'s own transaction', async () => {
        await expect(updateTransactionComment(OTHER_TX, 1, 'fine', context('edit', 7)))
            .resolves.toMatchObject({ body: 'fine' });
    });
});

describe('deleteTransactionComment', () => {
    it('soft-deletes and hides the body while keeping the row', async () => {
        rows.set(1, storedRow({ id: 1 }));
        const deleted = await deleteTransactionComment(TX, 1, context('edit', 7));
        expect(deleted.deleted).toBe(true);
        expect(deleted.body).not.toContain('Why did this change?');
        expect(rows.get(1)!.deleted_at).not.toBeNull();
    });

    it('lets an admin delete someone else, but not a plain editor', async () => {
        rows.set(1, storedRow({ id: 1 }));
        await expect(deleteTransactionComment(TX, 1, context('edit', 9))).rejects.toMatchObject({ status: 403 });
        await expect(deleteTransactionComment(TX, 1, context('admin', 9))).resolves.toMatchObject({ deleted: true });
    });
});

describe('setThreadResolved', () => {
    it('resolves the root when called from a reply', async () => {
        rows.set(1, storedRow({ id: 1 }));
        rows.set(2, storedRow({ id: 2, parent_id: 1, user_id: 9 }));
        const thread = await setThreadResolved(TX, 2, true, context('edit', 9));
        expect(thread.id).toBe(1);
        expect(rows.get(1)!.resolved).toBe(true);
        expect(rows.get(2)!.resolved).toBe(false);
    });

    it('reopens a resolved thread', async () => {
        rows.set(1, storedRow({ id: 1, resolved: true }));
        await setThreadResolved(TX, 1, false, context('edit', 9));
        expect(rows.get(1)!.resolved).toBe(false);
    });

    it('refuses a soft-deleted root (L4)', async () => {
        // Resolving a deleted thread would keep raising an Action Center item
        // that opens onto "This comment was deleted."
        rows.set(1, storedRow({ id: 1, deleted_at: new Date('2026-08-20T09:00:00.000Z') }));
        await expect(setThreadResolved(TX, 1, true, context('edit', 9)))
            .rejects.toMatchObject({ status: 403 });
        expect(rows.get(1)!.resolved).toBe(false);
    });

    it('refuses a reply whose thread root was deleted (L4)', async () => {
        rows.set(1, storedRow({ id: 1, deleted_at: new Date('2026-08-20T09:00:00.000Z') }));
        rows.set(2, storedRow({ id: 2, parent_id: 1, user_id: 9 }));
        await expect(setThreadResolved(TX, 2, true, context('edit', 9)))
            .rejects.toMatchObject({ status: 403 });
    });
});

describe('auditId anchoring (M6)', () => {
    it('rejects an audit id that does not exist', async () => {
        await expect(createTransactionComment({ txnGuid: TX, body: 'x', auditId: 12345 }, context()))
            .rejects.toMatchObject({ status: 400, field: 'auditId' });
        expect(lastInsertValues).toEqual([]);
    });

    it('rejects an audit id belonging to another transaction', async () => {
        auditIdsByTx = { [TX]: [42], [OTHER_TX]: [77] };
        await expect(createTransactionComment({ txnGuid: TX, body: 'x', auditId: 77 }, context()))
            .rejects.toMatchObject({ status: 400, field: 'auditId' });
    });

    it('accepts an audit id for this transaction', async () => {
        await expect(createTransactionComment({ txnGuid: TX, body: 'x', auditId: 42 }, context()))
            .resolves.toMatchObject({ id: 99 });
    });
});

describe('deleteCommentsForTransaction (L2)', () => {
    it('hard-deletes every comment on the transaction', async () => {
        rows.set(1, storedRow({ id: 1 }));
        rows.set(2, storedRow({ id: 2, parent_id: 1 }));
        rows.set(3, storedRow({ id: 3, txn_guid: OTHER_TX }));
        const removed = await deleteCommentsForTransaction(TX, ROOT);
        expect(removed).toBe(2);
        expect([...rows.keys()]).toEqual([3]);
    });
});

describe('commentCountsForTransactions', () => {
    it('short-circuits an empty batch without touching the database', async () => {
        expect(await commentCountsForTransactions([], { bookRootGuid: ROOT })).toEqual({});
        expect(queryRaw).not.toHaveBeenCalled();
    });

    it('returns counts as numbers, absent for guids with none', async () => {
        const counts = await commentCountsForTransactions([TX, OTHER_TX], { bookRootGuid: ROOT });
        expect(counts).toEqual({ [TX]: 3 });
    });
});

describe('listTransactionComments', () => {
    it('assembles threads for the transaction', async () => {
        rows.set(1, storedRow({ id: 1 }));
        rows.set(2, storedRow({ id: 2, parent_id: 1, body: 'reply', created_at: new Date('2026-08-19T15:00:00.000Z') }));
        const { threads, hasMore } = await listTransactionComments(TX, context('readonly'));
        expect(threads).toHaveLength(1);
        expect(threads[0].replies.map(reply => reply.body)).toEqual(['reply']);
        expect(hasMore).toBe(false);
    });

    it('caps the window and reports that older comments exist (CODEX-6b)', async () => {
        for (let id = 1; id <= 5; id += 1) {
            rows.set(id, storedRow({
                id,
                body: `comment ${id}`,
                created_at: new Date(Date.UTC(2026, 7, 19, 14, id)),
            }));
        }
        const { threads, hasMore } = await listTransactionComments(TX, context('readonly'), 3);
        expect(hasMore).toBe(true);
        // The newest three, in reading order.
        expect(threads.map(thread => thread.body)).toEqual(['comment 3', 'comment 4', 'comment 5']);
    });
});
