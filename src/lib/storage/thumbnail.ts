import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

const THUMB_WIDTH = 300;
const THUMB_HEIGHT = 300;

/**
 * Generate a JPEG thumbnail from an image or PDF buffer.
 * For PDFs, renders the first page using pdftoppm (poppler-utils).
 * Falls back to a styled placeholder if pdftoppm is unavailable.
 */
export async function generateThumbnail(
  buffer: Buffer,
  mimeType: string
): Promise<Buffer> {
  if (mimeType === 'application/pdf') {
    return generatePdfThumbnail(buffer);
  }
  return sharp(buffer)
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Check if a thumbnail buffer is just the old placeholder (gray box with "PDF" text).
 * Used by the backfill job to identify thumbnails that need regeneration.
 */
export async function isPlaceholderThumbnail(thumbBuffer: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(thumbBuffer).metadata();
    // The placeholder is exactly 300x300. Real thumbnails vary based on PDF aspect ratio.
    // Also check if the image is mostly uniform gray (placeholder characteristic).
    if (metadata.width === THUMB_WIDTH && metadata.height === THUMB_HEIGHT) {
      const stats = await sharp(thumbBuffer).stats();
      // Placeholder is nearly uniform gray — very low standard deviation
      const avgStdDev = stats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / stats.channels.length;
      return avgStdDev < 15;
    }
    return false;
  } catch {
    return false;
  }
}

/** Render the first page of a PDF as a JPEG thumbnail using pdftoppm. */
async function generatePdfThumbnail(buffer: Buffer): Promise<Buffer> {
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'gnucash-pdf-'));
    const pdfPath = path.join(tempDir, 'input.pdf');
    const outputPrefix = path.join(tempDir, 'page');

    await writeFile(pdfPath, buffer);

    // Render first page only (-f 1 -l 1), at a scale that gives ~300px width
    await execFileAsync('pdftoppm', [
      '-f', '1', '-l', '1',    // first page only
      '-jpeg',                   // output JPEG
      '-scale-to', String(THUMB_WIDTH * 2), // render at 2x for quality, downscale with sharp
      pdfPath,
      outputPrefix,
    ], { timeout: 10000 });

    // pdftoppm outputs as page-01.jpg (or page-1.jpg depending on version)
    const possibleFiles = ['page-01.jpg', 'page-1.jpg', 'page-001.jpg'];
    let pageBuffer: Buffer | null = null;
    for (const f of possibleFiles) {
      try {
        pageBuffer = await readFile(path.join(tempDir, f));
        break;
      } catch {
        // try next
      }
    }

    if (!pageBuffer) {
      console.warn('pdftoppm produced no output, falling back to placeholder');
      return generatePdfPlaceholder();
    }

    // Resize to thumbnail dimensions with sharp
    return sharp(pageBuffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    // pdftoppm not installed or failed — fall back to placeholder
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      console.warn('pdftoppm not available (install poppler-utils), using PDF placeholder');
    } else {
      console.warn('PDF thumbnail generation failed, using placeholder:', msg);
    }
    return generatePdfPlaceholder();
  } finally {
    // Clean up temp files
    if (tempDir) {
      try {
        const fs = await import('fs/promises');
        const files = await fs.readdir(tempDir);
        for (const f of files) {
          await unlink(path.join(tempDir, f)).catch(() => {});
        }
        await fs.rmdir(tempDir).catch(() => {});
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/** Generate a simple placeholder thumbnail for PDFs (fallback when pdftoppm unavailable). */
async function generatePdfPlaceholder(): Promise<Buffer> {
  const svg = `<svg width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f3f4f6"/>
    <text x="50%" y="50%" text-anchor="middle" dy="0.35em" font-family="sans-serif" font-size="48" fill="#9ca3af">PDF</text>
  </svg>`;
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 80 })
    .toBuffer();
}
