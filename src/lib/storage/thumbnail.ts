import sharp from 'sharp';

const THUMB_WIDTH = 300;
const THUMB_HEIGHT = 300;

/**
 * Generate a JPEG thumbnail from an image buffer.
 * For PDFs, generates a styled placeholder (no native canvas dependency needed).
 */
export async function generateThumbnail(
  buffer: Buffer,
  mimeType: string
): Promise<Buffer> {
  if (mimeType === 'application/pdf') {
    return generatePdfPlaceholder();
  }
  return sharp(buffer)
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Generate a simple placeholder thumbnail for PDFs (avoids native canvas dependency). */
async function generatePdfPlaceholder(): Promise<Buffer> {
  const svg = `<svg width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f3f4f6"/>
    <text x="50%" y="50%" text-anchor="middle" dy="0.35em" font-family="sans-serif" font-size="48" fill="#9ca3af">PDF</text>
  </svg>`;
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 80 })
    .toBuffer();
}
