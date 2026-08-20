import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/services/entity-documents.service', () => ({
  listEntityDocuments: vi.fn(),
  createEntityDocument: mocks.create,
  EntityDocumentValidationError: class EntityDocumentValidationError extends Error {},
  EXPIRY_WARNING_DAYS: 60,
}));
vi.mock('@/lib/documents/document-tags', () => ({
  getTagsForDocuments: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/documents/thumbnail-store', () => ({
  getDocumentThumbnailStatuses: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/queue/jobs/render-document-thumbnail', () => ({
  enqueueDocumentThumbnail: vi.fn(async () => undefined),
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    bookGuid: 'book-1', user: { id: 27, username: 'owner' }, role: 'edit',
  });
  mocks.create.mockResolvedValue({ id: 8, canonicalDocumentId: 88 });
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
});
