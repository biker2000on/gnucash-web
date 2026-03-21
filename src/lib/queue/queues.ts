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
 * Signal the worker to update its internal refresh schedule.
 * Schedule is keyed by bookGuid. The worker manages timers per book.
 */
export async function signalScheduleChanged(bookGuid: string, enabled: boolean, intervalHours: number, refreshTime: string = '21:00'): Promise<void> {
  await enqueueJob('schedule-changed', { bookGuid, enabled, intervalHours, refreshTime });
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
