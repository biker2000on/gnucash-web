import type { StatementBatchWithCount } from '@/lib/services/statement.service';
import { getBatch, setBatchStatus } from '@/lib/services/statement.service';
import { enqueueExtractStatement } from './queues';

export const MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS = 2;
export const STATEMENT_RECOVERY_MIN_AGE_MS = 10 * 60 * 1_000;
export const STATEMENT_STUCK_PARSING_MS = 30 * 60 * 1_000;
export const STATEMENT_RECOVERY_BACKOFF_MS = 15 * 60 * 1_000;
export const STATEMENT_RECOVERY_BATCH_LIMIT = 3;

const RECOVERY_PREFIX = /^\[auto-recovery attempt (\d+)\/2(?:; next ([^\]]+))?\]\s*/;

export interface StatementRecoveryState {
  attempt: number;
  nextRetryAt: Date | null;
  message: string | null;
}

export function parseStatementRecoveryState(error: string | null): StatementRecoveryState {
  if (!error) return { attempt: 0, nextRetryAt: null, message: null };
  const match = error.match(RECOVERY_PREFIX);
  if (!match) return { attempt: 0, nextRetryAt: null, message: error };
  const nextRetryAt = match[2] && match[2] !== 'none' ? new Date(match[2]) : null;
  return {
    attempt: Math.min(MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS, Number(match[1]) || 0),
    nextRetryAt: nextRetryAt && Number.isFinite(nextRetryAt.getTime()) ? nextRetryAt : null,
    message: error.replace(RECOVERY_PREFIX, '') || null,
  };
}

export function formatStatementRecoveryError(
  error: string | null,
  attempt: number,
  nextRetryAt: Date | null,
): string {
  const message = parseStatementRecoveryState(error).message ?? 'Statement extraction failed.';
  return `[auto-recovery attempt ${attempt}/${MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS}; next ${nextRetryAt?.toISOString() ?? 'none'}] ${message}`;
}

export function nextStatementRecoveryAttempt(
  batch: Pick<StatementBatchWithCount, 'source' | 'status' | 'error' | 'updatedAt'>,
  now = new Date(),
): number | null {
  if (batch.source !== 'pdf') return null;
  const state = parseStatementRecoveryState(batch.error);
  if (state.attempt >= MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS) return null;
  if (state.nextRetryAt && state.nextRetryAt.getTime() > now.getTime()) return null;

  const age = now.getTime() - batch.updatedAt.getTime();
  const eligibleError = batch.status === 'error' && age >= STATEMENT_RECOVERY_MIN_AGE_MS;
  const stuckParsing = batch.status === 'parsing' && age >= STATEMENT_STUCK_PARSING_MS;
  return eligibleError || stuckParsing ? state.attempt + 1 : null;
}

/**
 * Queue a small, deterministic set of retries. The marker stored in the
 * existing error field is the durable attempt ledger, so no schema migration
 * is needed and a process restart cannot reset the retry budget.
 */
export async function scheduleStatementRecovery(input: {
  batches: StatementBatchWithCount[];
  bookGuid: string;
  userId: number;
  now?: Date;
}): Promise<number[]> {
  const now = input.now ?? new Date();
  const plans = input.batches.flatMap(batch => {
    const attempt = nextStatementRecoveryAttempt(batch, now);
    return attempt === null ? [] : [{ batch, attempt }];
  }).slice(0, STATEMENT_RECOVERY_BATCH_LIMIT);

  const scheduled = await Promise.all(plans.map(async ({ batch, attempt }) => {
    const jobId = await enqueueExtractStatement(
      {
        batchId: batch.id,
        bookGuid: input.bookGuid,
        userId: input.userId,
        autoRecoveryAttempt: attempt,
      },
      {
        jobId: `statement-recovery-${batch.id}-${attempt}`,
        delay: 2_000,
      },
    );
    if (!jobId) return null;

    const nextRetryAt = attempt < MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS
      ? new Date(now.getTime() + STATEMENT_RECOVERY_BACKOFF_MS)
      : null;
    await setBatchStatus(batch.id, 'error', {
      error: formatStatementRecoveryError(batch.error, attempt, nextRetryAt),
    });
    return batch.id;
  }));

  return scheduled.filter((id): id is number => id !== null);
}

/** Re-apply the durable marker only when extraction still ended in error. */
export async function recordStatementRecoveryFailure(batchId: number, attempt: number): Promise<void> {
  const batch = await getBatch(batchId);
  if (!batch || batch.status !== 'error') return;
  const boundedAttempt = Math.min(MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS, Math.max(1, attempt));
  const nextRetryAt = boundedAttempt < MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS
    ? new Date(Date.now() + STATEMENT_RECOVERY_BACKOFF_MS)
    : null;
  await setBatchStatus(batchId, 'error', {
    error: formatStatementRecoveryError(batch.error, boundedAttempt, nextRetryAt),
  });
}
