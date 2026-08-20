import type { Job } from 'bullmq';
import { runEntityDocumentExtraction } from '@/lib/documents/entity-extraction';

export interface ExtractEntityDocumentJobData {
  documentId: number;
  bookGuid: string;
}

export async function handleExtractEntityDocument(job: Job): Promise<void> {
  const { documentId, bookGuid } = job.data as ExtractEntityDocumentJobData;
  // This handler only ever runs inside the worker, so an inline thumbnail
  // render on a queue hiccup is safe here (never on a request path).
  await runEntityDocumentExtraction(documentId, bookGuid, `[Job ${job.id}]`, {
    allowInlineThumbnail: true,
  });
}
