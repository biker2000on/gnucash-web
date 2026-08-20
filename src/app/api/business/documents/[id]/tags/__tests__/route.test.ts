import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/documents/document-tags', () => ({
  getDocumentTags: mocks.get,
  setDocumentTags: mocks.set,
  DocumentTagNotFoundError: class DocumentTagNotFoundError extends Error {},
  DocumentTagValidationError: class DocumentTagValidationError extends Error {},
}));

import { GET, PUT } from '../route';
import { DocumentTagNotFoundError, DocumentTagValidationError } from '@/lib/documents/document-tags';

const BOOK = 'book-a';
const params = { params: Promise.resolve({ id: '7' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ bookGuid: BOOK, user: { id: 1 }, role: 'edit' });
  mocks.get.mockResolvedValue(['farm', 'tax']);
  mocks.set.mockResolvedValue(['farm']);
});

describe('GET /api/business/documents/[id]/tags', () => {
  it('returns the book-scoped tag names', async () => {
    const response = await GET(new Request('http://localhost/tags'), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: ['farm', 'tax'] });
    expect(mocks.get).toHaveBeenCalledWith(BOOK, 7);
  });

  it('returns 404 when the document is not in the book', async () => {
    mocks.get.mockRejectedValue(new DocumentTagNotFoundError('Document not found'));
    const response = await GET(new Request('http://localhost/tags'), params);
    expect(response.status).toBe(404);
  });
});

describe('PUT /api/business/documents/[id]/tags', () => {
  it('replaces the set', async () => {
    mocks.auth.mockResolvedValue({ bookGuid: BOOK, user: { id: 1 }, role: 'edit' });
    const response = await PUT(
      new Request('http://localhost/tags', {
        method: 'PUT',
        body: JSON.stringify({ tags: ['farm'] }),
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: ['farm'] });
    expect(mocks.set).toHaveBeenCalledWith(BOOK, 7, ['farm']);
  });

  it('rejects a non-array body via the shared validation helper', async () => {
    const response = await PUT(
      new Request('http://localhost/tags', {
        method: 'PUT',
        body: JSON.stringify({ tags: 'farm' }),
      }),
      params,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('tags');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('maps invalid tag names to 400', async () => {
    mocks.set.mockRejectedValue(new DocumentTagValidationError('Invalid tag name: "!!"'));
    const response = await PUT(
      new Request('http://localhost/tags', {
        method: 'PUT',
        body: JSON.stringify({ tags: ['!!'] }),
      }),
      params,
    );
    expect(response.status).toBe(400);
  });
});
