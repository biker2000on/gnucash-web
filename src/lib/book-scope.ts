/**
 * Book Scoping Utilities
 *
 * Provides functions to determine the active book and scope
 * database queries to a specific book's account hierarchy.
 */

import { cache } from 'react';
import { getSession } from './auth';
import prisma from './prisma';

/**
 * Returns the active book's root_account_guid from the session.
 * Falls back to the first book if no active book is set.
 * Throws if no books exist at all.
 */
export async function getActiveBookRootGuid(): Promise<string> {
    const session = await getSession();

    if (session.activeBookGuid) {
        const book = await prisma.books.findUnique({
            where: { guid: session.activeBookGuid },
            select: { root_account_guid: true },
        });
        if (book) return book.root_account_guid;
    }

    // Fallback to first book
    const firstBook = await prisma.books.findFirst({
        select: { guid: true, root_account_guid: true },
    });

    if (!firstBook) throw new Error('NO_BOOKS');

    // Auto-set session
    session.activeBookGuid = firstBook.guid;
    await session.save();
    return firstBook.root_account_guid;
}

/**
 * Get the active book's GUID from session
 */
export async function getActiveBookGuid(): Promise<string> {
    const session = await getSession();

    if (session.activeBookGuid) {
        const exists = await prisma.books.findUnique({
            where: { guid: session.activeBookGuid },
            select: { guid: true },
        });
        if (exists) return session.activeBookGuid;
    }

    const firstBook = await prisma.books.findFirst({
        select: { guid: true },
    });

    if (!firstBook) throw new Error('NO_BOOKS');

    session.activeBookGuid = firstBook.guid;
    await session.save();
    return firstBook.guid;
}

/**
 * Per-request cache for book account GUIDs.
 *
 * Uses React's request-scoped `cache()` so repeated calls within one request
 * hit the recursive CTE only once, while every new request sees a fresh tree.
 * A module-global cache here breaks under the shipped multi-process topology
 * (web + worker): cross-process invalidation is impossible, so newly created
 * accounts silently vanished from balances/reports on the other process.
 * Outside a request scope (workers, scripts) `cache()` degrades to an
 * uncached call — correct, just slower.
 *
 * The generation counter keeps invalidateBookAccountGuidsCache() meaningful
 * WITHIN a request: bumping it changes the memoization key, so import flows
 * that create accounts mid-request and re-read the tree get fresh data.
 */
let _generation = 0;

const queryAccountGuidsForRoot = cache(async (rootGuid: string, _gen: number): Promise<string[]> => {
    const accounts = await prisma.$queryRaw<{ guid: string }[]>`
        WITH RECURSIVE account_tree AS (
            SELECT guid FROM accounts WHERE guid = ${rootGuid}
            UNION ALL
            SELECT a.guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid FROM account_tree
    `;
    return accounts.map(a => a.guid);
});

/**
 * Returns all account GUIDs under the active book's root.
 * Uses a recursive CTE for efficiency; memoized per request.
 */
export async function getBookAccountGuids(): Promise<string[]> {
    const rootGuid = await getActiveBookRootGuid();
    return queryAccountGuidsForRoot(rootGuid, _generation);
}

/**
 * Returns all account GUIDs under a specific book (by book guid, not the
 * session's active book). Used for cross-book features like linked-business
 * tax aggregation. Uncached — call sparingly.
 */
export async function getAccountGuidsForBook(bookGuid: string): Promise<string[]> {
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) return [];

    const accounts = await prisma.$queryRaw<{ guid: string }[]>`
        WITH RECURSIVE account_tree AS (
            SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
            UNION ALL
            SELECT a.guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid FROM account_tree
    `;
    return accounts.map(a => a.guid);
}

/**
 * Invalidate the book account GUIDs cache.
 *
 * Best-effort since the cache became per-request (React `cache()`): every
 * new request already sees the fresh tree (cross-process invalidation was
 * never possible anyway). Bumping the generation only matters for callers
 * that create accounts mid-request and re-read the tree in the SAME request
 * (import flows) — it rotates the memoization key so the next read refetches.
 */
export function invalidateBookAccountGuidsCache(): void {
    _generation++;
}

/**
 * Check if a specific account belongs to the active book.
 * Returns true if the account is in the book's account tree.
 */
export async function isAccountInActiveBook(accountGuid: string): Promise<boolean> {
    const accountGuids = await getBookAccountGuids();
    return accountGuids.includes(accountGuid);
}
