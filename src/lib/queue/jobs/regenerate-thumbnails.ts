/**
 * Regenerate Thumbnails Job
 *
 * Finds receipts with missing or placeholder thumbnails and regenerates them.
 * Handles both PDFs (renders first page via pdftoppm) and images.
 * Designed to run as a nightly job or on-demand via API.
 */

import { Job } from 'bullmq';
import { query } from '@/lib/db';
import { getStorageBackend, thumbnailKeyFrom } from '@/lib/storage/storage-backend';
import { generateThumbnail, isPlaceholderThumbnail } from '@/lib/storage/thumbnail';

interface RegenerateResult {
  total: number;
  regenerated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export async function handleRegenerateThumbnails(job: Job): Promise<RegenerateResult> {
  const result: RegenerateResult = {
    total: 0,
    regenerated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const storage = await getStorageBackend();

  // Find all receipts — check for missing thumbnails or PDF placeholders
  const receipts = await query(
    `SELECT id, storage_key, thumbnail_key, file_type
     FROM gnucash_web_receipts
     ORDER BY id`
  );

  result.total = receipts.rows.length;
  console.log(`[regenerate-thumbnails] Checking ${result.total} receipts...`);

  for (const receipt of receipts.rows) {
    try {
      // Case 1: No thumbnail at all
      if (!receipt.thumbnail_key) {
        await regenerateForReceipt(receipt, storage, result);
        continue;
      }

      // Case 2: Thumbnail exists — check if it's a placeholder (for PDFs)
      if (receipt.file_type === 'application/pdf') {
        try {
          const thumbBuffer = await storage.get(receipt.thumbnail_key);
          const isPlaceholder = await isPlaceholderThumbnail(thumbBuffer);
          if (isPlaceholder) {
            await regenerateForReceipt(receipt, storage, result);
            continue;
          }
        } catch {
          // Thumbnail key exists in DB but file is missing — regenerate
          await regenerateForReceipt(receipt, storage, result);
          continue;
        }
      }

      result.skipped++;
    } catch (err) {
      const msg = `Receipt ${receipt.id}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      result.failed++;
      console.error(`[regenerate-thumbnails] ${msg}`);
    }

    // Report progress
    if (job.updateProgress) {
      await job.updateProgress(Math.round(((result.regenerated + result.skipped + result.failed) / result.total) * 100));
    }
  }

  console.log(
    `[regenerate-thumbnails] Done: ${result.regenerated} regenerated, ${result.skipped} skipped, ${result.failed} failed`
  );

  return result;
}

async function regenerateForReceipt(
  receipt: { id: number; storage_key: string; thumbnail_key: string | null; file_type: string },
  storage: Awaited<ReturnType<typeof getStorageBackend>>,
  result: RegenerateResult
): Promise<void> {
  try {
    const fileBuffer = await storage.get(receipt.storage_key);
    const thumbnailBuffer = await generateThumbnail(fileBuffer, receipt.file_type);
    const thumbKey = receipt.thumbnail_key || thumbnailKeyFrom(receipt.storage_key);

    await storage.put(thumbKey, thumbnailBuffer, 'image/jpeg');

    // Update DB if thumbnail_key was null
    if (!receipt.thumbnail_key) {
      await query(
        `UPDATE gnucash_web_receipts SET thumbnail_key = $1 WHERE id = $2`,
        [thumbKey, receipt.id]
      );
    }

    result.regenerated++;
    console.log(`[regenerate-thumbnails] Regenerated thumbnail for receipt ${receipt.id} (${receipt.file_type})`);
  } catch (err) {
    const msg = `Receipt ${receipt.id}: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    result.failed++;
    console.error(`[regenerate-thumbnails] Failed: ${msg}`);
  }
}
