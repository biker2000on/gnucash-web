/**
 * Comment body validation, @-mention parsing, thread assembly and the RBAC
 * predicates — the pure half of transaction comments.
 */

import { describe, expect, it } from 'vitest';
import {
    DELETED_COMMENT_BODY,
    MAX_COMMENT_LENGTH,
    buildCommentThreads,
    canDeleteComment,
    canEditComment,
    parseMentions,
    resolveMentionedMembers,
    unresolvedThreads,
    validateCommentBody,
    type TransactionComment,
} from '@/lib/transaction-comments';

const TX = 't'.repeat(32);

function comment(overrides: Partial<TransactionComment> = {}): TransactionComment {
    return {
        id: 1,
        txnGuid: TX,
        parentId: null,
        auditId: null,
        author: { id: 7, username: 'justin', displayName: 'Justin' },
        body: 'Asked the vendor for a corrected invoice.',
        resolved: false,
        createdAt: '2026-08-19T14:02:00.000Z',
        editedAt: null,
        deleted: false,
        ...overrides,
    };
}

describe('validateCommentBody', () => {
    it('trims and accepts a normal body', () => {
        expect(validateCommentBody('  hello  ')).toEqual({ ok: true, value: 'hello', issues: [] });
    });

    it('rejects a non-string', () => {
        expect(validateCommentBody(42).ok).toBe(false);
        expect(validateCommentBody(undefined).issues[0].path).toEqual(['body']);
    });

    it('rejects whitespace-only', () => {
        const result = validateCommentBody('   \n\t ');
        expect(result.ok).toBe(false);
        expect(result.issues[0].message).toBe('A comment cannot be empty');
    });

    it('rejects a body past the cap and says how long it was', () => {
        const result = validateCommentBody('x'.repeat(MAX_COMMENT_LENGTH + 1));
        expect(result.ok).toBe(false);
        expect(result.issues[0].message).toContain(String(MAX_COMMENT_LENGTH + 1));
    });

    it('accepts a body exactly at the cap', () => {
        expect(validateCommentBody('x'.repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
    });
});

describe('parseMentions', () => {
    it('finds mentions at the start and mid-sentence', () => {
        expect(parseMentions('@dana can you check this with @Justin?')).toEqual(['dana', 'justin']);
    });

    it('de-duplicates while keeping order', () => {
        expect(parseMentions('@dana @Dana @bob')).toEqual(['dana', 'bob']);
    });

    it('does not read an email address as a mention', () => {
        expect(parseMentions('mail bob@example.com about it')).toEqual([]);
    });

    it('drops trailing punctuation from the name', () => {
        expect(parseMentions('ping @dana.')).toEqual(['dana']);
    });

    it('returns nothing for a body with no mentions', () => {
        expect(parseMentions('no one in particular')).toEqual([]);
    });
});

describe('resolveMentionedMembers', () => {
    const members = [
        { id: 7, username: 'justin' },
        { id: 9, username: 'dana' },
    ];

    it('matches book members case-insensitively', () => {
        expect(resolveMentionedMembers('hey @Dana', members)).toEqual([{ id: 9, username: 'dana' }]);
    });

    it('ignores a mention of someone who is not a book member', () => {
        // Notifying a non-member would tell them about a book they cannot open
        // and would confirm to the author that the account exists.
        expect(resolveMentionedMembers('hey @stranger', members)).toEqual([]);
    });

    it('never returns the author', () => {
        expect(resolveMentionedMembers('@justin @dana', members, { excludeUserId: 7 }))
            .toEqual([{ id: 9, username: 'dana' }]);
    });
});

describe('buildCommentThreads', () => {
    it('nests replies under their root in creation order', () => {
        const threads = buildCommentThreads([
            comment({ id: 3, parentId: 1, createdAt: '2026-08-19T15:00:00.000Z', body: 'second reply' }),
            comment({ id: 1, createdAt: '2026-08-19T14:00:00.000Z' }),
            comment({ id: 2, parentId: 1, createdAt: '2026-08-19T14:30:00.000Z', body: 'first reply' }),
        ]);
        expect(threads).toHaveLength(1);
        expect(threads[0].id).toBe(1);
        expect(threads[0].replies.map(reply => reply.id)).toEqual([2, 3]);
    });

    it('orders roots oldest first', () => {
        const threads = buildCommentThreads([
            comment({ id: 5, createdAt: '2026-08-20T09:00:00.000Z' }),
            comment({ id: 4, createdAt: '2026-08-19T09:00:00.000Z' }),
        ]);
        expect(threads.map(thread => thread.id)).toEqual([4, 5]);
    });

    it('surfaces an orphaned reply as a root rather than dropping it', () => {
        const threads = buildCommentThreads([comment({ id: 6, parentId: 999 })]);
        expect(threads.map(thread => thread.id)).toEqual([6]);
    });

    it('keeps a soft-deleted root so its replies keep their place', () => {
        const threads = buildCommentThreads([
            comment({ id: 1, deleted: true, body: DELETED_COMMENT_BODY }),
            comment({ id: 2, parentId: 1, body: 'still here' }),
        ]);
        expect(threads[0].body).toBe(DELETED_COMMENT_BODY);
        expect(threads[0].replies).toHaveLength(1);
    });
});

describe('comment permissions', () => {
    const author = { userId: 7, role: 'edit' } as const;
    const other = { userId: 9, role: 'edit' } as const;
    const admin = { userId: 9, role: 'admin' } as const;

    it('lets only the author edit', () => {
        expect(canEditComment(author, comment())).toBe(true);
        expect(canEditComment(other, comment())).toBe(false);
    });

    it('does not let even an admin rewrite someone else', () => {
        expect(canEditComment(admin, comment())).toBe(false);
    });

    it('lets the author or an admin delete', () => {
        expect(canDeleteComment(author, comment())).toBe(true);
        expect(canDeleteComment(admin, comment())).toBe(true);
        expect(canDeleteComment(other, comment())).toBe(false);
    });

    it('refuses to act on an already-deleted comment', () => {
        const gone = comment({ deleted: true });
        expect(canEditComment(author, gone)).toBe(false);
        expect(canDeleteComment(admin, gone)).toBe(false);
    });

    it('never treats an orphaned author as a match', () => {
        // A removed user leaves user_id NULL; a viewer must not inherit their
        // comments just because both sides are "no id".
        const orphan = comment({ author: { id: null, username: 'deleted-user', displayName: 'Removed user' } });
        expect(canEditComment(author, orphan)).toBe(false);
        expect(canDeleteComment(author, orphan)).toBe(false);
        expect(canDeleteComment(admin, orphan)).toBe(true);
    });
});

describe('unresolvedThreads', () => {
    it('keeps only open, undeleted roots', () => {
        const threads = buildCommentThreads([
            comment({ id: 1 }),
            comment({ id: 2, resolved: true }),
            comment({ id: 3, deleted: true }),
        ]);
        expect(unresolvedThreads(threads).map(thread => thread.id)).toEqual([1]);
    });
});
