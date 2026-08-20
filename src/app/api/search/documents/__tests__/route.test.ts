import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  guids: vi.fn(),
  search: vi.fn(),
  attach: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/book-scope', () => ({ getBookAccountGuids: mocks.guids }));
vi.mock('@/lib/doc-search', () => ({
  searchDocuments: mocks.search,
  validateSearchQuery: (raw: string | null) => {
    const query = (raw ?? '').trim();
    if (query.length < 3) return { ok: false, error: 'Query must be at least 3 characters' };
    return { ok: true, query };
  },
  MAX_GROUP_RESULTS: 20,
}));
vi.mock('@/lib/documents/document-tags', () => ({
  attachTagsToDocumentSearchHits: mocks.attach,
  parseTagsQueryParam: (raw: string | null | undefined) =>
    (raw ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean),
}));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ bookGuid: 'book-1', user: { id: 1 }, role: 'readonly' });
  mocks.guids.mockResolvedValue(['acct']);
  mocks.search.mockResolvedValue({
    query: 'policy',
    receipts: [],
    statements: [],
    payslips: [],
    documents: [
      { id: '80', group: 'documents', title: 'Policy', snippet: { text: 'x', highlightStart: 0, highlightEnd: 1 } },
    ],
    transactions: [],
    totalHits: 1,
  });
  mocks.attach.mockImplementation(async (_book: string, hits: Array<{ id: string }>) => (
    hits.map((hit) => ({ ...hit, tags: ['insurance'] }))
  ));
});

describe('GET /api/search/documents', () => {
  it('attaches tags to document hits', async () => {
    const response = await GET(new Request('http://localhost/api/search/documents?q=policy') as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents[0].tags).toEqual(['insurance']);
    // Decoration only — no filter argument to post-filter with.
    expect(mocks.attach).toHaveBeenCalledWith('book-1', expect.any(Array));
    expect(mocks.search).toHaveBeenCalledWith(['acct'], 'book-1', 'policy', {
      limit: 20,
      tags: [],
    });
  });

  it('pushes tags= into searchDocuments rather than post-filtering the hits', async () => {
    const response = await GET(
      new Request('http://localhost/api/search/documents?q=policy&tags=insurance,farm') as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.search).toHaveBeenCalledWith(['acct'], 'book-1', 'policy', {
      limit: 20,
      tags: ['insurance', 'farm'],
    });
    // totalHits comes straight from the (already tag-filtered) search — no
    // subtraction of a post-filter's drop count.
    expect(body.totalHits).toBe(1);
  });
});
