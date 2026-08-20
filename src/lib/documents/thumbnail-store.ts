/**
 * Thumbnail metadata for entity-document vault rows.
 * Columns live on gnucash_web_entity_documents (ADD COLUMN IF NOT EXISTS).
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';

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
  const rows = await prisma.$queryRaw<Array<{ id: number; thumbnail_status: string | null }>>`
    SELECT id, thumbnail_status
    FROM gnucash_web_entity_documents
    WHERE book_guid = ${bookGuid}
      AND id IN (${Prisma.join(documentIds)})
  `;
  for (const row of rows) {
    const status = row.thumbnail_status;
    map.set(
      row.id,
      status === 'pending' || status === 'complete' || status === 'failed' ? status : null,
    );
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

export async function listDocumentsNeedingThumbnails(): Promise<
  Array<{ id: number; bookGuid: string }>
> {
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
  `;
  return rows.map((row) => ({ id: row.id, bookGuid: row.book_guid }));
}
