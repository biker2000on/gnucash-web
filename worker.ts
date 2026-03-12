/**
 * GnuCash Web Background Worker
 *
 * Processes BullMQ jobs and manages internal refresh schedules.
 * Schedules are book-based: each book with refresh enabled gets its own timer.
 * Exposes HTTP health endpoint on WORKER_HEALTH_PORT (default 9090).
 */

import { Worker, Job } from 'bullmq';
import http from 'http';

// --- Internal schedule state ---
interface ScheduleEntry {
  bookGuid: string;
  refreshTime: string; // HH:MM in UTC
  timer: ReturnType<typeof setTimeout> | null;
}

const schedules = new Map<string, ScheduleEntry>(); // keyed by bookGuid
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
async function runRefreshForBook(bookGuid: string) {
  console.log(`[${new Date().toISOString()}] Scheduled refresh for book ${bookGuid}`);
  try {
    const { handleRefreshPrices } = await import('./src/lib/queue/jobs/refresh-prices');
    const fakeJob = { id: `scheduled-${Date.now()}`, name: 'refresh-prices', data: { bookGuid } } as Job;
    await handleRefreshPrices(fakeJob);
    console.log(`[${new Date().toISOString()}] Scheduled refresh completed for book ${bookGuid}`);
  } catch (err) {
    console.error(`Scheduled refresh failed for book ${bookGuid}:`, err);
  }
}

/**
 * Calculate milliseconds until the next occurrence of a given HH:MM (UTC).
 * If the time has already passed today, schedules for tomorrow.
 */
function msUntilNext(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hours, minutes, 0, 0);

  // If the target time has already passed today, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now.getTime();
}

function setSchedule(bookGuid: string, refreshTime: string) {
  clearSchedule(bookGuid);

  function scheduleNext() {
    const ms = msUntilNext(refreshTime);
    const nextRun = new Date(Date.now() + ms);
    console.log(`Next refresh for book ${bookGuid} at ${nextRun.toISOString()} (${refreshTime} UTC)`);

    const timer = setTimeout(async () => {
      await runRefreshForBook(bookGuid);
      // Reschedule for the next day
      scheduleNext();
    }, ms);

    schedules.set(bookGuid, { bookGuid, refreshTime, timer });
  }

  scheduleNext();
  console.log(`Schedule set: book ${bookGuid}, daily at ${refreshTime} UTC`);
}

function clearSchedule(bookGuid: string) {
  const existing = schedules.get(bookGuid);
  if (existing?.timer) {
    clearTimeout(existing.timer);
    schedules.delete(bookGuid);
    console.log(`Schedule cleared: book ${bookGuid}`);
  }
}

/**
 * On startup, query DB for all users with refresh_enabled=true
 * and set up schedules keyed by their book.
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
        const timePref = await prisma.gnucash_web_user_preferences.findUnique({
          where: {
            user_id_preference_key: {
              user_id: pref.user_id,
              preference_key: 'refresh_time',
            },
          },
          select: { preference_value: true },
        });

        const refreshTime = timePref
          ? JSON.parse(timePref.preference_value) || '21:00'
          : '21:00';

        // Find books this user has access to (via user_books or all books for admin)
        const firstBook = await prisma.books.findFirst({
          select: { guid: true },
        });

        if (firstBook && !schedules.has(firstBook.guid)) {
          setSchedule(firstBook.guid, refreshTime);
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
        case 'audit-price-history': {
          const { handleAuditPriceHistory } = await import('./src/lib/queue/jobs/audit-price-history');
          await handleAuditPriceHistory(job);
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
          const { bookGuid, enabled, refreshTime } = job.data as {
            userId?: number; // deprecated, kept for backward compat
            bookGuid?: string;
            enabled: boolean;
            refreshTime: string;
          };

          // Resolve bookGuid: use provided value, or look up from DB
          let resolvedBookGuid = bookGuid;
          if (!resolvedBookGuid) {
            const { PrismaClient } = await import('@prisma/client');
            const prisma = new PrismaClient();
            try {
              const firstBook = await prisma.books.findFirst({ select: { guid: true } });
              resolvedBookGuid = firstBook?.guid;
            } finally {
              await prisma.$disconnect();
            }
          }

          if (resolvedBookGuid) {
            if (enabled) {
              setSchedule(resolvedBookGuid, refreshTime || '21:00');
            } else {
              clearSchedule(resolvedBookGuid);
            }
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

  worker.on('completed', () => {
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
    for (const [bookGuid] of schedules) {
      clearSchedule(bookGuid);
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
