/**
 * Document intake core — the shared storage + OCR/extraction pipeline behind
 * the receipt, statement, and payslip upload routes AND the email-in ingestion
 * poller (src/lib/email-ingest.ts).
 *
 * Each intake function takes a raw buffer plus ownership context (bookGuid,
 * userId) and performs exactly what the corresponding upload route used to do
 * inline: size/type validation, filename sanitization, storage put, thumbnail
 * generation, DB record creation (with orphan-file cleanup on failure), and
 * job enqueue with the same inline fallbacks. HTTP-level concerns (auth,
 * multipart parsing, transaction/account existence checks) stay in the routes.
 */

import {
  getStorageBackend,
  generateStorageKey,
  thumbnailKeyFrom,
} from '@/lib/storage/storage-backend';
import { generateThumbnail } from '@/lib/storage/thumbnail';
import { enqueueJob, enqueueExtractStatement } from '@/lib/queue/queues';
import {
  createBatch,
  type StatementBatch,
  type StatementSource,
} from '@/lib/services/statement.service';

export const RECEIPT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const PAYSLIP_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const STATEMENT_MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

const RECEIPT_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Detect JPEG/PNG/PDF from magic bytes (receipt pipeline). */
export function detectReceiptMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  return null;
}

/** Detect PDF from magic bytes (payslip pipeline accepts PDFs only). */
export function detectPayslipMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  return null;
}

/** True if the buffer contains a NUL byte in its first `len` bytes (binary marker). */
function hasNulByte(buffer: Buffer, len: number): boolean {
  const end = Math.min(len, buffer.length);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Detect the statement source from magic bytes / content / filename.
 * Returns 'pdf' | 'csv' | 'ofx', or null if unsupported.
 */
export function detectStatementSource(buffer: Buffer, filename: string): StatementSource | null {
  // PDF magic bytes: %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'pdf';
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const head = buffer.subarray(0, 4096).toString('utf-8');
  const headUpper = head.toUpperCase();
  if (headUpper.includes('OFXHEADER') || headUpper.includes('<OFX>') || headUpper.includes('<OFX ')) {
    return 'ofx';
  }
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';

  // Content heuristic: printable text (no NUL bytes) with delimiters → CSV.
  const sample = head.slice(0, 1024);
  const looksDelimited = /[,;\t]/.test(sample) && /[\r\n]/.test(sample);
  if (!hasNulByte(buffer, 1024) && looksDelimited && /[0-9]/.test(sample)) return 'csv';

  return null;
}

// ---------------------------------------------------------------------------
// Receipt intake
// ---------------------------------------------------------------------------

export interface ReceiptIntakeInput {
  bookGuid: string;
  userId: number;
  filename: string;
  buffer: Buffer;
  /** Already validated to exist (route does the existence check). */
  transactionGuid?: string | null;
}

export type ReceiptIntakeResult =
  | { ok: true; id: number; filename: string }
  | { ok: false; error: string; filename: string };

/**
 * Store one receipt file: validate, put to storage, generate thumbnail,
 * create the DB record, and enqueue OCR (marking `enqueue_failed` if the
 * queue is unavailable). Mirrors the historical upload-route behavior.
 */
export async function intakeReceipt(input: ReceiptIntakeInput): Promise<ReceiptIntakeResult> {
  const { buffer } = input;

  // Validate actual buffer size, not client-reported size
  if (buffer.byteLength > RECEIPT_MAX_FILE_SIZE) {
    return {
      ok: false,
      filename: input.filename,
      error: `exceeds ${RECEIPT_MAX_FILE_SIZE / 1024 / 1024}MB limit`,
    };
  }

  const detectedMime = detectReceiptMimeType(buffer);
  if (!detectedMime || !RECEIPT_ALLOWED_MIME_TYPES.includes(detectedMime)) {
    return {
      ok: false,
      filename: input.filename,
      error: 'unsupported file type (must be JPEG, PNG, or PDF)',
    };
  }

  const sanitizedName = sanitizeFilename(input.filename);
  const storageKey = generateStorageKey(sanitizedName);
  const thumbKey = thumbnailKeyFrom(storageKey);
  const storage = await getStorageBackend();

  await storage.put(storageKey, buffer, detectedMime);

  let savedThumbKey: string | null = null;
  try {
    const thumbBuffer = await generateThumbnail(buffer, detectedMime);
    await storage.put(thumbKey, thumbBuffer, 'image/jpeg');
    savedThumbKey = thumbKey;
  } catch (err) {
    console.warn(`Thumbnail generation failed for ${sanitizedName}:`, err);
  }

  // Create DB record — clean up stored files on failure to prevent orphans
  let receipt;
  try {
    const { createReceipt } = await import('@/lib/receipts');
    receipt = await createReceipt({
      book_guid: input.bookGuid,
      transaction_guid: input.transactionGuid || null,
      filename: sanitizedName,
      storage_key: storageKey,
      thumbnail_key: savedThumbKey,
      mime_type: detectedMime,
      file_size: buffer.byteLength,
      created_by: input.userId,
    });
  } catch (dbErr) {
    // Clean up orphaned files
    try { await storage.delete(storageKey); } catch { /* best effort */ }
    if (savedThumbKey) {
      try { await storage.delete(savedThumbKey); } catch { /* best effort */ }
    }
    console.error(`DB insert failed for ${sanitizedName}, cleaned up files:`, dbErr);
    return { ok: false, filename: sanitizedName, error: 'failed to save receipt record' };
  }

  const jobId = await enqueueJob('ocr-receipt', {
    receiptId: receipt.id,
    bookGuid: input.bookGuid,
  });

  if (!jobId) {
    const { updateOcrResults } = await import('@/lib/receipts');
    await updateOcrResults(receipt.id, null, 'enqueue_failed');
  }

  return { ok: true, id: receipt.id, filename: sanitizedName };
}

// ---------------------------------------------------------------------------
// Statement intake
// ---------------------------------------------------------------------------

export interface StatementIntakeInput {
  bookGuid: string;
  userId: number;
  filename: string;
  buffer: Buffer;
  /** Already validated to belong to the book (route does the check). */
  accountGuid?: string | null;
}

export type StatementIntakeResult =
  | { ok: true; batch: StatementBatch }
  | { ok: false; error: string; status: 400 | 500 };

/**
 * Store one statement file: detect pdf|csv|ofx, put to storage (+ thumbnail
 * for PDFs), create a batch (status 'uploaded'), and enqueue extraction with
 * the inline fallback when the queue is unavailable.
 */
export async function intakeStatement(input: StatementIntakeInput): Promise<StatementIntakeResult> {
  const { buffer } = input;

  if (buffer.byteLength === 0) {
    return { ok: false, error: 'Empty file', status: 400 };
  }
  if (buffer.byteLength > STATEMENT_MAX_FILE_SIZE) {
    return {
      ok: false,
      error: `File exceeds ${STATEMENT_MAX_FILE_SIZE / 1024 / 1024}MB limit`,
      status: 400,
    };
  }

  const source = detectStatementSource(buffer, input.filename);
  if (!source) {
    return {
      ok: false,
      error: 'Unsupported file type (must be PDF, CSV, or OFX/QFX)',
      status: 400,
    };
  }

  const contentType =
    source === 'pdf' ? 'application/pdf' : source === 'ofx' ? 'application/x-ofx' : 'text/csv';

  const sanitizedName = sanitizeFilename(input.filename);
  const storageKey = generateStorageKey(sanitizedName);
  const storage = await getStorageBackend();

  await storage.put(storageKey, buffer, contentType);

  // Thumbnail only for PDFs.
  let savedThumbKey: string | null = null;
  if (source === 'pdf') {
    const thumbKey = thumbnailKeyFrom(storageKey);
    try {
      const thumbBuffer = await generateThumbnail(buffer, 'application/pdf');
      await storage.put(thumbKey, thumbBuffer, 'image/jpeg');
      savedThumbKey = thumbKey;
    } catch (err) {
      console.warn(`Statement thumbnail generation failed for ${sanitizedName}:`, err);
    }
  }

  let batch: StatementBatch;
  try {
    batch = await createBatch({
      bookGuid: input.bookGuid,
      accountGuid: input.accountGuid ?? null,
      source,
      originalFilename: input.filename,
      storageKey,
      thumbnailKey: savedThumbKey ?? undefined,
      status: 'uploaded',
    });
  } catch (dbErr) {
    // Clean up orphaned files (best effort).
    try { await storage.delete(storageKey); } catch { /* best effort */ }
    if (savedThumbKey) {
      try { await storage.delete(savedThumbKey); } catch { /* best effort */ }
    }
    console.error(`DB insert failed for statement ${sanitizedName}, cleaned up files:`, dbErr);
    return { ok: false, error: 'Failed to save statement record', status: 500 };
  }

  const jobId = await enqueueExtractStatement({
    batchId: batch.id,
    bookGuid: input.bookGuid,
    userId: input.userId,
  });
  if (!jobId) {
    // Redis unavailable — run extraction inline.
    try {
      const { runStatementExtraction } = await import('@/lib/statement-ingest');
      await runStatementExtraction(batch.id, input.bookGuid, `[inline-${batch.id}]`, input.userId);
    } catch (extractErr) {
      console.error(`Inline statement extraction failed for batch ${batch.id}:`, extractErr);
    }
  }

  return { ok: true, batch };
}

// ---------------------------------------------------------------------------
// Payslip intake
// ---------------------------------------------------------------------------

export interface PayslipIntakeInput {
  bookGuid: string;
  userId: number;
  filename: string;
  buffer: Buffer;
}

export type PayslipIntakeResult =
  | { ok: true; id: number; filename: string }
  | { ok: false; error: string; filename: string };

/**
 * Store one payslip PDF: validate, put to storage, generate thumbnail,
 * create the DB record (placeholder values; the extraction job fills them
 * in), and enqueue extraction with the inline fallback.
 */
export async function intakePayslip(input: PayslipIntakeInput): Promise<PayslipIntakeResult> {
  const { buffer } = input;

  // Enforce size limit on actual buffer
  if (buffer.byteLength > PAYSLIP_MAX_FILE_SIZE) {
    return {
      ok: false,
      filename: input.filename,
      error: `exceeds ${PAYSLIP_MAX_FILE_SIZE / 1024 / 1024}MB limit`,
    };
  }

  // Only accept PDFs (magic bytes: %PDF)
  const detectedMime = detectPayslipMimeType(buffer);
  if (!detectedMime) {
    return {
      ok: false,
      filename: input.filename,
      error: 'unsupported file type (must be PDF)',
    };
  }

  const sanitizedName = sanitizeFilename(input.filename);
  const storageKey = generateStorageKey(sanitizedName);
  const thumbKey = thumbnailKeyFrom(storageKey);
  const storage = await getStorageBackend();

  await storage.put(storageKey, buffer, detectedMime);

  let savedThumbKey: string | null = null;
  try {
    const thumbBuffer = await generateThumbnail(buffer, detectedMime);
    await storage.put(thumbKey, thumbBuffer, 'image/jpeg');
    savedThumbKey = thumbKey;
  } catch (err) {
    console.warn(`Thumbnail generation failed for ${sanitizedName}:`, err);
  }

  // Create DB record with placeholder values; extraction job will update them
  let payslip;
  try {
    const { createPayslip } = await import('@/lib/payslips');
    payslip = await createPayslip({
      book_guid: input.bookGuid,
      pay_date: new Date(),
      employer_name: 'Unknown',
      storage_key: storageKey,
      thumbnail_key: savedThumbKey ?? undefined,
      created_by: input.userId,
    });
  } catch (dbErr) {
    // Clean up orphaned files
    try { await storage.delete(storageKey); } catch { /* best effort */ }
    if (savedThumbKey) {
      try { await storage.delete(savedThumbKey); } catch { /* best effort */ }
    }
    console.error(`DB insert failed for ${sanitizedName}, cleaned up files:`, dbErr);
    return { ok: false, filename: sanitizedName, error: 'failed to save payslip record' };
  }

  const jobId = await enqueueJob('extract-payslip', {
    payslipId: payslip.id,
    bookGuid: input.bookGuid,
  });

  if (!jobId) {
    // Redis unavailable — run extraction inline (synchronously)
    try {
      const { runPayslipExtraction } = await import('@/lib/payslip-extract-core');
      await runPayslipExtraction(payslip.id, input.bookGuid, `[inline-${payslip.id}]`);
    } catch (extractErr) {
      console.error(`Inline extraction failed for payslip ${payslip.id}:`, extractErr);
    }
  }

  return { ok: true, id: payslip.id, filename: sanitizedName };
}
