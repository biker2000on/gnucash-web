/**
 * Book Scoping Utilities
 *
 * Provides functions to determine the active book and scope
 * database queries to a specific book's account hierarchy.
 */

import { headers } from 'next/headers';
import { getSession } from './auth';
import prisma from './prisma';
import { authenticateBearer, parseBearerToken } from './api-tokens';

/**
 * Module-global short-TTL cache for book scoping.
 *
 * History: this used to be wrapped in React's `cache()`, on the assumption it
 * deduped per request. It does NOT — in route handlers the react-server build
 * of `cache()` is a passthrough (no cache dispatcher is ever installed), so
 * the recursive CTE ran on every single call, ~124 call sites, several twice
 * per request.
 *
 * Design now:
 * - A module-global Map keyed by root account guid with a ~3s TTL. That is
 *   long enough to absorb the burst-of-calls-per-request pattern (and the
 *   fan-out bursts when many requests land together), and short enough that
 *   even with zero invalidation a process is at most 3s stale.
 * - Cross-process correctness comes from the Redis data-change bus: the
 *   server-side subscriber (src/lib/data-events-subscriber.ts) calls
 *   invalidateBookAccountGuidsCache() on every 'accounts'/'book' event, so
 *   web + worker both drop their entries immediately after a mutation.
 * - In-process mutators (account routes, importers) still call
 *   invalidateBookAccountGuidsCache() directly for same-request re-reads.
 *
 * Entries store the in-flight promise so concurrent callers share a single
 * query; failed queries are evicted so errors are never cached.
 */
const BOOK_SCOPE_TTL_MS = 3_000;

interface GuidCacheEntry {
    promise: Promise<string[]>;
    /** Set once the promise resolves — lets sync-ish consumers avoid a query. */
    resolved: string[] | null;
    at: number;
}

/** Account-guid lists keyed by root account guid. */
const guidCacheByRoot = new Map<string, GuidCacheEntry>();

/**
 * book guid -> root_account_guid, same TTL. Safe to key by book guid alone:
 * the mapping is user-independent (session reads themselves are NEVER cached
 * — only the books.findUnique lookup that follows them is). Worst case a
 * just-deleted book is served for up to the TTL; 'book' events and the TTL
 * both bound that window.
 */
const bookRootByBookGuid = new Map<string, { rootGuid: string; at: number }>();

function isFresh(at: number): boolean {
    return Date.now() - at < BOOK_SCOPE_TTL_MS;
}

/** Bearer token -> its book guid, same short TTL (a token's book never changes). */
const bookGuidByToken = new Map<string, { bookGuid: string | null; at: number }>();

/**
 * The book a `Bearer gcw_...` request is scoped to, or null.
 *
 * Token requests carry no cookie, so `session.activeBookGuid` is undefined and
 * the fallbacks below would otherwise resolve to whichever book happens to be
 * first — reading a book the token was never issued for. Re-deriving from the
 * Authorization header is the same mechanism `requireRole` uses; it cannot be
 * threaded through via AsyncLocalStorage because `enterWith` inside an awaited
 * helper does not propagate to the caller's continuation.
 */
async function getBearerBookGuid(): Promise<string | null> {
    let raw: string | null;
    try {
        const headerStore = await headers();
        raw = parseBearerToken(headerStore.get('authorization'));
    } catch {
        // headers() throws outside a request scope (e.g. build time, worker)
        return null;
    }
    if (!raw) return null;

    const cached = bookGuidByToken.get(raw);
    if (cached && isFresh(cached.at)) return cached.bookGuid;

    const auth = await authenticateBearer(raw);
    const bookGuid = auth?.bookGuid ?? null;
    bookGuidByToken.set(raw, { bookGuid, at: Date.now() });
    return bookGuid;
}

/**
 * Resolve a book's root_account_guid with short-TTL memoization.
 * Returns null when the book does not exist.
 */
async function resolveBookRootGuid(bookGuid: string): Promise<string | null> {
    const cached = bookRootByBookGuid.get(bookGuid);
    if (cached && isFresh(cached.at)) return cached.rootGuid;

    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) {
        bookRootByBookGuid.delete(bookGuid);
        return null;
    }
    bookRootByBookGuid.set(bookGuid, { rootGuid: book.root_account_guid, at: Date.now() });
    return book.root_account_guid;
}

/**
 * Returns the active book's root_account_guid from the session.
 * Falls back to the first book if no active book is set.
 * Throws if no books exist at all.
 *
 * The session read is per-request (never cached); only the book-guid ->
 * root-guid DB lookup is memoized (short TTL, keyed by book guid).
 */
export async function getActiveBookRootGuid(): Promise<string> {
    const session = await getSession();

    if (session.activeBookGuid) {
        const rootGuid = await resolveBookRootGuid(session.activeBookGuid);
        if (rootGuid) return rootGuid;
    }

    const tokenBookGuid = await getBearerBookGuid();
    if (tokenBookGuid) {
        const rootGuid = await resolveBookRootGuid(tokenBookGuid);
        if (rootGuid) return rootGuid;
    }

    // Fallback to first book (uncached — it mutates the session)
    const firstBook = await prisma.books.findFirst({
        select: { guid: true, root_account_guid: true },
    });

    if (!firstBook) throw new Error('NO_BOOKS');

    // Auto-set session
    session.activeBookGuid = firstBook.guid;
    await session.save();
    bookRootByBookGuid.set(firstBook.guid, { rootGuid: firstBook.root_account_guid, at: Date.now() });
    return firstBook.root_account_guid;
}

/**
 * Get the active book's GUID from session.
 *
 * The existence check for the session's book shares the memoized book-root
 * lookup above (a book with a fresh cached root exists by definition).
 */
export async function getActiveBookGuid(): Promise<string> {
    const session = await getSession();

    if (session.activeBookGuid) {
        const rootGuid = await resolveBookRootGuid(session.activeBookGuid);
        if (rootGuid) return session.activeBookGuid;
    }

    // See getBearerBookGuid: token requests have no session book.
    const tokenBookGuid = await getBearerBookGuid();
    if (tokenBookGuid) {
        const rootGuid = await resolveBookRootGuid(tokenBookGuid);
        if (rootGuid) return tokenBookGuid;
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
 * Fetch (or reuse) the guid list for a root. Concurrent callers within the
 * TTL window share one in-flight query; rejected queries are evicted.
 */
function queryAccountGuidsForRoot(rootGuid: string): Promise<string[]> {
    const cached = guidCacheByRoot.get(rootGuid);
    if (cached && isFresh(cached.at)) return cached.promise;

    const entry: GuidCacheEntry = {
        at: Date.now(),
        resolved: null,
        promise: prisma.$queryRaw<{ guid: string }[]>`
            WITH RECURSIVE account_tree AS (
                SELECT guid FROM accounts WHERE guid = ${rootGuid}
                UNION ALL
                SELECT a.guid FROM accounts a
                JOIN account_tree t ON a.parent_guid = t.guid
            )
            SELECT guid FROM account_tree
        `.then(rows => {
            const guids = rows.map(r => r.guid);
            entry.resolved = guids;
            return guids;
        }),
    };
    // Never cache a failure — evict so the next caller retries.
    entry.promise.catch(() => {
        if (guidCacheByRoot.get(rootGuid) === entry) guidCacheByRoot.delete(rootGuid);
    });
    guidCacheByRoot.set(rootGuid, entry);
    return entry.promise;
}

/**
 * Returns all account GUIDs under the active book's root.
 * Uses a recursive CTE; memoized module-globally with a short TTL
 * (see the cache notes at the top of this file).
 */
export async function getBookAccountGuids(): Promise<string[]> {
    const rootGuid = await getActiveBookRootGuid();
    return queryAccountGuidsForRoot(rootGuid);
}

/**
 * Returns all account GUIDs under a specific book (by book guid, not the
 * session's active book). Used for cross-book features like linked-business
 * tax aggregation, and by book-explicit callers (dashboard routes).
 * Shares the same short-TTL cache as getBookAccountGuids.
 */
export async function getAccountGuidsForBook(bookGuid: string): Promise<string[]> {
    const rootGuid = await resolveBookRootGuid(bookGuid);
    if (!rootGuid) return [];
    return queryAccountGuidsForRoot(rootGuid);
}

/**
 * Invalidate the book-scope caches (account-guid lists + book-root lookups).
 *
 * Called in-process by account mutation routes/importers, and by the
 * data-events subscriber whenever any process publishes an 'accounts' or
 * 'book' data-change event — that is what keeps the module-global cache
 * correct across the web + worker topology. Clears everything rather than
 * per-book entries: the maps are tiny and repopulate with one query each.
 */
export function invalidateBookAccountGuidsCache(): void {
    guidCacheByRoot.clear();
    bookRootByBookGuid.clear();
}

/**
 * Check if a specific account belongs to the active book.
 *
 * Fast path: if the active book's guid list is already resolved and fresh in
 * the TTL cache, membership is a lookup. Otherwise runs a single bounded
 * upward-walk EXISTS query (same pattern as resolveBookLockGuidForAccount in
 * book-lock.ts) instead of materializing the whole subtree.
 */
export async function isAccountInActiveBook(accountGuid: string): Promise<boolean> {
    const rootGuid = await getActiveBookRootGuid();

    const cached = guidCacheByRoot.get(rootGuid);
    if (cached && cached.resolved && isFresh(cached.at)) {
        return cached.resolved.includes(accountGuid);
    }

    if (accountGuid === rootGuid) return true;

    // Depth-bounded upward walk (terminates even on an already-cyclic tree).
    const rows = await prisma.$queryRaw<Array<{ in_book: boolean }>>`
        WITH RECURSIVE up AS (
            SELECT guid, parent_guid, 1 AS depth
            FROM accounts WHERE guid = ${accountGuid}
            UNION ALL
            SELECT a.guid, a.parent_guid, up.depth + 1
            FROM accounts a
            JOIN up ON a.guid = up.parent_guid
            WHERE up.depth < 200
        )
        SELECT EXISTS(SELECT 1 FROM up WHERE guid = ${rootGuid}) AS in_book
    `;
    return rows[0]?.in_book === true;
}
