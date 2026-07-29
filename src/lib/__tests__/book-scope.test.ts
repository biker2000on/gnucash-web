/**
 * book-scope TTL cache tests — module-global short-TTL memoization of the
 * account-tree CTE, book-root lookups, invalidation, and the single-EXISTS
 * membership check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryRawMock, findUniqueMock, findFirstMock, getSessionMock } = vi.hoisted(() => ({
    queryRawMock: vi.fn(),
    findUniqueMock: vi.fn(),
    findFirstMock: vi.fn(),
    getSessionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: queryRawMock,
        books: { findUnique: findUniqueMock, findFirst: findFirstMock },
    },
}));
vi.mock('@/lib/auth', () => ({ getSession: getSessionMock }));

import {
    getBookAccountGuids,
    getAccountGuidsForBook,
    getActiveBookRootGuid,
    getActiveBookGuid,
    invalidateBookAccountGuidsCache,
    isAccountInActiveBook,
} from '../book-scope';

const BOOK = 'b'.repeat(32);
const ROOT = 'r'.repeat(32);
const CHILD = 'a'.repeat(32);
const OUTSIDE = 'x'.repeat(32);

function treeQueryCalls(): number {
    return queryRawMock.mock.calls.filter(
        ([strings]) => (strings as string[]).join('?').includes('account_tree'),
    ).length;
}

function existsQueryCalls(): number {
    return queryRawMock.mock.calls.filter(
        ([strings]) => (strings as string[]).join('?').includes('EXISTS'),
    ).length;
}

beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-28T00:00:00Z') });
    queryRawMock.mockReset();
    findUniqueMock.mockReset();
    findFirstMock.mockReset();
    getSessionMock.mockReset();
    invalidateBookAccountGuidsCache();

    getSessionMock.mockResolvedValue({ activeBookGuid: BOOK, save: vi.fn() });
    findUniqueMock.mockResolvedValue({ root_account_guid: ROOT, guid: BOOK });
    queryRawMock.mockImplementation(async (strings: string[]) => {
        const sql = strings.join('?');
        if (sql.includes('account_tree')) return [{ guid: ROOT }, { guid: CHILD }];
        if (sql.includes('EXISTS')) return [{ in_book: true }];
        return [];
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('getBookAccountGuids TTL cache', () => {
    it('runs the recursive CTE once for repeated calls within the TTL', async () => {
        const first = await getBookAccountGuids();
        const second = await getBookAccountGuids();

        expect(first).toEqual([ROOT, CHILD]);
        expect(second).toEqual([ROOT, CHILD]);
        expect(treeQueryCalls()).toBe(1);
        // book-root lookup is memoized too
        expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('shares one in-flight query across concurrent callers', async () => {
        const [a, b] = await Promise.all([getBookAccountGuids(), getBookAccountGuids()]);
        expect(a).toEqual(b);
        expect(treeQueryCalls()).toBe(1);
    });

    it('refetches after the TTL expires', async () => {
        await getBookAccountGuids();
        vi.advanceTimersByTime(4_000); // TTL is 3s
        await getBookAccountGuids();
        expect(treeQueryCalls()).toBe(2);
    });

    it('serves cached data just under the TTL', async () => {
        await getBookAccountGuids();
        vi.advanceTimersByTime(2_000);
        await getBookAccountGuids();
        expect(treeQueryCalls()).toBe(1);
    });

    it('invalidateBookAccountGuidsCache forces a refetch (guids and book root)', async () => {
        await getBookAccountGuids();
        invalidateBookAccountGuidsCache();
        await getBookAccountGuids();
        expect(treeQueryCalls()).toBe(2);
        expect(findUniqueMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache failures', async () => {
        queryRawMock.mockRejectedValueOnce(new Error('db down'));
        await expect(getBookAccountGuids()).rejects.toThrow('db down');

        const result = await getBookAccountGuids();
        expect(result).toEqual([ROOT, CHILD]);
        expect(treeQueryCalls()).toBe(2);
    });
});

describe('getAccountGuidsForBook', () => {
    it('shares the TTL cache with getBookAccountGuids', async () => {
        await getAccountGuidsForBook(BOOK);
        await getBookAccountGuids();
        expect(treeQueryCalls()).toBe(1);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('returns [] for an unknown book', async () => {
        findUniqueMock.mockResolvedValue(null);
        expect(await getAccountGuidsForBook('nope')).toEqual([]);
        expect(treeQueryCalls()).toBe(0);
    });
});

describe('active-book lookups', () => {
    it('memoizes the book-root DB lookup within the TTL', async () => {
        expect(await getActiveBookRootGuid()).toBe(ROOT);
        expect(await getActiveBookRootGuid()).toBe(ROOT);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('re-checks the book after the TTL expires', async () => {
        await getActiveBookRootGuid();
        vi.advanceTimersByTime(4_000);
        await getActiveBookRootGuid();
        expect(findUniqueMock).toHaveBeenCalledTimes(2);
    });

    it('getActiveBookGuid reuses the memoized existence check', async () => {
        expect(await getActiveBookGuid()).toBe(BOOK);
        expect(await getActiveBookRootGuid()).toBe(ROOT);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the first book when the session book is missing', async () => {
        const save = vi.fn();
        getSessionMock.mockResolvedValue({ activeBookGuid: undefined, save });
        findFirstMock.mockResolvedValue({ guid: BOOK, root_account_guid: ROOT });

        expect(await getActiveBookRootGuid()).toBe(ROOT);
        expect(save).toHaveBeenCalled();
    });
});

describe('isAccountInActiveBook', () => {
    it('answers from the cached guid list when fresh', async () => {
        await getBookAccountGuids(); // populate cache
        expect(await isAccountInActiveBook(CHILD)).toBe(true);
        expect(await isAccountInActiveBook(OUTSIDE)).toBe(false);
        expect(existsQueryCalls()).toBe(0);
        expect(treeQueryCalls()).toBe(1);
    });

    it('uses a single EXISTS upward walk on a cold cache (no tree download)', async () => {
        expect(await isAccountInActiveBook(CHILD)).toBe(true);
        expect(existsQueryCalls()).toBe(1);
        expect(treeQueryCalls()).toBe(0);
    });

    it('returns false when the EXISTS walk does not reach the book root', async () => {
        queryRawMock.mockImplementation(async (strings: string[]) => {
            const sql = strings.join('?');
            if (sql.includes('EXISTS')) return [{ in_book: false }];
            return [];
        });
        expect(await isAccountInActiveBook(OUTSIDE)).toBe(false);
    });

    it('accepts the root account itself without querying', async () => {
        expect(await isAccountInActiveBook(ROOT)).toBe(true);
        expect(existsQueryCalls()).toBe(0);
    });
});
