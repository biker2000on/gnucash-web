import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createReceipt } from '@/lib/receipts';
import { getStorageBackend, generateStorageKey, thumbnailKeyFrom } from '@/lib/storage/storage-backend';
import { generateThumbnail } from '@/lib/storage/thumbnail';
import { enqueueJob } from '@/lib/queue/queues';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function detectMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export async function POST(request: Request) {
  try {
    // Receipts are app-managed data (not GnuCash data), so all authenticated users can upload
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const transactionGuid = formData.get('transaction_guid') as string | null;
    const files = formData.getAll('files') as File[];

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    if (transactionGuid) {
      const { query: dbQuery } = await import('@/lib/db');
      const txResult = await dbQuery(
        'SELECT guid FROM transactions WHERE guid = $1',
        [transactionGuid]
      );
      if (txResult.rows.length === 0) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
    }

    const storage = getStorageBackend();
    const results: { id: number; filename: string; status: string }[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        results.push({ id: 0, filename: file.name, status: `error: exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` });
        continue;
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      const detectedMime = detectMimeType(buffer);
      if (!detectedMime || !ALLOWED_MIME_TYPES.includes(detectedMime)) {
        results.push({ id: 0, filename: file.name, status: 'error: unsupported file type (must be JPEG, PNG, or PDF)' });
        continue;
      }

      const sanitizedName = sanitizeFilename(file.name);
      const storageKey = generateStorageKey(sanitizedName);
      const thumbKey = thumbnailKeyFrom(storageKey);

      await storage.put(storageKey, buffer, detectedMime);

      let savedThumbKey: string | null = null;
      try {
        const thumbBuffer = await generateThumbnail(buffer, detectedMime);
        await storage.put(thumbKey, thumbBuffer, 'image/jpeg');
        savedThumbKey = thumbKey;
      } catch (err) {
        console.warn(`Thumbnail generation failed for ${sanitizedName}:`, err);
      }

      const receipt = await createReceipt({
        book_guid: bookGuid,
        transaction_guid: transactionGuid || null,
        filename: sanitizedName,
        storage_key: storageKey,
        thumbnail_key: savedThumbKey,
        mime_type: detectedMime,
        file_size: file.size,
        created_by: user.id,
      });

      const jobId = await enqueueJob('ocr-receipt', {
        receiptId: receipt.id,
        bookGuid,
      });

      if (!jobId) {
        const { updateOcrResults } = await import('@/lib/receipts');
        await updateOcrResults(receipt.id, null, 'enqueue_failed');
      }

      results.push({ id: receipt.id, filename: sanitizedName, status: 'uploaded' });
    }

    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.error('Receipt upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
