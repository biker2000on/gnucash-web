import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
  getStorageBackend,
  generateStorageKey,
  thumbnailKeyFrom,
} from '@/lib/storage/storage-backend';
import { generateThumbnail } from '@/lib/storage/thumbnail';
import { createBatch, type StatementSource } from '@/lib/services/statement.service';
import { enqueueExtractStatement } from '@/lib/queue/queues';

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
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
function detectSource(buffer: Buffer, filename: string): StatementSource | null {
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

/**
 * POST /api/statements/upload — multipart upload of a single statement file.
 * Fields: `file` (required), `accountGuid` (optional).
 * Detects pdf|csv|ofx, stores the original (+ thumbnail for pdf), creates a
 * batch (status 'uploaded'), and enqueues extraction (inline fallback if no
 * queue). Returns the created batch.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided (field "file")' }, { status: 400 });
    }

    const accountGuidRaw = formData.get('accountGuid');
    let accountGuid: string | null = null;
    if (typeof accountGuidRaw === 'string' && accountGuidRaw.trim()) {
      accountGuid = accountGuidRaw.trim();
      const bookGuids = await getBookAccountGuids();
      if (!bookGuids.includes(accountGuid)) {
        return NextResponse.json({ error: 'accountGuid is not in the active book' }, { status: 400 });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength === 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400 });
    }
    if (buffer.byteLength > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` },
        { status: 400 },
      );
    }

    const source = detectSource(buffer, file.name);
    if (!source) {
      return NextResponse.json(
        { error: 'Unsupported file type (must be PDF, CSV, or OFX/QFX)' },
        { status: 400 },
      );
    }

    const contentType =
      source === 'pdf' ? 'application/pdf' : source === 'ofx' ? 'application/x-ofx' : 'text/csv';

    const sanitizedName = sanitizeFilename(file.name);
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

    let batch;
    try {
      batch = await createBatch({
        bookGuid,
        accountGuid,
        source,
        originalFilename: file.name,
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
      return NextResponse.json({ error: 'Failed to save statement record' }, { status: 500 });
    }

    const jobId = await enqueueExtractStatement({ batchId: batch.id, bookGuid, userId: user.id });
    if (!jobId) {
      // Redis unavailable — run extraction inline.
      try {
        const { runStatementExtraction } = await import('@/lib/statement-ingest');
        await runStatementExtraction(batch.id, bookGuid, `[inline-${batch.id}]`, user.id);
      } catch (extractErr) {
        console.error(`Inline statement extraction failed for batch ${batch.id}:`, extractErr);
      }
    }

    return NextResponse.json({ batch }, { status: 201 });
  } catch (error) {
    console.error('Statement upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
