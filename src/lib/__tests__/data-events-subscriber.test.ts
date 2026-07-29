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
    handleDataChangeMessage,
    startDataEventsSubscriber,
    stopDataEventsSubscriber,
} from '../data-events-subscriber';

const BOOK = 'b'.repeat(32);

function event(entity: string, bookGuid: string | null = BOOK): string {
    return JSON.stringify({ entity, bookGuid: bookGuid ?? undefined, ts: new Date().toISOString() });
}

beforeEach(() => {
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
