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
    // Index the key in a sorted set scored by the LATEST date the cache covers,
    // so cacheInvalidateFrom(fromDate) can range-delete anything whose coverage
    // extends through or past fromDate.
    // Supported key shapes (the trailing date portion after the final ":"):
    //   cache:BOOK:metric:YYYY-MM-DD                      (single-date)
    //   cache:BOOK:metric:YYYY-MM-DD-YYYY-MM-DD           (date range, score = end date)
    const range = key.match(/:(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/);
    const single = !range ? key.match(/:(\d{4}-\d{2}-\d{2})$/) : null;
    if (range || single) {
      const endDate = range ? range[2] : single![1];
      const dateScore = new Date(endDate).getTime();
      // Index groups all keys of a given metric+book together.
      // Strip the trailing ":DATE" or ":DATE-DATE" from the key to form the prefix.
      const tail = range ? `:${range[1]}-${range[2]}` : `:${single![1]}`;
      const indexKey = `idx:${key.slice(0, -tail.length)}`;
      await redis.zadd(indexKey, dateScore, key);
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
