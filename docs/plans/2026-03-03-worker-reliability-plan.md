# Worker Reliability & Nightly Refresh Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the nightly price refresh not firing, fix prices not reaching current date, and improve worker reliability.

**Architecture:** Move scheduling authority from the app process (BullMQ repeatable jobs) to the worker process (internal setInterval). Fix the Yahoo Finance date range ceiling from `getYesterday()` to `new Date()`. Add health checks, job timeouts, and fix Redis race condition.

**Tech Stack:** BullMQ, Node.js `http` module, Prisma ORM, yahoo-finance2

---

### Task 1: Fix price refresh date range ceiling

The core bug: `getYesterday()` caps Yahoo's `period2` at yesterday midnight UTC. Replace with `new Date()` and let Yahoo determine the latest close.

**Files:**
- Modify: `src/lib/yahoo-price-service.ts:66-72` (getYesterday), `389-535` (fetchAndStorePrices), `163-204` (detectAndFillGaps)
- Modify: `src/lib/market-index-service.ts:95-146` (fetchIndexPrices)

**Step 1: Update `fetchAndStorePrices()` to use `new Date()` as the end date**

In `src/lib/yahoo-price-service.ts`, replace the `getYesterday()` call at the top of `fetchAndStorePrices()` with `new Date()`. The function currently has:

```typescript
const yesterday = getYesterday();
```

Change all instances of `yesterday` to `endDate` and set it to `new Date()`:

```typescript
const endDate = new Date();
```

Update all references within `fetchAndStorePrices()`:
- PATH 1 (force): `startDate` calculation uses `endDate`, `getExistingPriceDates(..., endDate)`, `fetchHistoricalPrices(symbol, startDate, endDate)`
- PATH 2 (first-time): same pattern
- PATH 3 (normal): `backfillStart <= endDate`, `getExistingPriceDates(..., endDate)`, `fetchHistoricalPrices(symbol, backfillStart, endDate)`

**Step 2: Update `detectAndFillGaps()` to use `new Date()`**

In `src/lib/yahoo-price-service.ts:163-204`, replace:
```typescript
const yesterday = getYesterday();
```
with:
```typescript
const endDate = new Date();
```
And update all references from `yesterday` to `endDate`.

**Step 3: Update `fetchIndexPrices()` in market-index-service.ts**

In `src/lib/market-index-service.ts:95-146`, the function currently calculates:
```typescript
const endDate = new Date();
endDate.setUTCHours(0, 0, 0, 0);
endDate.setUTCDate(endDate.getUTCDate() - 1); // yesterday
```

Replace with:
```typescript
const endDate = new Date();
```

Remove the two lines that subtract a day and zero out hours.

**Step 4: Remove `getYesterday()` function**

Delete the `getYesterday()` function (lines 66-72) from `yahoo-price-service.ts`. It is no longer used.

**Step 5: Build to verify no type errors**

Run: `npm run build`
Expected: Build succeeds with no errors related to `getYesterday` or `yesterday` variable.

**Step 6: Commit**

```bash
git add src/lib/yahoo-price-service.ts src/lib/market-index-service.ts
git commit -m "fix: use current time as Yahoo Finance period2 instead of yesterday ceiling

getYesterday() artificially capped the date range, preventing prices from
being fetched for the most recent market close. Yahoo's chart API only
returns completed daily closes, so deduplication handles safety."
```

---

### Task 2: Fix Redis singleton race condition

**Files:**
- Modify: `src/lib/redis.ts`

**Step 1: Replace mutable `connectionFailed` flag with promise-based initialization**

Replace the entire `src/lib/redis.ts` with:

```typescript
import Redis from 'ioredis';

let redis: Redis | null = null;
let connectionFailed = false;
let initializing: Promise<Redis | null> | null = null;

/**
 * Get Redis connection singleton.
 * Returns null if REDIS_URL is not set or connection has failed.
 * Uses a promise guard to prevent race conditions during initialization.
 */
export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (connectionFailed) return null;

  if (!redis && !initializing) {
    initializing = new Promise<Redis | null>((resolve) => {
      const instance = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
        retryStrategy(times) {
          if (times > 3) {
            console.warn('Redis: max connection retries reached, disabling Redis for this process');
            connectionFailed = true;
            return null;
          }
          return Math.min(times * 500, 2000);
        },
      });
      instance.on('error', (err) => console.warn('Redis connection error:', err.message));
      redis = instance;
      initializing = null;
      resolve(instance);
    });
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
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/lib/redis.ts
git commit -m "fix: prevent Redis singleton race condition during initialization

Use a promise guard to ensure only one Redis instance is created even
if getRedis() is called concurrently."
```

---

### Task 3: Remove cache-aggregations placeholder

**Files:**
- Delete: `src/lib/queue/jobs/cache-aggregations.ts`
- Modify: `worker.ts:39-43` (remove case)

**Step 1: Remove the `cache-aggregations` case from worker.ts**

In `worker.ts`, delete lines 39-43:
```typescript
        case 'cache-aggregations': {
          const { handleCacheAggregations } = await import('./src/lib/queue/jobs/cache-aggregations');
          await handleCacheAggregations(job);
          break;
        }
```

**Step 2: Delete the handler file**

Delete `src/lib/queue/jobs/cache-aggregations.ts`.

**Step 3: Build to verify no broken imports**

Run: `npm run build`
Expected: No errors. Nothing else imports `cache-aggregations`.

**Step 4: Commit**

```bash
git rm src/lib/queue/jobs/cache-aggregations.ts
git add worker.ts
git commit -m "chore: remove cache-aggregations placeholder job

The handler was a no-op. Cache warming uses the cache-aside pattern
in API routes. Re-add if explicit pre-warming is needed later."
```

---

### Task 4: Replace app-side scheduling with signal job

Replace `scheduleRefreshPrices()`/`unscheduleRefreshPrices()` with a `schedule-changed` signal that tells the worker to reconfigure.

**Files:**
- Modify: `src/lib/queue/queues.ts`
- Modify: `src/app/api/settings/schedules/route.ts`

**Step 1: Replace scheduling functions in queues.ts**

Replace the `scheduleRefreshPrices()` and `unscheduleRefreshPrices()` functions (lines 20-80) with a single signal function:

```typescript
/**
 * Signal the worker to update its internal refresh schedule.
 * The worker reads the preference from DB and reconfigures its timer.
 */
export async function signalScheduleChanged(userId: number, enabled: boolean, intervalHours: number): Promise<void> {
  await enqueueJob('schedule-changed', { userId, enabled, intervalHours });
}
```

**Step 2: Update the schedules API route**

In `src/app/api/settings/schedules/route.ts`, replace the import:
```typescript
import { scheduleRefreshPrices, unscheduleRefreshPrices } from '@/lib/queue/queues';
```
with:
```typescript
import { signalScheduleChanged } from '@/lib/queue/queues';
```

In the PATCH handler, replace:
```typescript
    if (isEnabled) {
      const hours = intervalHours !== undefined
        ? intervalHours
        : await getPreference<number | string>(roleResult.user.id, 'refresh_interval_hours', 24);
      await scheduleRefreshPrices(typeof hours === 'number' ? hours : parseInt(String(hours)));
    } else if (enabled === false) {
      await unscheduleRefreshPrices();
    }
```
with:
```typescript
    const effectiveHours = intervalHours !== undefined
      ? (typeof intervalHours === 'number' ? intervalHours : parseInt(String(intervalHours)))
      : await getPreference<number | string>(roleResult.user.id, 'refresh_interval_hours', 24).then(
          h => typeof h === 'number' ? h : parseInt(String(h))
        );
    await signalScheduleChanged(roleResult.user.id, isEnabled, effectiveHours);
```

**Step 3: Build to verify**

Run: `npm run build`
Expected: No errors. The old `scheduleRefreshPrices`/`unscheduleRefreshPrices` imports are gone.

**Step 4: Commit**

```bash
git add src/lib/queue/queues.ts src/app/api/settings/schedules/route.ts
git commit -m "refactor: replace BullMQ repeatable jobs with schedule-changed signal

The app no longer manages BullMQ repeatable jobs directly. Instead it
enqueues a 'schedule-changed' signal job. The worker handles scheduling
internally, surviving restarts by reading preferences from the DB."
```

---

### Task 5: Add worker-side scheduling and health check

The main event: the worker reads schedules from DB on startup, manages internal timers, handles `schedule-changed` signals, and exposes a health endpoint.

**Files:**
- Modify: `worker.ts` (major rewrite)
- Modify: `docker-compose.yml` (add healthcheck)

**Step 1: Rewrite worker.ts with scheduling, health check, and job timeout**

Replace `worker.ts` entirely:

```typescript
/**
 * GnuCash Web Background Worker
 *
 * Processes BullMQ jobs and manages internal refresh schedules.
 * Reads user preferences from DB on startup to recover schedules after restart.
 * Exposes HTTP health endpoint on WORKER_HEALTH_PORT (default 9090).
 */

import { Worker, Job } from 'bullmq';
import http from 'http';

// --- Internal schedule state ---
interface ScheduleEntry {
  userId: number;
  bookGuid: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval> | null;
}

const schedules = new Map<number, ScheduleEntry>(); // keyed by userId
let workerReady = false;

// --- Health check server ---
function startHealthServer(port: number) {
  const server = http.createServer((_req, res) => {
    if (workerReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', schedules: schedules.size }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting' }));
    }
  });
  server.listen(port, () => {
    console.log(`Health check listening on port ${port}`);
  });
  return server;
}

// --- Schedule management ---
async function runRefreshForUser(userId: number, bookGuid: string) {
  console.log(`[${new Date().toISOString()}] Scheduled refresh for user ${userId}, book ${bookGuid}`);
  try {
    const { handleRefreshPrices } = await import('./src/lib/queue/jobs/refresh-prices');
    // Create a minimal Job-like object for the handler
    const fakeJob = { id: `scheduled-${Date.now()}`, name: 'refresh-prices', data: { userId, bookGuid } } as Job;
    await handleRefreshPrices(fakeJob);
    console.log(`[${new Date().toISOString()}] Scheduled refresh completed for user ${userId}`);
  } catch (err) {
    console.error(`Scheduled refresh failed for user ${userId}:`, err);
  }
}

function setSchedule(userId: number, bookGuid: string, intervalHours: number) {
  // Clear existing schedule for this user
  clearSchedule(userId);

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const entry: ScheduleEntry = {
    userId,
    bookGuid,
    intervalMs,
    timer: setInterval(() => runRefreshForUser(userId, bookGuid), intervalMs),
  };
  schedules.set(userId, entry);
  console.log(`Schedule set: user ${userId}, every ${intervalHours}h`);
}

function clearSchedule(userId: number) {
  const existing = schedules.get(userId);
  if (existing?.timer) {
    clearInterval(existing.timer);
    schedules.delete(userId);
    console.log(`Schedule cleared: user ${userId}`);
  }
}

/**
 * On startup, query DB for all users with refresh_enabled=true
 * and set up their schedules.
 */
async function recoverSchedules() {
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      // Find all users with refresh_enabled = true
      const enabledPrefs = await prisma.gnucash_web_user_preferences.findMany({
        where: { preference_key: 'refresh_enabled', preference_value: 'true' },
        select: { user_id: true },
      });

      for (const pref of enabledPrefs) {
        // Get interval (default 24 hours)
        const intervalPref = await prisma.gnucash_web_user_preferences.findUnique({
          where: {
            user_id_preference_key: {
              user_id: pref.user_id,
              preference_key: 'refresh_interval_hours',
            },
          },
          select: { preference_value: true },
        });

        const intervalHours = intervalPref
          ? parseInt(JSON.parse(intervalPref.preference_value), 10) || 24
          : 24;

        // Get the first book guid (single-user app, no session context in worker)
        const firstBook = await prisma.books.findFirst({
          select: { guid: true },
        });

        if (firstBook) {
          setSchedule(pref.user_id, firstBook.guid, intervalHours);
        }
      }

      console.log(`Recovered ${schedules.size} schedule(s) from DB`);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.error('Failed to recover schedules from DB:', err);
  }
}

// --- Main ---
async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL environment variable is required');
    process.exit(1);
  }

  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
  };

  const healthPort = parseInt(process.env.WORKER_HEALTH_PORT || '9090', 10);

  console.log('Starting GnuCash Web worker...');
  console.log(`Connecting to Redis at ${url.hostname}:${url.port || 6379}`);

  // Recover schedules from DB before processing jobs
  await recoverSchedules();

  const worker = new Worker('gnucash-jobs', async (job: Job) => {
    console.log(`[${new Date().toISOString()}] Processing job: ${job.name} (${job.id})`);
    const startTime = Date.now();

    try {
      switch (job.name) {
        case 'refresh-prices': {
          const { handleRefreshPrices } = await import('./src/lib/queue/jobs/refresh-prices');
          await handleRefreshPrices(job);
          break;
        }
        case 'backfill-indices': {
          const { backfillIndexPrices } = await import('./src/lib/market-index-service');
          const results = await backfillIndexPrices();
          console.log(`Backfill results:`, results);
          break;
        }
        case 'sync-simplefin': {
          const { connectionId, bookGuid } = job.data as { connectionId: number; bookGuid: string };
          const { syncSimpleFin } = await import('./src/lib/services/simplefin-sync.service');
          const syncResult = await syncSimpleFin(connectionId, bookGuid);
          console.log(`SimpleFin sync: ${syncResult.transactionsImported} imported, ${syncResult.transactionsSkipped} skipped, ${syncResult.investmentTransactionsImported} investment txns`);
          break;
        }
        case 'schedule-changed': {
          const { userId, enabled, intervalHours } = job.data as {
            userId: number;
            enabled: boolean;
            intervalHours: number;
          };

          if (enabled) {
            // Get book guid for this user
            const { PrismaClient } = await import('@prisma/client');
            const prisma = new PrismaClient();
            try {
              const firstBook = await prisma.books.findFirst({ select: { guid: true } });
              if (firstBook) {
                setSchedule(userId, firstBook.guid, intervalHours);
              }
            } finally {
              await prisma.$disconnect();
            }
          } else {
            clearSchedule(userId);
          }
          break;
        }
        default:
          console.warn(`Unknown job type: ${job.name}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] Job ${job.name} (${job.id}) completed in ${elapsed}s`);
    } catch (error) {
      console.error(`Job ${job.name} (${job.id}) failed:`, error);
      throw error;
    }
  }, {
    connection,
    concurrency: 1,
    lockDuration: 300000, // 5 minute lock (acts as job timeout)
  });

  worker.on('completed', (_job) => {
    // Already logged above
  });

  worker.on('failed', (job, err) => {
    console.error(`[${new Date().toISOString()}] Job ${job?.name} (${job?.id}) FAILED:`, err.message);
  });

  workerReady = true;
  const healthServer = startHealthServer(healthPort);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down worker...');
    // Clear all scheduled timers
    for (const [userId] of schedules) {
      clearSchedule(userId);
    }
    healthServer.close();
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('Worker started, waiting for jobs...');
}

main().catch((err) => {
  console.error('Worker startup failed:', err);
  process.exit(1);
});
```

**Step 2: Add healthcheck to docker-compose.yml**

In `docker-compose.yml`, add healthcheck and port to the worker service:

```yaml
  worker:
    build: .
    command: ["npx", "tsx", "worker.ts"]
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - WORKER_HEALTH_PORT=9090
    depends_on:
      redis:
        condition: service_started
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:9090"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

**Step 3: Build to verify**

Run: `npm run build`
Expected: No type errors. Worker compiles cleanly.

**Step 4: Commit**

```bash
git add worker.ts docker-compose.yml
git commit -m "feat: worker-side scheduling with startup recovery and health check

Worker now reads refresh_enabled preferences from DB on startup and
manages internal setInterval timers. Handles 'schedule-changed' signal
from the app to reconfigure schedules at runtime. Adds HTTP health
endpoint on port 9090. Adds 5-minute job lock duration as timeout.
Docker compose worker service gets healthcheck directive."
```

---

### Task 6: Final verification

**Step 1: Full build check**

Run: `npm run build`
Expected: Clean build, zero errors.

**Step 2: Lint check**

Run: `npm run lint`
Expected: No new lint errors.

**Step 3: Verify no broken imports**

Run: `npx tsc --noEmit`
Expected: No type errors.

**Step 4: Manual review checklist**

- [ ] `getYesterday()` removed, all references replaced with `new Date()`
- [ ] `scheduleRefreshPrices` / `unscheduleRefreshPrices` removed from `queues.ts`
- [ ] `signalScheduleChanged` added to `queues.ts`
- [ ] Schedules API route uses `signalScheduleChanged`
- [ ] Worker handles `schedule-changed` job
- [ ] Worker recovers schedules from DB on startup
- [ ] Worker has health endpoint on port 9090
- [ ] `cache-aggregations` handler deleted
- [ ] Redis initialization has promise guard
- [ ] Docker compose has worker healthcheck

**Step 5: Commit any remaining fixes**

If lint or build revealed issues, fix and commit.
