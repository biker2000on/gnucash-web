/**
 * Rasterize a vault document to a bounded WebP thumbnail.
 *
 * Reuses the receipt PDF path (`generateThumbnail` → pdftoppm + sharp) and
 * downscales images with sharp. Output is always image/webp, ~400px wide.
 * Types outside the inline-preview safelist (HTML, SVG, …) return null so
 * this cannot become a stored-XSS back door.
 */

import sharp from 'sharp';
import { isInlinePreviewableMime } from '@/lib/document-preview';
import { generateThumbnail, isPlaceholderThumbnail } from '@/lib/storage/thumbnail';

export const DOCUMENT_THUMBNAIL_WIDTH = 400;
export const DOCUMENT_THUMBNAIL_MIME = 'image/webp';
const MAX_INPUT_PIXELS = 4096 * 4096;
const SHARP_TIMEOUT_SECONDS = 10;

export function documentThumbnailKeyFrom(storageKey: string): string {
  const dotIdx = storageKey.lastIndexOf('.');
  const base = dotIdx === -1 ? storageKey : storageKey.substring(0, dotIdx);
  return `${base}_thumb.webp`;
}

function normalizeMime(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

function toWebp(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
    .rotate()
    .resize(DOCUMENT_THUMBNAIL_WIDTH, DOCUMENT_THUMBNAIL_WIDTH, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Rasterize page 1 / the image to a WebP thumbnail. Returns null when the
 * type is excluded, the file is malformed, or PDF rasterization fell back to
 * the placeholder (treated as a failed render, not a usable thumb).
 */
export async function renderDocumentThumbnail(
  buffer: Buffer,
  mimeType: string | null | undefined,
): Promise<Buffer | null> {
  const mime = normalizeMime(mimeType);
  if (!isInlinePreviewableMime(mime)) return null;
  if (!buffer.length) return null;

  try {
    if (mime === 'application/pdf') {
      const jpeg = await generateThumbnail(buffer, mime);
      if (await isPlaceholderThumbnail(jpeg)) return null;
      return await toWebp(jpeg);
    }
    return await toWebp(buffer);
  } catch {
    return null;
  }
}
