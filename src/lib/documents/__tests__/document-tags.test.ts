import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  txQuery: vi.fn(),
  txExecute: vi.fn(),
  transaction: vi.fn(),
  tagsFindMany: vi.fn(),
  tagsCreate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: mocks.query,
    $executeRaw: mocks.execute,
    $transaction: mocks.transaction,
    gnucash_web_tags: {
      findMany: mocks.tagsFindMany,
      create: mocks.tagsCreate,
    },
  },
}));

import {
  APPLY_RULES_BATCH_SIZE,
  DocumentTagNotFoundError,
  ID_CHUNK_SIZE,
  addDocumentTags,
  applyDocumentTagRules,
  chunkIds,
  getDocumentTags,
  getTagsForDocuments,
  parseTagsQueryParam,
  setDocumentTags,
} from '../document-tags';

const BOOK = 'b'.repeat(32);

/** SQL text of a tagged-template call, for asserting which statement ran. */
function sqlOf(call: unknown[]): string {
  const first = call[0];
  if (Array.isArray(first)) return first.join('?');
  const strings = (first as { strings?: unknown })?.strings;
  return Array.isArray(strings) ? strings.join('?') : String(first);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.execute.mockResolvedValue(1);
  mocks.txQuery.mockResolvedValue([]);
  mocks.txExecute.mockResolvedValue(1);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: mocks.txQuery, $executeRaw: mocks.txExecute }),
  );
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

describe('chunkIds (L8)', () => {
  it('keeps a short list as one chunk and splits at the parameter ceiling', () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds([1, 2, 3])).toEqual([[1, 2, 3]]);
    const many = Array.from({ length: 2_500 }, (_, i) => i + 1);
    const chunks = chunkIds(many);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(ID_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(500);
    expect(chunks.flat()).toEqual(many);
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

describe('getTagsForDocuments (L8)', () => {
  it('chunks an oversized id list into bounded IN (...) statements', async () => {
    const ids = Array.from({ length: 2_100 }, (_, i) => i + 1);
    mocks.query.mockResolvedValue([]);
    await getTagsForDocuments(BOOK, ids);
    // 2100 ids -> 1000 + 1000 + 100
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('issues a single statement for a normal page of documents', async () => {
    mocks.query.mockResolvedValueOnce([{ document_id: 1, name: 'tax' }]);
    await expect(getTagsForDocuments(BOOK, [1, 2])).resolves.toEqual(new Map([[1, ['tax']]]));
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOrCreateTagsForBook race handling (M2)', () => {
  it('adopts the row a competing writer created instead of dying on P2002', async () => {
    mocks.query.mockResolvedValueOnce([
      { id: 9, book_guid: BOOK, title: 'Policy', file_name: 'p.pdf', issuer: null },
    ]);
    // First lookup: the tag does not exist yet, so we try to create it.
    mocks.tagsFindMany
      .mockResolvedValueOnce([])          // existing by name
      .mockResolvedValueOnce([])          // colors in use
      // Re-select after ON CONFLICT DO NOTHING: the competitor's row is there.
      .mockResolvedValueOnce([{ id: 77, name: 'farm' }]);

    await expect(setDocumentTags(BOOK, 9, ['Farm'])).resolves.toEqual(['farm']);

    // Creation went through raw upsert SQL, never prisma.create (which throws
    // P2002 when it loses the race).
    expect(mocks.tagsCreate).not.toHaveBeenCalled();
    const insert = mocks.execute.mock.calls.find((call) =>
      sqlOf(call).includes('INSERT INTO gnucash_web_tags'));
    expect(insert).toBeDefined();
    expect(sqlOf(insert!)).toContain('ON CONFLICT (book_guid, name) DO NOTHING');

    // And the join row points at the EXISTING tag id, not a phantom one.
    const join = mocks.txExecute.mock.calls.find((call) =>
      sqlOf(call).includes('INSERT INTO gnucash_web_document_tags'));
    expect(join).toBeDefined();
  });
});

describe('setDocumentTags (M3)', () => {
  it('runs the DELETE and the INSERTs on one transaction client', async () => {
    mocks.query.mockResolvedValueOnce([
      { id: 9, book_guid: BOOK, title: 'Policy', file_name: 'p.pdf', issuer: null },
    ]);
    mocks.tagsFindMany.mockResolvedValueOnce([{ id: 4, name: 'farm' }]);

    await setDocumentTags(BOOK, 9, ['farm']);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const txSql = mocks.txExecute.mock.calls.map(sqlOf);
    expect(txSql.some((sql) => sql.includes('DELETE FROM gnucash_web_document_tags'))).toBe(true);
    expect(txSql.some((sql) => sql.includes('INSERT INTO gnucash_web_document_tags'))).toBe(true);
    // Nothing from the replace escaped the transaction onto the autocommit client.
    expect(mocks.execute.mock.calls.map(sqlOf).some((sql) =>
      sql.includes('gnucash_web_document_tags'))).toBe(false);
  });
});

describe('addDocumentTags', () => {
  it('counts only newly inserted tags', async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 9, book_guid: BOOK, title: 'P', file_name: 'p.pdf', issuer: null }])
      .mockResolvedValueOnce([{ n: 1n }])
      .mockResolvedValueOnce([{ n: 2n }]);
    mocks.tagsFindMany.mockResolvedValueOnce([{ id: 4, name: 'farm' }]);
    await expect(addDocumentTags(BOOK, 9, ['farm'])).resolves.toBe(1);
  });
});

/**
 * Shape the raw-query mock for applyDocumentTagRules: rules, the document
 * page, the remaining count, extracted texts, then existing join rows.
 */
function installApplyQueries(options: {
  rules?: unknown[];
  docs: unknown[];
  remaining?: number;
  texts?: unknown[];
  existingJoins?: unknown[];
}) {
  mocks.query.mockImplementation((arg: unknown) => {
    const sql = sqlOf([arg]);
    if (sql.includes('gnucash_web_document_tag_rules')) {
      return Promise.resolve(options.rules ?? []);
    }
    if (sql.includes('COUNT(*)') && sql.includes('gnucash_web_entity_documents')) {
      return Promise.resolve([{ n: BigInt(options.remaining ?? 0) }]);
    }
    if (sql.includes('FROM gnucash_web_entity_documents')) {
      return Promise.resolve(options.docs);
    }
    if (sql.includes('FROM gnucash_web_documents')) {
      return Promise.resolve(options.texts ?? []);
    }
    if (sql.includes('FROM gnucash_web_document_tags')) {
      return Promise.resolve(options.existingJoins ?? []);
    }
    return Promise.resolve([]);
  });
}

const RULE = {
  id: 1,
  book_root_guid: BOOK,
  match_field: 'filename',
  match_value: '1099',
  tag: 'tax',
  created_at: new Date('2026-01-01T00:00:00Z'),
};

describe('applyDocumentTagRules (CODEX-5)', () => {
  it('applies matching rules and reports per-document counts', async () => {
    installApplyQueries({
      rules: [RULE],
      docs: [{ id: 9, book_guid: BOOK, title: 'INT', file_name: '1099-int.pdf', issuer: null }],
      texts: [{ source_id: '9', extracted_text: 'interest' }],
    });
    mocks.tagsFindMany.mockResolvedValue([{ id: 8, name: 'tax' }]);

    const sweep = await applyDocumentTagRules(BOOK);
    expect(sweep.results).toEqual([{ documentId: 9, applied: 1 }]);
    expect(sweep.processed).toBe(1);
    expect(sweep.remaining).toBe(0);
    expect(sweep.lastDocumentId).toBe(9);
    expect(sweep.errors).toEqual([]);
  });

  it('batches every join row into ONE insert instead of per-document statements', async () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1, book_guid: BOOK, title: `D${i}`, file_name: `1099-${i}.pdf`, issuer: null,
    }));
    installApplyQueries({ rules: [RULE], docs });
    mocks.tagsFindMany.mockResolvedValue([{ id: 8, name: 'tax' }]);

    const sweep = await applyDocumentTagRules(BOOK);
    expect(sweep.results.every((row) => row.applied === 1)).toBe(true);

    const inserts = mocks.execute.mock.calls.filter((call) =>
      sqlOf(call).includes('INSERT INTO gnucash_web_document_tags'));
    expect(inserts).toHaveLength(1);
    expect(sqlOf(inserts[0])).toContain('ON CONFLICT DO NOTHING');
    // The vocabulary is resolved once for the whole batch, not per document.
    expect(mocks.tagsFindMany.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('skips join rows a document already carries', async () => {
    installApplyQueries({
      rules: [RULE],
      docs: [{ id: 9, book_guid: BOOK, title: 'INT', file_name: '1099-int.pdf', issuer: null }],
      existingJoins: [{ document_id: 9, tag_id: 8 }],
    });
    mocks.tagsFindMany.mockResolvedValue([{ id: 8, name: 'tax' }]);

    const sweep = await applyDocumentTagRules(BOOK);
    expect(sweep.results).toEqual([{ documentId: 9, applied: 0 }]);
    expect(mocks.execute.mock.calls.filter((call) =>
      sqlOf(call).includes('INSERT INTO gnucash_web_document_tags'))).toHaveLength(0);
  });

  it('caps the documents scanned and returns a continue token', async () => {
    const docs = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1, book_guid: BOOK, title: `D${i}`, file_name: 'x.pdf', issuer: null,
    }));
    installApplyQueries({ rules: [RULE], docs, remaining: 900 });
    mocks.tagsFindMany.mockResolvedValue([{ id: 8, name: 'tax' }]);

    const sweep = await applyDocumentTagRules(BOOK, { batchSize: 3, afterId: 0 });
    expect(sweep.processed).toBe(3);
    expect(sweep.remaining).toBe(900);
    expect(sweep.lastDocumentId).toBe(3);

    // The page query is LIMITed and resumes past `afterId`.
    const pageCall = mocks.query.mock.calls.find((call) =>
      sqlOf(call).includes('FROM gnucash_web_entity_documents') && sqlOf(call).includes('LIMIT'));
    expect(pageCall).toBeDefined();
    expect(sqlOf(pageCall!)).toContain('id > ');
  });

  it('clamps an over-large requested batch to the module cap', async () => {
    installApplyQueries({ rules: [], docs: [] });
    const sweep = await applyDocumentTagRules(BOOK, { batchSize: 10_000 });
    expect(sweep.processed).toBe(0);
    expect(APPLY_RULES_BATCH_SIZE).toBe(500);
  });
});
