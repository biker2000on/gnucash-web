/**
 * Login attempt throttling.
 *
 * Password login had no attempt counter, no delay, and no lockout, so an
 * online brute force against a known username was unbounded (audit finding
 * S10). Counters live in Redis and are keyed by username AND client IP so
 * neither a single account nor a single source can be hammered.
 *
 * Fails OPEN when Redis is unavailable: this is a self-hosted app and locking
 * everyone out because the cache is down is worse than the risk it mitigates.
 */

import { getRedis } from './redis';

const WINDOW_SECONDS = 15 * 60;
/** Attempts allowed in the window before the lockout applies. */
const MAX_ATTEMPTS = 5;
/** Lockout once MAX_ATTEMPTS is exceeded, growing with continued attempts. */
const BASE_LOCKOUT_SECONDS = 30;
const MAX_LOCKOUT_SECONDS = 15 * 60;

export interface ThrottleDecision {
    allowed: boolean;
    /** Seconds the caller must wait. Only meaningful when not allowed. */
    retryAfterSeconds: number;
}

const ALLOWED: ThrottleDecision = { allowed: true, retryAfterSeconds: 0 };

function keysFor(username: string, ip: string): string[] {
    return [
        `login:fail:user:${username.toLowerCase()}`,
        `login:fail:ip:${ip}`,
    ];
}

/** Exponential backoff on the count of failures beyond the free allowance. */
function lockoutSeconds(failures: number): number {
    const over = failures - MAX_ATTEMPTS;
    if (over <= 0) return 0;
    return Math.min(BASE_LOCKOUT_SECONDS * 2 ** (over - 1), MAX_LOCKOUT_SECONDS);
}

/** Check whether this username/IP pair may attempt a login right now. */
export async function checkLoginAllowed(
    username: string,
    ip: string,
): Promise<ThrottleDecision> {
    const redis = getRedis();
    if (!redis) return ALLOWED;

    try {
        const counts = await redis.mget(...keysFor(username, ip));
        let worst = 0;
        for (const raw of counts) {
            const n = raw ? parseInt(raw, 10) : 0;
            if (Number.isFinite(n) && n > worst) worst = n;
        }
        const wait = lockoutSeconds(worst);
        return wait > 0 ? { allowed: false, retryAfterSeconds: wait } : ALLOWED;
    } catch {
        return ALLOWED;
    }
}

/** Record a failed attempt against both the username and the source IP. */
export async function recordLoginFailure(username: string, ip: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        const pipeline = redis.pipeline();
        for (const key of keysFor(username, ip)) {
            pipeline.incr(key);
            pipeline.expire(key, WINDOW_SECONDS);
        }
        await pipeline.exec();
    } catch {
        // Throttling is best-effort; never block a login path on the cache.
    }
}

/** Clear counters after a successful authentication. */
export async function clearLoginFailures(username: string, ip: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.del(...keysFor(username, ip));
    } catch {
        // Best-effort.
    }
}

/** Best-effort client IP from proxy headers, falling back to a constant. */
export function clientIpFrom(headers: Headers): string {
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    return headers.get('x-real-ip')?.trim() || 'unknown';
}
