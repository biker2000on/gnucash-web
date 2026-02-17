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
  } catch (err) {
    console.warn('Failed to schedule refresh prices:', err);
  }
}

/**
 * Enqueue an immediate one-off job.
 */
export async function enqueueJob(name: string, data: Record<string, unknown> = {}): Promise<string | undefined> {
  const queue = getJobQueue();
  if (!queue) return undefined;
  try {
    const job = await queue.add(name, data, {
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return job.id ?? undefined;
  } catch (err) {
    console.warn('Failed to enqueue job:', err);
    return undefined;
  }
}
