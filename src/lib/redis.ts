import Redis from 'ioredis';

let redis: Redis | null = null;
let initializing: Promise<Redis | null> | null = null;
let retryAfterMs = 0;
const REDIS_RETRY_COOLDOWN_MS = 30_000;

/**
 * Get Redis connection singleton.
 * Returns null if REDIS_URL is not set or a failed connection is cooling down.
 * Uses finite retry limits so commands fail fast instead of hanging.
 */
export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (Date.now() < retryAfterMs) return null;

  if (!redis && !initializing) {
    initializing = new Promise<Redis | null>((resolve) => {
      const instance = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
        retryStrategy(times) {
          if (times > 3) {
            console.warn('Redis: connection retries exhausted; retrying after a 30s cooldown');
            retryAfterMs = Date.now() + REDIS_RETRY_COOLDOWN_MS;
            return null;
          }
          return Math.min(times * 500, 2000);
        },
      });
      instance.on('error', (err) => console.warn('Redis connection error:', err.message));
      instance.on('ready', () => { retryAfterMs = 0; });
      instance.on('end', () => {
        if (redis === instance) redis = null;
        initializing = null;
      });
      redis = instance;
      initializing = null;
      resolve(instance);
    });
  }
  return redis;
}

/**
 * Get a separate Redis connection config for BullMQ (needs maxRetriesPerRequest: null).
 * Returns null only when REDIS_URL is absent or invalid. BullMQ owns its
 * reconnect policy independently of the shared command client's cooldown.
 */
export function getBullMQConnection(): { host: string; port: number; password?: string; db?: number; maxRetriesPerRequest: null } | null {
  if (!process.env.REDIS_URL) return null;
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
  return !!process.env.REDIS_URL && Date.now() >= retryAfterMs;
}
