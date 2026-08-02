import { Job } from 'bullmq';

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
    const { recordStatementRecoveryFailure } = await import('@/lib/queue/statement-recovery');
    await recordStatementRecoveryFailure(batchId, completedAttempt);
  }
}
