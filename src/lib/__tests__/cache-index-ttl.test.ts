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

function fakeRedis(overrides: Record<string, unknown> = {}) {
  return {
    setex: vi.fn(async () => 'OK'),
    zadd: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -1),
    ...overrides,
  };
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
    expect(redis.expire).toHaveBeenCalledWith(`idx:cache:${BOOK}:income-expense`, 86400, 'GT');
  });

  it('uses the caller-supplied TTL, not a fixed one', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 300);

    expect(redis.expire).toHaveBeenCalledWith(`idx:cache:${BOOK}:kpis`, 300, 'GT');
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
    expect(redis.expire).toHaveBeenCalledWith(`idx:cache:${BOOK}:net-worth`, 3600, 'GT');
  });

  it('never shortens an index TTL on a Redis without the GT flag', async () => {
    const redis = fakeRedis({
      expire: vi.fn(async (_key: string, _ttl: number, flag?: string) => {
        if (flag) throw new Error('ERR wrong number of arguments');
        return 1;
      }),
      // An entry with a longer TTL is already indexed here.
      ttl: vi.fn(async () => 86400),
    });
    getRedisMock.mockReturnValue(redis);

    await cacheSet(`cache:${BOOK}:kpis:2026-03-31`, { net: 1 }, 300);

    // GT attempt, then the emulation decides 300 < 86400 and leaves it alone.
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.ttl).toHaveBeenCalledWith(`idx:cache:${BOOK}:kpis`);
  });

  it('sets the TTL on a GT-less Redis when the index has none yet', async () => {
    const redis = fakeRedis({
      expire: vi.fn(async (_key: string, _ttl: number, flag?: string) => {
        if (flag) throw new Error('ERR wrong number of arguments');
        return 1;
      }),
      ttl: vi.fn(async () => -1),
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
  });

  it('is a no-op without Redis', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(cacheSet(`cache:${BOOK}:kpis:2026-03-31`, {}, 60)).resolves.toBeUndefined();
  });

  it('swallows a failing EXPIRE rather than failing the write path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redis = fakeRedis({
      expire: vi.fn(async () => { throw new Error('redis down'); }),
      ttl: vi.fn(async () => { throw new Error('redis down'); }),
    });
    getRedisMock.mockReturnValue(redis);

    await expect(cacheSet(`cache:${BOOK}:kpis:2026-03-31`, {}, 60)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
