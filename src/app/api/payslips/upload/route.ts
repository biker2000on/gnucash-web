import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createPayslip, updatePayslipStatus } from '@/lib/payslips';
import { getStorageBackend, generateStorageKey, thumbnailKeyFrom } from '@/lib/storage/storage-backend';
import { generateThumbnail } from '@/lib/storage/thumbnail';
import { enqueueJob } from '@/lib/queue/queues';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function detectMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const storage = await getStorageBackend();
    const results: { id: number; filename: string; status: string }[] = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());

      // Enforce size limit on actual buffer
      if (buffer.byteLength > MAX_FILE_SIZE) {
        results.push({ id: 0, filename: file.name, status: `error: exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` });
        continue;
      }

      // Only accept PDFs (magic bytes: %PDF)
      const detectedMime = detectMimeType(buffer);
      if (!detectedMime) {
        results.push({ id: 0, filename: file.name, status: 'error: unsupported file type (must be PDF)' });
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

      // Create DB record with placeholder values; extraction job will update them
      let payslip;
      try {
        payslip = await createPayslip({
          book_guid: bookGuid,
          pay_date: new Date(),
          employer_name: 'Unknown',
          storage_key: storageKey,
          thumbnail_key: savedThumbKey ?? undefined,
          created_by: user.id,
        });
      } catch (dbErr) {
        // Clean up orphaned files
        try { await storage.delete(storageKey); } catch { /* best effort */ }
        if (savedThumbKey) {
          try { await storage.delete(savedThumbKey); } catch { /* best effort */ }
        }
        console.error(`DB insert failed for ${sanitizedName}, cleaned up files:`, dbErr);
        results.push({ id: 0, filename: sanitizedName, status: 'error: failed to save payslip record' });
        continue;
      }

      const jobId = await enqueueJob('extract-payslip', {
        payslipId: payslip.id,
        bookGuid,
      });

      if (!jobId) {
        // Redis unavailable — run extraction inline (synchronously)
        try {
          const { runPayslipExtraction } = await import('@/lib/payslip-extract-core');
          await runPayslipExtraction(payslip.id, bookGuid, `[inline-${payslip.id}]`);
        } catch (extractErr) {
          console.error(`Inline extraction failed for payslip ${payslip.id}:`, extractErr);
        }
      }

      results.push({ id: payslip.id, filename: sanitizedName, status: 'uploaded' });
    }

    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.error('Payslip upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
