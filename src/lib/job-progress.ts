/**
 * Job progress bus — Redis pub/sub events for long-running server work.
 *
 * Any process (the Next.js app for inline work, the BullMQ worker for queued
 * jobs) publishes JobProgressEvents here; the SSE relay at
 * /api/jobs/stream forwards them to browsers scoped by book/user channel.
 * Without Redis every publish is a silent no-op — callers never need to
 * guard, and the UI falls back to the job-status polling endpoint.
 *
 * Channel scheme mirrors notifications (src/lib/notifications.ts):
 *   job-progress:book:{bookGuid}   — everyone viewing the book
 *   job-progress:user:{userId}    — the initiating user (cross-book)
 */

import { getRedis } from '@/lib/redis';

export type JobProgressStatus = 'running' | 'progress' | 'completed' | 'failed';
export type JobSource = 'manual' | 'scheduled';

export interface JobProgressEvent {
  /** BullMQ job id, or `inline-{uuid}` for work run in the request process. */
  jobId: string;
  /** Job kind, e.g. 'sync-simplefin', 'refresh-prices', 'scrub-all-lots'. */
  kind: string;
  bookGuid: string;
  userId?: number;
  source: JobSource;
  status: JobProgressStatus;
  /** Human label for the operation, e.g. 'SimpleFin sync'. */
  label: string;
  /** Current step description, e.g. 'Syncing Checking (3/7)…'. */
  message?: string;
  current?: number;
  total?: number;
  /** 0-100 when computable. */
  percent?: number;
  /** Terminal summary payload (counts etc.) on 'completed'. */
  summary?: Record<string, unknown>;
  /** Error message on 'failed'. */
  error?: string;
  /** ISO timestamp. */
  ts: string;
}

/** Channels a client subscribes to — mirror of getNotificationChannels. */
export function jobProgressChannels(userId: number, bookGuid: string): string[] {
  return [`job-progress:user:${userId}`, `job-progress:book:${bookGuid}`];
}

/**
 * Build a fully-stamped event from a partial (ts defaulted to now).
 * Pure — exported for tests.
 */
export function buildJobProgressEvent(
  partial: Omit<JobProgressEvent, 'ts'> & { ts?: string },
): JobProgressEvent {
  return { ...partial, ts: partial.ts ?? new Date().toISOString() };
}

/**
 * Publish a progress event. No-op (returns false) without Redis or when the
 * event lacks a bookGuid. Never throws — progress is best-effort telemetry
 * and must not break the job doing the real work.
 */
export async function publishJobProgress(
  partial: Omit<JobProgressEvent, 'ts'> & { ts?: string },
): Promise<boolean> {
  const redis = getRedis();
  if (!redis || !partial.bookGuid) return false;
  const event = buildJobProgressEvent(partial);
  const payload = JSON.stringify(event);
  const channels = [`job-progress:book:${event.bookGuid}`];
  if (event.userId !== undefined) channels.push(`job-progress:user:${event.userId}`);
  try {
    await Promise.all(channels.map((c) => redis.publish(c, payload)));
    return true;
  } catch (error) {
    console.warn(
      'job-progress publish failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Convenience: a bound emitter for one job so call sites don't repeat the
 * identity fields on every event.
 */
export function jobProgressEmitter(base: {
  jobId: string;
  kind: string;
  bookGuid: string;
  userId?: number;
  source: JobSource;
  label: string;
}) {
  return {
    running(message?: string) {
      return publishJobProgress({ ...base, status: 'running', message });
    },
    progress(p: {
      message?: string;
      current?: number;
      total?: number;
      percent?: number;
    }) {
      return publishJobProgress({ ...base, status: 'progress', ...p });
    },
    completed(summary?: Record<string, unknown>, message?: string) {
      return publishJobProgress({ ...base, status: 'completed', summary, message });
    },
    failed(error: string) {
      return publishJobProgress({ ...base, status: 'failed', error });
    },
  };
}
