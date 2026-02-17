import { getRedis } from './redis';

/**
 * Get a cached value. Returns null if Redis unavailable or key not found.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 86400): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
    // Track date-keyed entries in sorted sets for range invalidation
    const dateMatch = key.match(/:(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
      const dateScore = new Date(dateMatch[1]).getTime();
      const prefix = key.substring(0, key.length - dateMatch[1].length - 1);
      await redis.zadd(`idx:${prefix}`, dateScore, key);
    }
  } catch (err) {
    console.warn('Cache set failed:', err);
  }
}

/**
 * Invalidate all cache entries for a book from a given date forward.
 * Uses sorted set indexes for efficient range queries.
 */
export async function cacheInvalidateFrom(bookGuid: string, fromDate: Date): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  let invalidated = 0;
  const dateScore = fromDate.getTime();

  try {
    // Find all metric indexes for this book
    const indexKeys: string[] = [];
    const stream = redis.scanStream({ match: `idx:cache:${bookGuid}:*`, count: 100 });

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (keys: string[]) => indexKeys.push(...keys));
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    for (const indexKey of indexKeys) {
      const cacheKeys = await redis.zrangebyscore(indexKey, dateScore, '+inf');
      if (cacheKeys.length > 0) {
        await redis.del(...cacheKeys);
        await redis.zremrangebyscore(indexKey, dateScore, '+inf');
        invalidated += cacheKeys.length;
      }
    }
  } catch (err) {
    console.warn('Cache invalidation error:', err);
  }

  return invalidated;
}

/**
 * Clear all caches.
 */
export async function cacheClearAll(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  let deleted = 0;
  try {
    const keys: string[] = [];
    const stream = redis.scanStream({ match: 'cache:*', count: 100 });
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (k: string[]) => keys.push(...k));
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    // Also get index keys
    const idxStream = redis.scanStream({ match: 'idx:*', count: 100 });
    await new Promise<void>((resolve, reject) => {
      idxStream.on('data', (k: string[]) => keys.push(...k));
      idxStream.on('end', () => resolve());
      idxStream.on('error', (err) => reject(err));
    });

    if (keys.length > 0) {
      deleted = await redis.del(...keys);
    }
  } catch (err) {
    console.warn('Cache clear error:', err);
  }
  return deleted;
}
