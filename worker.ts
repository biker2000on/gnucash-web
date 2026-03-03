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
    const fakeJob = { id: `scheduled-${Date.now()}`, name: 'refresh-prices', data: { userId, bookGuid } } as Job;
    await handleRefreshPrices(fakeJob);
    console.log(`[${new Date().toISOString()}] Scheduled refresh completed for user ${userId}`);
  } catch (err) {
    console.error(`Scheduled refresh failed for user ${userId}:`, err);
  }
}

function setSchedule(userId: number, bookGuid: string, intervalHours: number) {
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
