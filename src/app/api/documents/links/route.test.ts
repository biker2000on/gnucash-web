import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  auth,
  ensure,
  scope,
  link,
  list,
  target,
  MockDocumentValidationError,
  MockDocumentNotFoundError,
  MockTargetError,
} = vi.hoisted(() => {
  class MockDocumentValidationError extends Error {}
  class MockDocumentNotFoundError extends Error {}
  class MockTargetError extends Error {}
  return {
    auth: vi.fn(),
    ensure: vi.fn(),
    scope: vi.fn(),
    link: vi.fn(),
    list: vi.fn(),
    target: vi.fn(),
    MockDocumentValidationError,
    MockDocumentNotFoundError,
    MockTargetError,
  };
});

vi.mock('@/lib/auth', () => ({ requireRole: auth }));
vi.mock('@/lib/documents', () => ({
  DocumentValidationError: MockDocumentValidationError,
  DocumentNotFoundError: MockDocumentNotFoundError,
  ensureCanonicalDocumentPlatform: ensure,
  validateDocumentBookScope: scope,
  linkDocument: link,
  listLinkedDocuments: list,
}));
vi.mock('@/lib/services/document-link-targets.service', () => ({
  DocumentLinkTargetValidationError: MockTargetError,
  isDocumentLinkTargetType: (value: unknown) => value === 'home_item',
  validateDocumentLinkTarget: target,
}));

import { GET, POST } from './route';

const principal = { bookGuid: 'book-1', user: { id: 17, username: 'tester' }, role: 'edit' as const };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(principal);
  scope.mockResolvedValue({ id: 42 });
  target.mockResolvedValue(undefined);
});

describe('/api/documents/links', () => {
  it('lists only links for a validated active-book target with readonly access', async () => {
    list.mockResolvedValue([{
      link: {
        id: 3, bookGuid: 'book-1', documentId: 42, targetType: 'home_item',
        targetId: '7', role: 'manual', metadata: {}, createdBy: 17,
        createdAt: new Date('2026-08-02T12:00:00Z'),
      },
      document: {
        id: 42, bookGuid: 'book-1', ownerUserId: 17, title: 'Manual',
        storageKey: 'secret/key', filename: 'manual.pdf', mimeType: 'application/pdf',
        sizeBytes: 1234n, contentHash: 'secret-hash', dedupeKey: 'secret-dedupe',
        extractionStatus: 'completed', extractedText: 'private full text',
        extractionMetadata: { characterCount: 17, suggestionKind: 'generic_document', secret: true },
        extractionError: null, extractedAt: new Date('2026-08-02T12:01:00Z'),
        sourceKind: 'entity_document', sourceId: '8',
        createdAt: new Date('2026-08-02T12:00:00Z'),
        updatedAt: new Date('2026-08-02T12:01:00Z'),
      },
    }]);
    const response = await GET(new NextRequest('http://localhost/api/documents/links?targetType=home_item&targetId=7'));

    expect(response.status).toBe(200);
    expect(auth).toHaveBeenCalledWith('readonly');
    expect(target).toHaveBeenCalledWith('book-1', { targetType: 'home_item', targetId: '7', userId: 17 });
    expect(list).toHaveBeenCalledWith({ bookGuid: 'book-1', targetType: 'home_item', targetId: '7' });
    const payload = await response.json();
    expect(payload.links[0]).toEqual({
      link: {
        id: 3, documentId: 42, targetType: 'home_item', targetId: '7',
        role: 'manual', metadata: {}, createdAt: '2026-08-02T12:00:00.000Z',
      },
      document: expect.objectContaining({
        id: 42,
        sizeBytes: 1234,
        sourceKind: 'entity_document',
        extractionSummary: expect.objectContaining({ hasText: true, characterCount: 17 }),
      }),
    });
    expect(JSON.stringify(payload)).not.toContain('secret/key');
    expect(JSON.stringify(payload)).not.toContain('secret-hash');
    expect(JSON.stringify(payload)).not.toContain('private full text');
    expect(JSON.stringify(payload)).not.toContain('createdBy');
    expect(JSON.stringify(payload)).not.toContain('bookGuid');
  });

  it('requires edit access and proves document plus target scope before linking', async () => {
    link.mockResolvedValue({
      id: 9,
      bookGuid: 'book-1',
      documentId: 42,
      targetType: 'home_item',
      targetId: '7',
      role: 'manual',
      metadata: { note: 'manual' },
      createdBy: 17,
      createdAt: new Date('2026-08-02T12:00:00Z'),
    });
    const request = new NextRequest('http://localhost/api/documents/links', {
      method: 'POST',
      body: JSON.stringify({ documentId: 42, targetType: 'home_item', targetId: '7', role: 'manual', metadata: { note: 'manual' } }),
      headers: { 'content-type': 'application/json' },
    });
    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(auth).toHaveBeenCalledWith('edit');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(scope).toHaveBeenCalledWith('book-1', 42);
    expect(target).toHaveBeenCalledWith('book-1', {
      targetType: 'home_item', targetId: '7', role: 'manual', userId: 17,
    });
    expect(link).toHaveBeenCalledWith({
      bookGuid: 'book-1', documentId: 42, targetType: 'home_item', targetId: '7',
      role: 'manual', metadata: { note: 'manual' }, createdBy: 17,
    });
    const payload = await response.json();
    expect(payload.link).toEqual({
      id: 9,
      documentId: 42,
      targetType: 'home_item',
      targetId: '7',
      role: 'manual',
      metadata: { note: 'manual' },
      createdAt: '2026-08-02T12:00:00.000Z',
    });
    expect(payload.link).not.toHaveProperty('bookGuid');
    expect(payload.link).not.toHaveProperty('createdBy');
  });

  it('does not leak a cross-book target: the target validator produces 404', async () => {
    target.mockRejectedValue(new MockTargetError('Home item not found in this book'));
    const request = new NextRequest('http://localhost/api/documents/links', {
      method: 'POST',
      body: JSON.stringify({ documentId: 42, targetType: 'home_item', targetId: '999', role: 'manual' }),
      headers: { 'content-type': 'application/json' },
    });
    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(link).not.toHaveBeenCalled();
  });
});
