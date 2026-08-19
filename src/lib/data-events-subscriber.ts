/**
 * Server-side data-change subscriber — makes publishDataChange the single
 * cache-invalidation primitive across processes.
 *
 * Subscribes a dedicated Redis connection (subscriber mode) to
 * `data-change:book:*` and reacts to each event:
 *   - 'accounts' / 'book'  -> drops the book-scope TTL cache
 *     (src/lib/book-scope.ts), so account-tree changes made by any process
 *     are visible everywhere immediately instead of after the TTL.
 *   - dashboard-affecting entities (transactions, accounts, budgets, prices,
 *     business, reconciliation, book) -> cacheInvalidateAllForBook(bookGuid),
 *     clearing every Redis-cached report/dashboard payload for that book.
 *     Coalesced per book (see DASHBOARD_INVALIDATE_DEBOUNCE_MS) so a bulk
 *     write's event storm costs two SCAN passes, not one per event.
 *
 * Started from src/instrumentation.ts (web) and worker.ts (worker). Safe
 * no-op without REDIS_URL, idempotent (globalThis singleton survives dev HMR
 * re-evaluation), and reconnects forever with capped backoff — a flaky Redis
 * degrades to TTL-only freshness, never crashes the process.
 */

import Redis from 'ioredis';
import { cacheInvalidateAllForBook } from './cache';
import type { DataChangeEntity, DataChangeEvent } from './data-events';

/** Entities whose events invalidate the book-scope account-guid cache. */
const ACCOUNT_TREE_ENTITIES: ReadonlySet<DataChangeEntity> = new Set([
    'accounts',
    'book',
]);

/** Entities whose events invalidate Redis-cached dashboard/report payloads. */
const DASHBOARD_CACHE_ENTITIES: ReadonlySet<DataChangeEntity> = new Set([
    'transactions',
    'accounts',
    'budgets',
    'prices',
    'business',
    'reconciliation',
    'book',
]);

const DATA_CHANGE_PATTERN = 'data-change:book:*';

/**
 * Quiet window, per book, for dashboard cache invalidation.
 *
 * A bulk write (an import, a SimpleFin sync, a batch scheduled-transaction
 * run) publishes many events in quick succession, and each one used to trigger
 * its own cacheInvalidateAllForBook — a SCAN over every index key for the book
 * plus a zrangebyscore/del per index, repeated N times for one logical change.
 */
export const DASHBOARD_INVALIDATE_DEBOUNCE_MS = 300;

interface BookInvalidationWindow {
    timer: ReturnType<typeof setTimeout>;
    /** An event arrived while this window was open. */
    pending: boolean;
}

/** Books with an open quiet window, keyed by book guid. */
const invalidationWindows = new Map<string, BookInvalidationWindow>();

async function invalidateBookDashboardCaches(bookGuid: string): Promise<void> {
    try {
        await cacheInvalidateAllForBook(bookGuid);
    } catch (err) {
        console.warn(
            'data-events subscriber: cache invalidation failed:',
            err instanceof Error ? err.message : err,
        );
    }
}

function openQuietWindow(bookGuid: string): void {
    const timer = setTimeout(() => {
        const window = invalidationWindows.get(bookGuid);
        invalidationWindows.delete(bookGuid);
        if (!window?.pending) return;
        // Everything that arrived during the window collapses into this one
        // trailing pass, which opens a fresh window so a long burst keeps
        // coalescing instead of degrading back to one invalidation per event.
        openQuietWindow(bookGuid);
        void invalidateBookDashboardCaches(bookGuid);
    }, DASHBOARD_INVALIDATE_DEBOUNCE_MS);
    // Never hold the process open for a cache eviction.
    timer.unref?.();
    invalidationWindows.set(bookGuid, { timer, pending: false });
}

/**
 * Invalidate a book's cached dashboard/report payloads, coalescing bursts.
 *
 * Leading edge, not trailing: the FIRST event of a burst invalidates
 * immediately, so a single write is never made staler than it was before. Only
 * the follow-up events are collapsed, into one trailing pass once the burst
 * settles. A burst of N events therefore costs 2 invalidations instead of N.
 */
async function scheduleDashboardInvalidation(bookGuid: string): Promise<void> {
    const open = invalidationWindows.get(bookGuid);
    if (open) {
        open.pending = true;
        return;
    }
    // Open the window BEFORE awaiting, so events arriving during the
    // invalidation itself are coalesced rather than each starting their own.
    openQuietWindow(bookGuid);
    await invalidateBookDashboardCaches(bookGuid);
}

/**
 * Run any coalesced invalidation that is still waiting on its quiet window and
 * clear all window state. Called on shutdown — a pending trailing pass must not
 * be dropped, or the shared Redis cache keeps a stale payload until its TTL.
 * Also the reset hook for tests.
 */
export async function flushPendingCacheInvalidations(): Promise<void> {
    const windows = [...invalidationWindows.entries()];
    invalidationWindows.clear();
    for (const [bookGuid, window] of windows) {
        clearTimeout(window.timer);
        if (window.pending) await invalidateBookDashboardCaches(bookGuid);
    }
}

interface SubscriberState {
    client: Redis;
}

// globalThis so dev-server HMR module re-evaluation can't spawn a second
// subscriber connection.
const globalState = globalThis as unknown as {
    __gnucashDataEventsSubscriber?: SubscriberState;
};

/**
 * Handle one raw data-change message. Exported for tests.
 * Never throws — invalidation is best-effort.
 */
export async function handleDataChangeMessage(raw: string): Promise<void> {
    let event: DataChangeEvent;
    try {
        event = JSON.parse(raw) as DataChangeEvent;
    } catch {
        console.warn('data-events subscriber: ignoring malformed event payload');
        return;
    }
    if (!event || typeof event.entity !== 'string') return;

    if (ACCOUNT_TREE_ENTITIES.has(event.entity)) {
        try {
            // Lazy import keeps this module dependency-light (book-scope pulls
            // in auth/prisma) — the worker only loads them if events arrive.
            const { invalidateBookAccountGuidsCache } = await import('./book-scope');
            invalidateBookAccountGuidsCache();
        } catch (err) {
            console.warn(
                'data-events subscriber: book-scope invalidation failed:',
                err instanceof Error ? err.message : err,
            );
        }
    }

    if (DASHBOARD_CACHE_ENTITIES.has(event.entity) && typeof event.bookGuid === 'string' && event.bookGuid) {
        await scheduleDashboardInvalidation(event.bookGuid);
    }
}

/**
 * Start the subscriber. Idempotent — repeated calls (and HMR re-evaluations)
 * reuse the existing connection. Returns true when a subscriber is running,
 * false when Redis is not configured/available.
 */
export function startDataEventsSubscriber(): boolean {
    if (globalState.__gnucashDataEventsSubscriber) return true;

    const url = process.env.REDIS_URL;
    if (!url) return false;

    let client: Redis;
    try {
        client = new Redis(url, {
            connectTimeout: 5000,
            // Subscriber connection must outlive transient outages: retry
            // forever with capped backoff (unlike the shared command client,
            // which fails fast). ioredis re-issues psubscribe on reconnect.
            maxRetriesPerRequest: null,
            retryStrategy: (times) => Math.min(times * 1000, 15_000),
        });
    } catch (err) {
        console.warn(
            'data-events subscriber: failed to create Redis connection:',
            err instanceof Error ? err.message : err,
        );
        return false;
    }

    client.on('error', (err) => {
        console.warn('data-events subscriber Redis error:', err.message);
    });

    client.on('pmessage', (_pattern: string, _channel: string, message: string) => {
        void handleDataChangeMessage(message);
    });

    client.psubscribe(DATA_CHANGE_PATTERN).catch((err) => {
        console.warn(
            'data-events subscriber: psubscribe failed:',
            err instanceof Error ? err.message : err,
        );
    });

    globalState.__gnucashDataEventsSubscriber = { client };
    console.log('data-events subscriber started (pattern: %s)', DATA_CHANGE_PATTERN);
    return true;
}

/**
 * Stop the subscriber and release its connection. Used by tests and graceful
 * shutdown; safe to call when never started.
 */
export async function stopDataEventsSubscriber(): Promise<void> {
    await flushPendingCacheInvalidations();
    const state = globalState.__gnucashDataEventsSubscriber;
    if (!state) return;
    delete globalState.__gnucashDataEventsSubscriber;
    try {
        await state.client.punsubscribe(DATA_CHANGE_PATTERN);
    } catch {
        // Connection may already be down — disconnect below regardless.
    }
    state.client.disconnect();
}
