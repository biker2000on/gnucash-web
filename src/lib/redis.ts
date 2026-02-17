import Redis from 'ioredis';

let redis: Redis | null = null;

/**
 * Get Redis connection singleton.
 * Returns null if REDIS_URL is not set (graceful degradation).
 */
export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null, // Required for BullMQ
      lazyConnect: true,
    });
    redis.on('error', (err) => console.warn('Redis connection error:', err.message));
  }
  return redis;
}

export function isRedisAvailable(): boolean {
  return !!process.env.REDIS_URL;
}
