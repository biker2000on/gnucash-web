import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireRoleMock, getThumbMock, storageGet } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  getThumbMock: vi.fn(),
  storageGet: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/documents/thumbnail-store', () => ({
  getDocumentThumbnail: getThumbMock,
}));
vi.mock('@/lib/storage/storage-backend', () => ({
  getStorageBackend: vi.fn(async () => ({ get: storageGet })),
}));

import { GET } from '../route';

const BOOK = 'book-a';
const params = { params: Promise.resolve({ id: '12' }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ bookGuid: BOOK, user: { id: 1 }, role: 'readonly' });
  getThumbMock.mockResolvedValue({
    id: 12,
    bookGuid: BOOK,
    fileKey: 'entity-documents/a.pdf',
    mimeType: 'application/pdf',
    thumbnailStatus: 'complete',
    thumbnailKey: 'entity-documents/a_thumb.webp',
  });
  storageGet.mockResolvedValue(Buffer.from('WEBP'));
});

describe('GET /api/business/documents/[id]/thumbnail', () => {
  it('serves webp with nosniff and never the original MIME', async () => {
    const response = await GET(new Request('http://localhost/thumb'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(getThumbMock).toHaveBeenCalledWith(BOOK, 12);
  });

  it('returns 404 when the thumbnail is not yet rendered', async () => {
    getThumbMock.mockResolvedValue({
      id: 12,
      bookGuid: BOOK,
      fileKey: 'entity-documents/a.pdf',
      mimeType: 'application/pdf',
      thumbnailStatus: 'pending',
      thumbnailKey: null,
    });
    const response = await GET(new Request('http://localhost/thumb'), params);
    expect(response.status).toBe(404);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('returns 404 for a failed render', async () => {
    getThumbMock.mockResolvedValue({
      id: 12,
      bookGuid: BOOK,
      fileKey: 'entity-documents/a.pdf',
      mimeType: 'application/pdf',
      thumbnailStatus: 'failed',
      thumbnailKey: null,
    });
    const response = await GET(new Request('http://localhost/thumb'), params);
    expect(response.status).toBe(404);
  });

  it('returns 404 when the document is not in the caller book', async () => {
    getThumbMock.mockResolvedValue(null);
    const response = await GET(new Request('http://localhost/thumb'), params);
    expect(response.status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const response = await GET(
      new Request('http://localhost/thumb'),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(response.status).toBe(400);
    expect(getThumbMock).not.toHaveBeenCalled();
  });

  // CODEX-8 — a `private, max-age=604800` thumbnail stays reusable from a
  // shared browser profile after logout, with no round-trip that could
  // re-check the session.
  describe('caching', () => {
    it('revalidates on every use instead of caching privately for a week', async () => {
      const response = await GET(new Request('http://localhost/thumb'), params);
      expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
      expect(response.headers.get('Cache-Control')).not.toContain('604800');
      expect(response.headers.get('ETag')).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it('304s an unchanged thumbnail without re-reading storage', async () => {
      const first = await GET(new Request('http://localhost/thumb'), params);
      const etag = first.headers.get('ETag')!;
      storageGet.mockClear();

      const second = await GET(
        new Request('http://localhost/thumb', { headers: { 'If-None-Match': etag } }),
        params,
      );
      expect(second.status).toBe(304);
      expect(await second.text()).toBe('');
      expect(second.headers.get('ETag')).toBe(etag);
      expect(second.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
      expect(storageGet).not.toHaveBeenCalled();
    });

    it('derives the ETag from the thumbnail key, so a re-render busts it', async () => {
      const first = await GET(new Request('http://localhost/thumb'), params);
      getThumbMock.mockResolvedValue({
        id: 12,
        bookGuid: BOOK,
        fileKey: 'entity-documents/a.pdf',
        mimeType: 'application/pdf',
        thumbnailStatus: 'complete',
        thumbnailKey: 'entity-documents/a_thumb.v2.webp',
      });
      const second = await GET(new Request('http://localhost/thumb'), params);
      expect(second.headers.get('ETag')).not.toBe(first.headers.get('ETag'));
      expect(second.status).toBe(200);
    });

    it('ignores a stale If-None-Match and serves the new bytes', async () => {
      const response = await GET(
        new Request('http://localhost/thumb', { headers: { 'If-None-Match': '"stale"' } }),
        params,
      );
      expect(response.status).toBe(200);
      expect(storageGet).toHaveBeenCalled();
    });
  });
});
