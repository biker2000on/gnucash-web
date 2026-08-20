import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  vocab: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  apply: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/documents/document-tags', () => ({
  listDocumentTagVocabulary: mocks.vocab,
  listDocumentTagRules: mocks.listRules,
  createDocumentTagRule: mocks.createRule,
  applyDocumentTagRules: mocks.apply,
  DocumentTagValidationError: class DocumentTagValidationError extends Error {},
}));

import { GET as getVocab } from '../route';
import { GET as getRules, POST as postRule } from '../rules/route';
import { POST as applyRules } from '../apply-rules/route';
import { DocumentTagValidationError } from '@/lib/documents/document-tags';

const BOOK = 'book-1';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ bookGuid: BOOK, user: { id: 1 }, role: 'edit' });
});

describe('GET /api/business/documents/tags', () => {
  it('returns vocabulary with counts', async () => {
    mocks.vocab.mockResolvedValue([{ name: 'farm', count: 3 }]);
    const response = await getVocab();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: [{ name: 'farm', count: 3 }] });
    expect(mocks.vocab).toHaveBeenCalledWith(BOOK);
  });
});

describe('POST /api/business/documents/tags/rules', () => {
  it('creates a rule', async () => {
    mocks.createRule.mockResolvedValue({
      id: 1, bookRootGuid: BOOK, matchField: 'filename', matchValue: '1099', tag: 'tax',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const response = await postRule(new Request('http://localhost/rules', {
      method: 'POST',
      body: JSON.stringify({ matchField: 'filename', matchValue: '1099', tag: 'tax' }),
    }));
    expect(response.status).toBe(201);
    expect(mocks.createRule).toHaveBeenCalledWith(BOOK, expect.objectContaining({
      matchField: 'filename', matchValue: '1099', tag: 'tax',
    }));
  });

  it('returns 400 for an invalid field', async () => {
    mocks.createRule.mockRejectedValue(new DocumentTagValidationError('match_field must be one of: filename, issuer, text'));
    const response = await postRule(new Request('http://localhost/rules', {
      method: 'POST',
      body: JSON.stringify({ matchField: 'title', matchValue: 'x', tag: 'x' }),
    }));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/business/documents/tags/rules', () => {
  it('lists book-scoped rules', async () => {
    mocks.listRules.mockResolvedValue([]);
    const response = await getRules();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rules: [] });
  });
});

describe('POST /api/business/documents/tags/apply-rules', () => {
  it('returns per-document applied counts', async () => {
    mocks.apply.mockResolvedValue([{ documentId: 9, applied: 2 }]);
    const response = await applyRules();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      documents: [{ documentId: 9, applied: 2 }],
    });
    expect(mocks.apply).toHaveBeenCalledWith(BOOK);
  });
});
