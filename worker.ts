/**
 * GnuCash Web Background Worker
 *
 * Processes BullMQ jobs for price refresh, cache aggregation, and index backfill.
 * Run as a separate process: npx tsx worker.ts
 */

import { Worker, Job } from 'bullmq';

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL environment variable is required');
    process.exit(1);
  }

  // Parse Redis URL for connection config
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
  };

  console.log('Starting GnuCash Web worker...');
  console.log(`Connecting to Redis at ${url.hostname}:${url.port || 6379}`);

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
        case 'cache-aggregations': {
          const { handleCacheAggregations } = await import('./src/lib/queue/jobs/cache-aggregations');
          await handleCacheAggregations(job);
          break;
        }
        case 'backfill-indices': {
          const { backfillIndexPrices } = await import('./src/lib/market-index-service');
          const results = await backfillIndexPrices();
          console.log(`Backfill results:`, results);
          break;
        }
        default:
          console.warn(`Unknown job type: ${job.name}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] Job ${job.name} (${job.id}) completed in ${elapsed}s`);
    } catch (error) {
      console.error(`Job ${job.name} (${job.id}) failed:`, error);
      throw error; // Re-throw so BullMQ marks it as failed
    }
  }, {
    connection,
    concurrency: 1,
  });

  worker.on('completed', (job) => {
    // Already logged above
  });

  worker.on('failed', (job, err) => {
    console.error(`[${new Date().toISOString()}] Job ${job?.name} (${job?.id}) FAILED:`, err.message);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down worker...');
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
