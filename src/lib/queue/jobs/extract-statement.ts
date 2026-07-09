import { Job } from 'bullmq';

export async function handleExtractStatement(job: Job): Promise<void> {
  const { batchId, bookGuid, userId } = job.data as {
    batchId: number;
    bookGuid?: string;
    userId?: number;
  };
  const { runStatementExtraction } = await import('@/lib/statement-ingest');
  await runStatementExtraction(batchId, bookGuid, `[Job ${job.id}]`, userId);
}
