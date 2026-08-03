import { Job } from 'bullmq';

/**
 * `runStatementExtraction` deliberately never throws: two inline callers (the
 * upload intake and the manual re-parse route) depend on that contract, and it
 * records every failure on the batch row instead. That left BullMQ recording
 * failed extractions as `completed` — nothing in the queue ever showed a
 * problem. Read the outcome back here and throw, so the job lands in the
 * `failed` set (and a batch stuck in `parsing`, which happens when the error
 * write itself fails, is surfaced too).
 */
export async function handleExtractStatement(job: Job): Promise<void> {
  const { batchId, bookGuid, userId, autoRecoveryAttempt, preserveRecoveryAttempt } = job.data as {
    batchId: number;
    bookGuid?: string;
    userId?: number;
    autoRecoveryAttempt?: number;
    preserveRecoveryAttempt?: number;
  };
  const { runStatementExtraction } = await import('@/lib/statement-ingest');
  await runStatementExtraction(batchId, bookGuid, `[Job ${job.id}]`, userId);

  const completedAttempt = autoRecoveryAttempt ?? preserveRecoveryAttempt ?? 0;
  if (completedAttempt > 0) {
    // Re-applies the durable auto-recovery marker (no-op unless the batch is
    // in `error`). Must run BEFORE the throw below or the retry ledger is lost
    // and the batch would be auto-recovered forever.
    const { recordStatementRecoveryFailure } = await import('@/lib/queue/statement-recovery');
    await recordStatementRecoveryFailure(batchId, completedAttempt);
  }

  const { getBatch } = await import('@/lib/services/statement.service');
  const batch = await getBatch(batchId);
  if (!batch) return; // deleted mid-flight — nothing to report
  if (batch.status === 'error' || batch.status === 'parsing') {
    throw new Error(
      batch.error ?? `Statement extraction for batch ${batchId} ended in status '${batch.status}'`,
    );
  }
}
