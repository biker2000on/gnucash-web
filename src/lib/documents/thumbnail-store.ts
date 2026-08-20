/**
 * Thumbnail metadata for entity-document vault rows.
 * Columns live on gnucash_web_entity_documents (ADD COLUMN IF NOT EXISTS).
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { chunkIds } from '@/lib/documents/document-tags';

/** Documents materialized by one backfill pass; the rest wait for the next. */
export const THUMBNAIL_BACKFILL_BATCH_SIZE = 200;

export type ThumbnailStatus = 'pending' | 'complete' | 'failed';

export interface DocumentThumbnailRow {
  id: number;
  bookGuid: string;
  fileKey: string | null;
  mimeType: string | null;
  thumbnailStatus: ThumbnailStatus | null;
  thumbnailKey: string | null;
}

interface RawRow {
  id: number;
  book_guid: string;
  file_key: string | null;
  mime_type: string | null;
  thumbnail_status: string | null;
  thumbnail_key: string | null;
}

function mapRow(row: RawRow): DocumentThumbnailRow {
  const status = row.thumbnail_status;
  return {
    id: row.id,
    bookGuid: row.book_guid,
    fileKey: row.file_key,
    mimeType: row.mime_type,
    thumbnailStatus: status === 'pending' || status === 'complete' || status === 'failed'
      ? status
      : null,
    thumbnailKey: row.thumbnail_key,
  };
}

export async function getDocumentThumbnail(
  bookGuid: string,
  documentId: number,
): Promise<DocumentThumbnailRow | null> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT id, book_guid, file_key, mime_type, thumbnail_status, thumbnail_key
    FROM gnucash_web_entity_documents
    WHERE id = ${documentId} AND book_guid = ${bookGuid}
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getDocumentThumbnailStatuses(
  bookGuid: string,
  documentIds: number[],
): Promise<Map<number, ThumbnailStatus | null>> {
  const map = new Map<number, ThumbnailStatus | null>();
  if (documentIds.length === 0) return map;
  // Chunked: a vault page can hand over an unbounded id list, and one
  // IN (...) with tens of thousands of binds blows past Postgres' parameter
  // ceiling long before the planner would have made it worthwhile.
  for (const chunk of chunkIds(documentIds)) {
    const rows = await prisma.$queryRaw<Array<{ id: number; thumbnail_status: string | null }>>`
      SELECT id, thumbnail_status
      FROM gnucash_web_entity_documents
      WHERE book_guid = ${bookGuid}
        AND id IN (${Prisma.join(chunk)})
    `;
    for (const row of rows) {
      const status = row.thumbnail_status;
      map.set(
        row.id,
        status === 'pending' || status === 'complete' || status === 'failed' ? status : null,
      );
    }
  }
  return map;
}

export async function setDocumentThumbnailState(
  bookGuid: string,
  documentId: number,
  status: ThumbnailStatus,
  thumbnailKey: string | null = null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE gnucash_web_entity_documents
    SET thumbnail_status = ${status},
        thumbnail_key = ${thumbnailKey}
    WHERE id = ${documentId} AND book_guid = ${bookGuid}
  `;
}

export interface ThumbnailBackfillBatch {
  documents: Array<{ id: number; bookGuid: string }>;
  /** Eligible documents beyond this batch, for the caller to log. */
  remaining: number;
}

/**
 * One bounded page of documents that still need a thumbnail.
 *
 * The listing is LIMITed (and the leftover counted separately) so a boot pass
 * over a large vault does not materialize every eligible row into memory and
 * push an unbounded burst of jobs into the queue. Whatever is left is picked
 * up by the next boot/pass — rows keep their `pending` status until rendered,
 * so no work is lost.
 */
export async function listDocumentsNeedingThumbnails(
  batchSize: number = THUMBNAIL_BACKFILL_BATCH_SIZE,
): Promise<ThumbnailBackfillBatch> {
  const limit = Math.max(1, Math.floor(batchSize));
  const rows = await prisma.$queryRaw<Array<{ id: number; book_guid: string }>>`
    SELECT id, book_guid
    FROM gnucash_web_entity_documents
    WHERE file_key IS NOT NULL
      AND (
        thumbnail_status IS NULL
        OR thumbnail_status = 'pending'
        OR (thumbnail_status = 'complete' AND thumbnail_key IS NULL)
      )
    ORDER BY id ASC
    LIMIT ${limit}
  `;
  const documents = rows.map((row) => ({ id: row.id, bookGuid: row.book_guid }));
  if (documents.length < limit) {
    return { documents, remaining: 0 };
  }

  const lastId = documents[documents.length - 1].id;
  const countRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM gnucash_web_entity_documents
    WHERE file_key IS NOT NULL
      AND id > ${lastId}
      AND (
        thumbnail_status IS NULL
        OR thumbnail_status = 'pending'
        OR (thumbnail_status = 'complete' AND thumbnail_key IS NULL)
      )
  `;
  return { documents, remaining: Number(countRows[0]?.n ?? 0) };
}
