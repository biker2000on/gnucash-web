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
});
