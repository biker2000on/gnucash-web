import { Queue, type JobsOptions } from 'bullmq';
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

/** Payload for the extract-statement job (statement ingestion pipeline). */
export interface ExtractStatementJobData {
  batchId: number;
  bookGuid?: string;
  userId?: number;
  autoRecoveryAttempt?: number;
  preserveRecoveryAttempt?: number;
}

/**
 * Enqueue a statement-extraction job. Returns the job id, or undefined if
 * Redis is unavailable (caller should then run extraction inline).
 */
export async function enqueueExtractStatement(
  data: ExtractStatementJobData,
  options: Pick<JobsOptions, 'delay' | 'jobId' | 'attempts' | 'backoff'> = {},
): Promise<string | undefined> {
  return enqueueJob('extract-statement', data as unknown as Record<string, unknown>, options);
}

/** Default retry policy: a transient Redis/DB blip must not lose the job. */
const DEFAULT_JOB_ATTEMPTS = 3;
const DEFAULT_JOB_BACKOFF: JobsOptions['backoff'] = { type: 'exponential', delay: 5_000 };

/**
 * Jobs that must NOT use the generic retry policy, because they already own
 * their failure handling and a blind retry would duplicate its side effects.
 */
const JOB_RETRY_OVERRIDES: Record<string, Pick<JobsOptions, 'attempts'>> = {
  // Has a durable retry ledger of its own (queue/statement-recovery.ts), and
  // a PDF retry costs a paid AI extraction call.
  'extract-statement': { attempts: 1 },
  // The sync service persists its own status and raises a user notification on
  // failure; BullMQ retries would raise that notification once per attempt.
  'sync-simplefin': { attempts: 1 },
};

const ENQUEUE_TIMEOUT_MS = 5_000;
const JOB_LOOKUP_TIMEOUT_MS = 2_000;

/** Race `promise` against a timeout, always clearing the timer. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Enqueue an immediate one-off job.
 * Returns undefined (triggering direct fallback) if Redis is unavailable.
 *
 * Callers that fall back to running the work inline MUST pass a deterministic
 * `jobId`: `Promise.race` cannot cancel the losing `queue.add`, so a slow-but-
 * successful enqueue would otherwise have the worker AND the request both run
 * the job. With a deterministic id the queue itself dedupes, and the timeout
 * path can look the job up before reporting failure.
 */
export async function enqueueJob(
  name: string,
  data: Record<string, unknown> = {},
  options: Pick<JobsOptions, 'delay' | 'jobId' | 'attempts' | 'backoff'> = {},
): Promise<string | undefined> {
  const queue = getJobQueue();
  if (!queue) return undefined;

  const addPromise = queue.add(name, data, {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: DEFAULT_JOB_BACKOFF,
    ...JOB_RETRY_OVERRIDES[name],
    ...options,
  });
  // The race below may leave this promise pending/rejecting unobserved.
  addPromise.catch(() => { /* handled via the race / lookup below */ });

  try {
    const job = await withTimeout(addPromise, ENQUEUE_TIMEOUT_MS, 'Redis enqueue timeout');
    return job.id ?? undefined;
  } catch (err) {
    console.warn('Failed to enqueue job:', err);

    // The add may still be in flight and may still succeed. When a
    // deterministic id was supplied we can ask the queue whether the job
    // exists, instead of telling the caller to run the work a second time.
    if (options.jobId) {
      try {
        const existing = await withTimeout(
          queue.getJob(options.jobId),
          JOB_LOOKUP_TIMEOUT_MS,
          'Redis job lookup timeout',
        );
        if (existing) {
          console.warn(`Slow enqueue for ${name} landed after the timeout; not running inline.`);
          return existing.id ?? options.jobId;
        }
      } catch (lookupErr) {
        console.warn('Post-timeout job lookup failed:', lookupErr);
      }
    }

    // Reset queue so next attempt creates a fresh connection
    jobQueue = null;
    return undefined;
  }
}
