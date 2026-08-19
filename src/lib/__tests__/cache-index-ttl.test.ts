/**
 * ASI-6-007(c) — the zset index keys written by cacheSet had no expiry.
 *
 * Entries expire via SETEX, but their index outlived them forever: one zset
 * per (book, metric) accumulating a member for every date range ever
 * requested, which cacheInvalidateFrom then SCANs and range-deletes over on
 * every write. These tests pin the TTL, and pin that the KEY FORMAT is
 * untouched — invalidation depends on the trailing date range, so a change
 * there silently breaks eviction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn() }));

vi.mock('../redis', () => ({ getRedis: getRedisMock }));

import { cacheSet } from '../cache';

const BOOK = 'b'.repeat(32);

type ExpireCall = [key: string, ttl: number, flag?: string];

/**
 * A fake with REAL Redis >= 7 EXPIRE-flag semantics, because the bug being
 * guarded here only exists in those semantics: on a key with no TTL, GT is a
 * no-op (Redis treats non-volatile as infinite, and nothing beats infinity).
 * A mock that just returns 1 for every EXPIRE cannot see the defect at all.
 */
function fakeRedis(overrides: Record<string, unknown> = {}) {
  const ttls = new Map<string, number>();
  const expireCalls: ExpireCall[] = [];

  const applyExpire = (key: string, ttl: number, flag?: string): number => {
    expireCalls.push([key, ttl, flag]);
    const current = ttls.get(key);
    if (flag === 'NX') {
      if (current !== undefined) return 0;
      ttls.set(key, ttl);
      return 1;
    }
    if (flag === 'GT') {
      // No TTL == infinite: a finite ttl is never greater. THIS is the no-op.
      if (current === undefined || ttl <= current) return 0;
      ttls.set(key, ttl);
      return 1;
    }
    ttls.set(key, ttl);
    return 1;
  };

  const base = {
    setex: vi.fn(async () => 'OK'),
    zadd: vi.fn(async () => 1),
    expire: vi.fn(async (key: string, ttl: number, flag?: string) => applyExpire(key, ttl, flag)),
    ttl: vi.fn(async (key: string) => ttls.get(key) ?? -1),
    pipeline: vi.fn(() => {
      const queued: ExpireCall[] = [];
      const chain = {
        expire(key: string, ttl: number, flag?: string) {
          queued.push([key, ttl, flag]);
          return chain;
        },
        exec: vi.fn(async () =>
          queued.map(([key, ttl, flag]) => [null, applyExpire(key, ttl, flag)]),
        ),
      };
      return chain;
    }),
  };
  return { ...base, ...overrides, ttls, expireCalls };
}

/** Every EXPIRE the fake saw, pipelined or not, as [key, ttl, flag]. */
function expiresFor(redis: ReturnType<typeof fakeRedis>, key: string): ExpireCall[] {
  return redis.expireCalls.filter(c => c[0] === key);
}

beforeEach(() => {
  getRedisMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cacheSet index expiry', () => {
  it('gives the index key a TTL matching the entry it indexes', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    const key = `cache:${BOOK}:income-expense:2026-01-01-2026-03-31`;
    await cacheSet(key, { monthly: [] }, 86400);

    expect(redis.setex).toHaveBeenCalledWith(key, 86400, JSON.stringify({ monthly: [] }));
    // Key format is load-bearing: the index name is the key minus its trailing
    // date range, and the score is the END of that range.
    expect(redis.zadd).toHaveBeenCalledWith(
      `idx:cache:${BOOK}:income-expense`,
      new Date('2026-03-31').getTime(),
      key,
    );
    // The decisive assertion: the index actually ENDS UP with a TTL. NX is what
    // gets it there on a fresh index; GT alone would have returned 0 and left
    // the key immortal.
    const indexKey = `idx:cache:${BOOK}:income-expense`;
    expect(redis.ttls.get(indexKey)).toBe(86400);
    expect(expiresFor(redis, indexKey)).toEqual([
      [indexKey, 86400, 'NX'],
      [indexKey, 86400, 'GT'],
    ]);
  });

  it('pushes an existing shorter TTL out, in the same round trip', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);
    const indexKey = `idx:cache:${BOOK}:kpis`;
    redis.ttls.set(indexKey, 300);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 86400);

    // NX declines (a TTL exists), GT wins.
    expect(redis.ttls.get(indexKey)).toBe(86400);
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
  });

  it('never pulls a longer TTL in', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);
    const indexKey = `idx:cache:${BOOK}:kpis`;
    redis.ttls.set(indexKey, 86400);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 300);

    // Neither flag applies: the longest-lived member still outlives its index.
    expect(redis.ttls.get(indexKey)).toBe(86400);
  });

  it('uses the caller-supplied TTL, not a fixed one', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 300);

    expect(redis.ttls.get(`idx:cache:${BOOK}:kpis`)).toBe(300);
  });

  it('indexes a single-date key on that date', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    const key = `cache:${BOOK}:net-worth:2026-03-31`;
    await cacheSet(key, [], 3600);

    expect(redis.zadd).toHaveBeenCalledWith(
      `idx:cache:${BOOK}:net-worth`,
      new Date('2026-03-31').getTime(),
      key,
    );
    expect(redis.ttls.get(`idx:cache:${BOOK}:net-worth`)).toBe(3600);
  });

  it('never shortens an index TTL on a Redis without the flags', async () => {
    const redis = fakeRedis({
      pipeline: vi.fn(() => ({
        expire() { return this; },
        exec: vi.fn(async () => [[new Error('ERR unsupported option NX'), null]]),
      })),
      // An entry with a longer TTL is already indexed here.
      ttl: vi.fn(async () => 86400),
      expire: vi.fn(async () => 1),
    });
    getRedisMock.mockReturnValue(redis);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 300);

    // The emulation decides 300 < 86400 and leaves it alone.
    expect(redis.ttl).toHaveBeenCalledWith(`idx:cache:${BOOK}:kpis`);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('sets the TTL on a flag-less Redis when the index has none yet', async () => {
    const redis = fakeRedis({
      pipeline: vi.fn(() => ({
        expire() { return this; },
        exec: vi.fn(async () => { throw new Error('ERR unsupported option NX'); }),
      })),
      ttl: vi.fn(async () => -1),
      expire: vi.fn(async () => 1),
    });
    getRedisMock.mockReturnValue(redis);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 300);

    expect(redis.expire).toHaveBeenLastCalledWith(`idx:cache:${BOOK}:kpis`, 300);
  });

  it('leaves un-dated keys unindexed, so nothing gains a stray TTL', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    await cacheSet(`cache:${BOOK}:hierarchy`, { tree: [] }, 60);

    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.zadd).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it('is a no-op without Redis', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(cacheSet(`cache:${BOOK}:kpis:2026-03-31`, {}, 60)).resolves.toBeUndefined();
  });

  it('swallows a failing EXPIRE rather than failing the write path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redis = fakeRedis({
      pipeline: vi.fn(() => { throw new Error('redis down'); }),
      ttl: vi.fn(async () => { throw new Error('redis down'); }),
    });
    getRedisMock.mockReturnValue(redis);

    await expect(cacheSet(`cache:${BOOK}:kpis:2026-03-31`, {}, 60)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
