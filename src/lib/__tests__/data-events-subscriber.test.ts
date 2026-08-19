/**
 * data-events subscriber tests — event routing to book-scope + Redis cache
 * invalidation, idempotent start, and safe no-op without Redis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { cacheInvalidateAllForBookMock, invalidateBookScopeMock, fakeRedis } = vi.hoisted(() => {
    const instances: Array<{
        url: string;
        handlers: Map<string, Array<(...args: unknown[]) => void>>;
        psubscribe: ReturnType<typeof vi.fn>;
        punsubscribe: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        emit: (event: string, ...args: unknown[]) => void;
    }> = [];

    class FakeRedis {
        url: string;
        handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        psubscribe = vi.fn(async () => 1);
        punsubscribe = vi.fn(async () => 1);
        disconnect = vi.fn();

        constructor(url: string) {
            this.url = url;
            instances.push(this as never);
        }

        on(event: string, cb: (...args: unknown[]) => void) {
            const list = this.handlers.get(event) ?? [];
            list.push(cb);
            this.handlers.set(event, list);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            for (const cb of this.handlers.get(event) ?? []) cb(...args);
        }
    }

    return {
        cacheInvalidateAllForBookMock: vi.fn(async () => 0),
        invalidateBookScopeMock: vi.fn(),
        fakeRedis: { ctor: FakeRedis, instances },
    };
});

vi.mock('ioredis', () => ({ default: fakeRedis.ctor }));
vi.mock('@/lib/cache', () => ({ cacheInvalidateAllForBook: cacheInvalidateAllForBookMock }));
vi.mock('@/lib/book-scope', () => ({ invalidateBookAccountGuidsCache: invalidateBookScopeMock }));

import {
    DASHBOARD_INVALIDATE_DEBOUNCE_MS,
    flushPendingCacheInvalidations,
    handleDataChangeMessage,
    startDataEventsSubscriber,
    stopDataEventsSubscriber,
} from '../data-events-subscriber';

const BOOK = 'b'.repeat(32);

function event(entity: string, bookGuid: string | null = BOOK): string {
    return JSON.stringify({ entity, bookGuid: bookGuid ?? undefined, ts: new Date().toISOString() });
}

beforeEach(async () => {
    // Invalidation is coalesced per book; clear any window a previous test
    // left open so each test starts on the leading edge.
    await flushPendingCacheInvalidations();
    cacheInvalidateAllForBookMock.mockClear();
    invalidateBookScopeMock.mockClear();
    fakeRedis.instances.length = 0;
});

afterEach(async () => {
    await stopDataEventsSubscriber();
    delete process.env.REDIS_URL;
});

describe('handleDataChangeMessage routing', () => {
    it('accounts events drop the book-scope cache AND the book Redis cache', async () => {
        await handleDataChangeMessage(event('accounts'));
        expect(invalidateBookScopeMock).toHaveBeenCalledTimes(1);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);
    });

    it('book events drop both caches', async () => {
        await handleDataChangeMessage(event('book'));
        expect(invalidateBookScopeMock).toHaveBeenCalledTimes(1);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);
    });

    it('transactions events invalidate only the Redis book cache', async () => {
        await handleDataChangeMessage(event('transactions'));
        expect(invalidateBookScopeMock).not.toHaveBeenCalled();
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);
    });

    it.each(['budgets', 'prices', 'business', 'reconciliation'])(
        '%s events invalidate the Redis book cache',
        async (entity) => {
            await handleDataChangeMessage(event(entity));
            expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);
            expect(invalidateBookScopeMock).not.toHaveBeenCalled();
        },
    );

    it('schedules events invalidate nothing', async () => {
        await handleDataChangeMessage(event('schedules'));
        expect(invalidateBookScopeMock).not.toHaveBeenCalled();
        expect(cacheInvalidateAllForBookMock).not.toHaveBeenCalled();
    });

    it('skips Redis invalidation when the event carries no bookGuid', async () => {
        await handleDataChangeMessage(event('transactions', null));
        expect(cacheInvalidateAllForBookMock).not.toHaveBeenCalled();
    });

    it('tolerates malformed payloads', async () => {
        await expect(handleDataChangeMessage('{not json')).resolves.toBeUndefined();
        expect(invalidateBookScopeMock).not.toHaveBeenCalled();
        expect(cacheInvalidateAllForBookMock).not.toHaveBeenCalled();
    });

    it('tolerates invalidation failures', async () => {
        cacheInvalidateAllForBookMock.mockRejectedValueOnce(new Error('redis down'));
        await expect(handleDataChangeMessage(event('transactions'))).resolves.toBeUndefined();
    });
});

describe('startDataEventsSubscriber lifecycle', () => {
    it('is a no-op without REDIS_URL', () => {
        delete process.env.REDIS_URL;
        expect(startDataEventsSubscriber()).toBe(false);
        expect(fakeRedis.instances.length).toBe(0);
    });

    it('starts once and psubscribes to the data-change pattern', () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        expect(startDataEventsSubscriber()).toBe(true);
        expect(startDataEventsSubscriber()).toBe(true); // idempotent
        expect(fakeRedis.instances.length).toBe(1);
        expect(fakeRedis.instances[0].psubscribe).toHaveBeenCalledWith('data-change:book:*');
    });

    it('routes pmessage frames through the handler', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        startDataEventsSubscriber();

        fakeRedis.instances[0].emit('pmessage', 'data-change:book:*', `data-change:book:${BOOK}`, event('accounts'));
        await vi.waitFor(() => {
            expect(invalidateBookScopeMock).toHaveBeenCalledTimes(1);
            expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);
        });
    });

    it('stopDataEventsSubscriber releases the connection and allows a restart', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        startDataEventsSubscriber();
        await stopDataEventsSubscriber();
        expect(fakeRedis.instances[0].disconnect).toHaveBeenCalled();

        startDataEventsSubscriber();
        expect(fakeRedis.instances.length).toBe(2);
    });
});

describe('dashboard invalidation debounce', () => {
    const OTHER_BOOK = 'c'.repeat(32);

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('collapses a burst of writes into one leading + one trailing invalidation', async () => {
        for (let i = 0; i < 12; i++) {
            await handleDataChangeMessage(event('transactions'));
        }

        // Leading edge fired immediately; the other eleven were coalesced.
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(DASHBOARD_INVALIDATE_DEBOUNCE_MS + 1);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(2);

        // Nothing further is queued once the burst has settled.
        await vi.advanceTimersByTimeAsync(DASHBOARD_INVALIDATE_DEBOUNCE_MS * 4);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(2);
    });

    it('does not delay a single write — the first event invalidates at once', async () => {
        await handleDataChangeMessage(event('transactions'));
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(1);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);

        // A lone event leaves no trailing pass behind.
        await vi.advanceTimersByTimeAsync(DASHBOARD_INVALIDATE_DEBOUNCE_MS * 4);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a long burst coalesced instead of degrading to one call per event', async () => {
        for (let window = 0; window < 3; window++) {
            for (let i = 0; i < 5; i++) {
                await handleDataChangeMessage(event('transactions'));
            }
            await vi.advanceTimersByTimeAsync(DASHBOARD_INVALIDATE_DEBOUNCE_MS + 1);
        }
        // 15 events, three quiet windows: one call each, plus the leading one.
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(4);
    });

    it('debounces per book — a busy book never starves a quiet one', async () => {
        await handleDataChangeMessage(event('transactions'));
        await handleDataChangeMessage(event('transactions'));
        await handleDataChangeMessage(event('transactions', OTHER_BOOK));

        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(2);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(BOOK);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledWith(OTHER_BOOK);
    });

    it('flushes a pending trailing pass on shutdown rather than dropping it', async () => {
        await handleDataChangeMessage(event('transactions'));
        await handleDataChangeMessage(event('transactions'));
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(1);

        await flushPendingCacheInvalidations();
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(2);

        // The window is gone, so the timer cannot fire a third time.
        await vi.advanceTimersByTimeAsync(DASHBOARD_INVALIDATE_DEBOUNCE_MS * 4);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(2);
    });

    it('still invalidates the book-scope cache for every account event in a burst', async () => {
        await handleDataChangeMessage(event('accounts'));
        await handleDataChangeMessage(event('accounts'));
        await handleDataChangeMessage(event('accounts'));

        // The in-memory account-tree drop is cheap and correctness-critical;
        // only the Redis SCAN pass is coalesced.
        expect(invalidateBookScopeMock).toHaveBeenCalledTimes(3);
        expect(cacheInvalidateAllForBookMock).toHaveBeenCalledTimes(1);
    });
});
