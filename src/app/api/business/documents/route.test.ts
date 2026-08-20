import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  tags: vi.fn(),
  thumbs: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/services/entity-documents.service', () => ({
  listEntityDocuments: mocks.list,
  createEntityDocument: mocks.create,
  EntityDocumentValidationError: class EntityDocumentValidationError extends Error {},
  EXPIRY_WARNING_DAYS: 60,
}));
vi.mock('@/lib/documents/document-tags', () => ({
  getTagsForDocuments: mocks.tags,
}));
vi.mock('@/lib/documents/thumbnail-store', () => ({
  getDocumentThumbnailStatuses: mocks.thumbs,
}));
vi.mock('@/lib/queue/jobs/render-document-thumbnail', () => ({
  enqueueDocumentThumbnail: mocks.enqueue,
}));

import { GET, POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    bookGuid: 'book-1', user: { id: 27, username: 'owner' }, role: 'edit',
  });
  mocks.create.mockResolvedValue({ id: 8, canonicalDocumentId: 88 });
  mocks.list.mockResolvedValue([]);
  mocks.tags.mockResolvedValue(new Map());
  mocks.thumbs.mockResolvedValue(new Map());
  mocks.enqueue.mockResolvedValue(undefined);
});

describe('GET /api/business/documents', () => {
  it('returns tags and thumbnailStatus sidecars on every row in one batched pass', async () => {
    // CODEX-2: the browser reads these instead of firing per-document requests.
    mocks.list.mockResolvedValue([
      { id: 1, title: 'A', daysUntilExpiry: null },
      { id: 2, title: 'B', daysUntilExpiry: 10 },
    ]);
    mocks.tags.mockResolvedValue(new Map([[1, ['tax']]]));
    mocks.thumbs.mockResolvedValue(new Map([[1, 'complete'], [2, 'failed']]));

    const response = await GET();
    const body = await response.json();

    expect(mocks.tags).toHaveBeenCalledWith('book-1', [1, 2]);
    expect(mocks.thumbs).toHaveBeenCalledWith('book-1', [1, 2]);
    expect(body.documents).toEqual([
      { id: 1, title: 'A', daysUntilExpiry: null, tags: ['tax'], thumbnailStatus: 'complete' },
      { id: 2, title: 'B', daysUntilExpiry: 10, tags: [], thumbnailStatus: 'failed' },
    ]);
    expect(body.expiringSoon).toHaveLength(1);
  });
});

describe('POST /api/business/documents', () => {
  it('propagates the authenticated uploader for canonical ownership and AI config', async () => {
    const form = new FormData();
    form.set('title', 'Insurance policy');
    form.set('doc_type', 'insurance');
    const file = new File([Buffer.from('%PDF')], 'policy.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('%PDF')).buffer),
    });
    form.set('file', file);

    const request = {
      formData: vi.fn().mockResolvedValue(form),
    } as unknown as Request;
    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith('book-1', expect.objectContaining({
      ownerUserId: 27,
      title: 'Insurance policy',
      docType: 'insurance',
    }));
  });

  it('never asks for an inline thumbnail render on the upload path', async () => {
    // M7: with the queue down the row stays pending for the boot backfill.
    const form = new FormData();
    form.set('title', 'Policy');
    const file = new File([Buffer.from('%PDF')], 'policy.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('%PDF')).buffer),
    });
    form.set('file', file);

    await POST({ formData: vi.fn().mockResolvedValue(form) } as unknown as Request);

    expect(mocks.enqueue).toHaveBeenCalledWith(8, 'book-1');
    expect(mocks.enqueue).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ allowInline: true }),
    );
  });
});
