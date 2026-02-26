import { Queue } from 'bullmq';
import { getBullMQConnection } from '../redis';

let jobQueue: Queue | null = null;

export function getJobQueue(): Queue | null {
  const connection = getBullMQConnection();
  if (!connection) return null;
  if (!jobQueue) {
    try {
      jobQueue = new Queue('gnucash-jobs', { connection });
    } catch (err) {
      console.warn('Failed to create job queue:', err);
      return null;
    }
  }
  return jobQueue;
}

/**
 * Schedule recurring price refresh job.
 */
export async function scheduleRefreshPrices(intervalHours: number = 24): Promise<void> {
  const queue = getJobQueue();
  if (!queue) return;

  try {
    const withTimeout = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), 5000)
        ),
      ]);

    const existing = await withTimeout(queue.getRepeatableJobs());
    for (const job of existing) {
      if (job.name === 'refresh-prices') {
        await withTimeout(queue.removeRepeatableByKey(job.key));
      }
    }

    await withTimeout(queue.add('refresh-prices', {}, {
      repeat: { every: intervalHours * 60 * 60 * 1000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    }));
  } catch (err) {
    console.warn('Failed to schedule refresh prices:', err);
    jobQueue = null;
  }
}

/**
 * Enqueue an immediate one-off job.
 * Returns undefined (triggering direct fallback) if Redis is unavailable.
 */
export async function enqueueJob(name: string, data: Record<string, unknown> = {}): Promise<string | undefined> {
  const queue = getJobQueue();
  if (!queue) return undefined;
  try {
    const job = await Promise.race([
      queue.add(name, data, {
        removeOnComplete: 100,
        removeOnFail: 50,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis enqueue timeout')), 5000)
      ),
    ]);
    return job.id ?? undefined;
  } catch (err) {
    console.warn('Failed to enqueue job:', err);
    // Reset queue so next attempt creates a fresh connection
    jobQueue = null;
    return undefined;
  }
}
