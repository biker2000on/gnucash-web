import { Queue } from 'bullmq';

let jobQueue: Queue | null = null;

/**
 * Parse Redis URL into connection options.
 * Format: redis://[:password@]host[:port][/db]
 */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    db: parseInt(parsed.pathname.slice(1) || '0', 10),
    maxRetriesPerRequest: null,
  };
}

export function getJobQueue(): Queue | null {
  if (!process.env.REDIS_URL) return null;
  if (!jobQueue) {
    jobQueue = new Queue('gnucash-jobs', {
      connection: parseRedisUrl(process.env.REDIS_URL),
    });
  }
  return jobQueue;
}

/**
 * Schedule recurring price refresh job.
 */
export async function scheduleRefreshPrices(intervalHours: number = 24): Promise<void> {
  const queue = getJobQueue();
  if (!queue) return;

  // Remove existing repeatable jobs with this name
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'refresh-prices') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add('refresh-prices', {}, {
    repeat: { every: intervalHours * 60 * 60 * 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

/**
 * Enqueue an immediate one-off job.
 */
export async function enqueueJob(name: string, data: Record<string, unknown> = {}): Promise<string | undefined> {
  const queue = getJobQueue();
  if (!queue) return undefined;
  const job = await queue.add(name, data, {
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return job.id ?? undefined;
}
