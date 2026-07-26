import type { Job } from 'bullmq';
import {
  runReceiptReextraction,
  type ReceiptReextractProgress,
  type ReceiptReextractSummary,
} from '@/lib/receipt-reextract';

export async function handleReextractReceipts(
  job: Job,
  onProgress?: (progress: ReceiptReextractProgress) => void | Promise<void>,
): Promise<ReceiptReextractSummary> {
  const { bookGuid, userId, force } = job.data as {
    bookGuid: string;
    userId: number;
    force?: boolean;
  };
  if (!bookGuid || !Number.isInteger(userId)) {
    throw new Error('Receipt re-extraction requires bookGuid and userId.');
  }

  return runReceiptReextraction({
    bookGuid,
    userId,
    force,
    onProgress: async (progress) => {
      await job.updateProgress(progress.percent);
      await onProgress?.(progress);
    },
  });
}
