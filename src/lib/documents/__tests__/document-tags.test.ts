import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  tagsFindMany: vi.fn(),
  tagsCreate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: mocks.query,
    $executeRaw: mocks.execute,
    gnucash_web_tags: {
      findMany: mocks.tagsFindMany,
      create: mocks.tagsCreate,
    },
  },
}));

import {
  DocumentTagNotFoundError,
  addDocumentTags,
  applyDocumentTagRules,
  getDocumentTags,
  parseTagsQueryParam,
  setDocumentTags,
} from '../document-tags';

const BOOK = 'b'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.execute.mockResolvedValue(1);
  mocks.tagsFindMany.mockResolvedValue([]);
  mocks.tagsCreate.mockImplementation(async ({ data }: { data: { name: string } }) => ({
    id: 3, name: data.name,
  }));
});

describe('parseTagsQueryParam', () => {
  it('splits, normalizes, and drops invalid names', () => {
    expect(parseTagsQueryParam('Farm, Tax, !!!')).toEqual(['farm', 'tax']);
    expect(parseTagsQueryParam(null)).toEqual([]);
  });
});

describe('getDocumentTags', () => {
  it('rejects a document outside the book', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await expect(getDocumentTags(BOOK, 9)).rejects.toBeInstanceOf(DocumentTagNotFoundError);
  });

  it('returns names for an owned document', async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 9, book_guid: BOOK, title: 'Policy', file_name: 'p.pdf', issuer: null }])
      .mockResolvedValueOnce([{ name: 'insurance' }]);
    await expect(getDocumentTags(BOOK, 9)).resolves.toEqual(['insurance']);
  });
});

describe('setDocumentTags', () => {
  it('replaces the join rows after resolving the shared vocabulary', async () => {
    mocks.query.mockResolvedValueOnce([
      { id: 9, book_guid: BOOK, title: 'Policy', file_name: 'p.pdf', issuer: null },
    ]);
    mocks.tagsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await setDocumentTags(BOOK, 9, ['Farm']);
    expect(mocks.tagsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ book_guid: BOOK, name: 'farm' }),
    }));
    expect(mocks.execute).toHaveBeenCalled();
  });
});

describe('addDocumentTags', () => {
  it('counts only newly inserted tags', async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 9, book_guid: BOOK, title: 'P', file_name: 'p.pdf', issuer: null }])
      .mockResolvedValueOnce([{ n: 1n }])
      .mockResolvedValueOnce([{ n: 2n }]);
    mocks.tagsFindMany
      .mockResolvedValueOnce([{ id: 4, name: 'farm' }])
      .mockResolvedValueOnce([]);
    await expect(addDocumentTags(BOOK, 9, ['farm'])).resolves.toBe(1);
  });
});

describe('applyDocumentTagRules', () => {
  it('applies matching rules and reports per-document counts', async () => {
    mocks.query
      .mockResolvedValueOnce([{
        id: 1,
        book_root_guid: BOOK,
        match_field: 'filename',
        match_value: '1099',
        tag: 'tax',
        created_at: new Date('2026-01-01T00:00:00Z'),
      }])
      .mockResolvedValueOnce([{
        id: 9, book_guid: BOOK, title: 'INT', file_name: '1099-int.pdf', issuer: null,
      }])
      .mockResolvedValueOnce([{ source_id: '9', extracted_text: 'interest' }])
      .mockResolvedValueOnce([{ id: 9, book_guid: BOOK, title: 'INT', file_name: '1099-int.pdf', issuer: null }])
      .mockResolvedValueOnce([{ n: 0n }])
      .mockResolvedValueOnce([{ n: 1n }]);
    mocks.tagsFindMany.mockResolvedValue([{ id: 8, name: 'tax' }]);

    const results = await applyDocumentTagRules(BOOK);
    expect(results).toEqual([{ documentId: 9, applied: 1 }]);
  });
});
