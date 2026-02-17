import Redis from 'ioredis';

let redis: Redis | null = null;
let connectionFailed = false;

/**
 * Get Redis connection singleton.
 * Returns null if REDIS_URL is not set or connection has failed.
 * Uses finite retry limits so commands fail fast instead of hanging.
 */
export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (connectionFailed) return null;

  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) {
          console.warn('Redis: max connection retries reached, disabling Redis for this process');
          connectionFailed = true;
          return null; // Stop retrying
        }
        return Math.min(times * 500, 2000);
      },
    });
    redis.on('error', (err) => console.warn('Redis connection error:', err.message));
  }
  return redis;
}

/**
 * Get a separate Redis connection config for BullMQ (needs maxRetriesPerRequest: null).
 * Returns null if REDIS_URL is not set or connection has previously failed.
 */
export function getBullMQConnection(): { host: string; port: number; password?: string; db?: number; maxRetriesPerRequest: null } | null {
  if (!process.env.REDIS_URL || connectionFailed) return null;
  try {
    const parsed = new URL(process.env.REDIS_URL);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      db: parseInt(parsed.pathname.slice(1) || '0', 10),
      maxRetriesPerRequest: null,
    };
  } catch {
    return null;
  }
}

export function isRedisAvailable(): boolean {
  return !!process.env.REDIS_URL && !connectionFailed;
}
