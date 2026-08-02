import type { Job } from 'bullmq';
import { runEntityDocumentExtraction } from '@/lib/documents/entity-extraction';

export interface ExtractEntityDocumentJobData {
  documentId: number;
  bookGuid: string;
}

export async function handleExtractEntityDocument(job: Job): Promise<void> {
  const { documentId, bookGuid } = job.data as ExtractEntityDocumentJobData;
  await runEntityDocumentExtraction(documentId, bookGuid, `[Job ${job.id}]`);
}
