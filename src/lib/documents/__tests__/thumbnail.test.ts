import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  generateThumbnail: vi.fn(),
  isPlaceholderThumbnail: vi.fn(),
}));

vi.mock('@/lib/storage/thumbnail', () => ({
  generateThumbnail: mocks.generateThumbnail,
  isPlaceholderThumbnail: mocks.isPlaceholderThumbnail,
}));

import {
  DOCUMENT_THUMBNAIL_WIDTH,
  documentThumbnailKeyFrom,
  renderDocumentThumbnail,
} from '../thumbnail';

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } },
  }).png().toBuffer();
}

describe('documentThumbnailKeyFrom', () => {
  it('stores the webp beside the source key', () => {
    expect(documentThumbnailKeyFrom('entity-documents/2026/08/abc.pdf'))
      .toBe('entity-documents/2026/08/abc_thumb.webp');
    expect(documentThumbnailKeyFrom('no-extension')).toBe('no-extension_thumb.webp');
  });
});

describe('renderDocumentThumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPlaceholderThumbnail.mockResolvedValue(false);
  });

  it('downscales a raster image to a bounded webp', async () => {
    const webp = await renderDocumentThumbnail(await tinyPng(), 'image/png');
    expect(webp).toBeInstanceOf(Buffer);
    const meta = await sharp(webp!).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_WIDTH);
    expect(meta.height).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_WIDTH);
  });

  it('refuses HTML and SVG so thumbnails cannot become a stored-XSS back door', async () => {
    const png = await tinyPng();
    expect(await renderDocumentThumbnail(png, 'text/html')).toBeNull();
    expect(await renderDocumentThumbnail(png, 'image/svg+xml')).toBeNull();
    expect(await renderDocumentThumbnail(png, 'application/octet-stream')).toBeNull();
  });

  it('returns null for a malformed image instead of throwing', async () => {
    await expect(renderDocumentThumbnail(Buffer.from('not-an-image'), 'image/jpeg'))
      .resolves.toBeNull();
  });

  it('returns null for an empty buffer', async () => {
    await expect(renderDocumentThumbnail(Buffer.alloc(0), 'image/png')).resolves.toBeNull();
  });

  it('reuses the receipt PDF rasterizer and converts to webp', async () => {
    const jpeg = await sharp({
      create: { width: 40, height: 60, channels: 3, background: { r: 10, g: 10, b: 200 } },
    }).jpeg().toBuffer();
    mocks.generateThumbnail.mockResolvedValue(jpeg);

    const webp = await renderDocumentThumbnail(Buffer.from('%PDF'), 'application/pdf');
    expect(mocks.generateThumbnail).toHaveBeenCalledWith(expect.any(Buffer), 'application/pdf');
    expect(webp).toBeInstanceOf(Buffer);
    expect((await sharp(webp!).metadata()).format).toBe('webp');
  });

  it('treats the PDF placeholder fallback as a failed render', async () => {
    mocks.generateThumbnail.mockResolvedValue(Buffer.from('placeholder'));
    mocks.isPlaceholderThumbnail.mockResolvedValue(true);
    await expect(renderDocumentThumbnail(Buffer.from('%PDF'), 'application/pdf'))
      .resolves.toBeNull();
  });
});
