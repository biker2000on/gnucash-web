/**
 * Carry receipts from the household book to the business book.
 *
 * Documents (and their links) are book-scoped: a composite foreign key keeps
 * a link in its document's book. So a report's receipts are COPIED — new
 * storage object, new document row in the business book — never shared: a
 * shared storage key would let deleting it in one book remove the other
 * book's evidence. Copies are idempotent per (report, source document) via
 * upsertDocument's (book, source_kind, source_id) key.
 */

import prisma from '@/lib/prisma';
import { getStorageBackend, generateStorageKey } from '@/lib/storage/storage-backend';
import { linkDocument, upsertDocument } from '@/lib/documents/service';

interface SourceDocumentRow {
  id: number;
  title: string | null;
  storage_key: string | null;
  filename: string;
  mime_type: string | null;
  size_bytes: bigint | null;
  content_hash: string | null;
  extraction_status: string;
  extracted_text: string | null;
}

/** Returns a map of source document id → copied document id (business book). */
export async function copyDocumentsToBook(
  fromBookGuid: string,
  toBookGuid: string,
  documentIds: readonly number[],
  reportId: number,
  userId: number | null,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (documentIds.length === 0) return out;
  const docs = await prisma.$queryRaw<SourceDocumentRow[]>`
    SELECT id, title, storage_key, filename, mime_type, size_bytes, content_hash,
           extraction_status, extracted_text
      FROM gnucash_web_documents
     WHERE book_guid = ${fromBookGuid} AND id = ANY(${[...documentIds]}::int[])
  `;
  const storage = await getStorageBackend();
  for (const doc of docs) {
    let storageKey: string | null = null;
    if (doc.storage_key) {
      const bytes = await storage.get(doc.storage_key);
      storageKey = generateStorageKey(doc.filename);
      await storage.put(storageKey, bytes, doc.mime_type ?? 'application/octet-stream');
    }
    const copy = await upsertDocument({
      bookGuid: toBookGuid,
      ownerUserId: userId,
      title: doc.title ?? doc.filename,
      storageKey,
      filename: doc.filename,
      mimeType: doc.mime_type,
      sizeBytes: doc.size_bytes,
      contentHash: doc.content_hash,
      extractionStatus: doc.extraction_status === 'completed' ? 'completed' : 'pending',
      extractedText: doc.extracted_text,
      sourceKind: 'import',
      sourceId: `expense-report:${reportId}:${doc.id}`,
    });
    out.set(doc.id, copy.id);
  }
  return out;
}

/** Link copied receipts to the business transaction a report posted. */
export async function linkDocumentsToTransaction(
  bookGuid: string,
  documentIds: readonly number[],
  txGuid: string,
  userId: number | null,
): Promise<void> {
  for (const documentId of new Set(documentIds)) {
    try {
      await linkDocument({ bookGuid, documentId, targetType: 'transaction', targetId: txGuid, role: 'receipt', createdBy: userId });
    } catch (error) {
      console.warn('Expense report receipt link failed:', error);
    }
  }
}
