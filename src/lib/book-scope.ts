/**
 * Book Scoping Utilities
 *
 * Provides functions to determine the active book and scope
 * database queries to a specific book's account hierarchy.
 */

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
 * Request-scoped cache for book account GUIDs.
 * We use a WeakRef-like pattern with a simple module-level cache
 * that gets refreshed if the root guid changes.
 */
let _cachedRootGuid: string | null = null;
let _cachedAccountGuids: string[] | null = null;

/**
 * Returns all account GUIDs under the active book's root.
 * Uses a recursive CTE for efficiency. Results are cached within
 * the same root guid to avoid repeated queries.
 */
export async function getBookAccountGuids(): Promise<string[]> {
    const rootGuid = await getActiveBookRootGuid();

    // Return cached result if root hasn't changed
    if (_cachedRootGuid === rootGuid && _cachedAccountGuids) {
        return _cachedAccountGuids;
    }

    const accounts = await prisma.$queryRaw<{ guid: string }[]>`
        WITH RECURSIVE account_tree AS (
            SELECT guid FROM accounts WHERE guid = ${rootGuid}
            UNION ALL
            SELECT a.guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid FROM account_tree
    `;

    const guids = accounts.map(a => a.guid);
    _cachedRootGuid = rootGuid;
    _cachedAccountGuids = guids;

    return guids;
}

/**
 * Check if a specific account belongs to the active book.
 * Returns true if the account is in the book's account tree.
 */
export async function isAccountInActiveBook(accountGuid: string): Promise<boolean> {
    const accountGuids = await getBookAccountGuids();
    return accountGuids.includes(accountGuid);
}
