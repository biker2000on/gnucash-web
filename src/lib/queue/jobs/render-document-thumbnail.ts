/**
 * Rasterize page 1 of an entity-document to a bounded WebP thumbnail.
 *
 * Runs in the worker (never in a request handler). A malformed file or an
 * excluded MIME type sets thumbnail_status='failed' and does not throw.
 */

import type { Job } from 'bullmq';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import {
  documentThumbnailKeyFrom,
  renderDocumentThumbnail,
} from '@/lib/documents/thumbnail';
import {
  getDocumentThumbnail,
  listDocumentsNeedingThumbnails,
  setDocumentThumbnailState,
} from '@/lib/documents/thumbnail-store';
import { enqueueJob } from '@/lib/queue/queues';
import { tryWithDatabaseAdvisoryLock } from '@/lib/db';

export interface RenderDocumentThumbnailJobData {
  documentId: number;
  bookGuid: string;
}

function jobIdFor(documentId: number): string {
  return `render-document-thumbnail:${documentId}`;
}

export async function renderEntityDocumentThumbnail(
  documentId: number,
  bookGuid: string,
): Promise<'complete' | 'failed' | 'skipped'> {
  const row = await getDocumentThumbnail(bookGuid, documentId);
  if (!row) return 'skipped';

  if (row.thumbnailStatus === 'complete' && row.thumbnailKey) {
    return 'skipped';
  }

  if (!row.fileKey) {
    await setDocumentThumbnailState(bookGuid, documentId, 'failed', null);
    return 'failed';
  }

  await setDocumentThumbnailState(bookGuid, documentId, 'pending', row.thumbnailKey);

  try {
    const storage = await getStorageBackend();
    const buffer = await storage.get(row.fileKey);
    const webp = await renderDocumentThumbnail(buffer, row.mimeType);
    if (!webp) {
      await setDocumentThumbnailState(bookGuid, documentId, 'failed', null);
      return 'failed';
    }

    const thumbKey = row.thumbnailKey || documentThumbnailKeyFrom(row.fileKey);
    await storage.put(thumbKey, webp, 'image/webp');
    await setDocumentThumbnailState(bookGuid, documentId, 'complete', thumbKey);
    return 'complete';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[render-document-thumbnail] Document ${documentId} failed: ${message.slice(0, 300)}`,
    );
    try {
      await setDocumentThumbnailState(bookGuid, documentId, 'failed', null);
    } catch (statusError) {
      console.warn(
        `[render-document-thumbnail] Failed to persist failed status for ${documentId}:`,
        statusError,
      );
    }
    return 'failed';
  }
}

export async function handleRenderDocumentThumbnail(job: Job): Promise<void> {
  const { documentId, bookGuid } = job.data as RenderDocumentThumbnailJobData;
  if (!Number.isInteger(documentId) || documentId <= 0 || typeof bookGuid !== 'string' || !bookGuid) {
    return;
  }
  await renderEntityDocumentThumbnail(documentId, bookGuid);
}

/** Enqueue (or run inline when Redis is down). Deterministic jobId dedupes. */
export async function enqueueDocumentThumbnail(
  documentId: number,
  bookGuid: string,
): Promise<void> {
  const jobId = await enqueueJob(
    'render-document-thumbnail',
    { documentId, bookGuid },
    { jobId: jobIdFor(documentId) },
  );
  if (!jobId) {
    await renderEntityDocumentThumbnail(documentId, bookGuid);
  }
}

/**
 * One-shot backfill: enqueue a render job for every stored document that has
 * no usable thumbnail. Guarded so app+worker boot races don't double-scan.
 */
export async function enqueueMissingDocumentThumbnails(): Promise<number> {
  const result = await tryWithDatabaseAdvisoryLock(
    'gnucash-web:entity-document-thumbnail-backfill',
    async () => {
      const pending = await listDocumentsNeedingThumbnails();
      let enqueued = 0;
      for (const doc of pending) {
        const jobId = await enqueueJob(
          'render-document-thumbnail',
          { documentId: doc.id, bookGuid: doc.bookGuid },
          { jobId: jobIdFor(doc.id) },
        );
        if (!jobId) {
          // Worker always has Redis; if it does not, skip mass inline work.
          break;
        }
        enqueued += 1;
      }
      return enqueued;
    },
  );
  if (!result.acquired) return 0;
  return result.result;
}
