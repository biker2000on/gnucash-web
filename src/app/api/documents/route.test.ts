import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { auth, ensure, list, MockDocumentValidationError } = vi.hoisted(() => {
    class MockDocumentValidationError extends Error {}
    return {
        auth: vi.fn(),
        ensure: vi.fn(),
        list: vi.fn(),
        MockDocumentValidationError,
    };
});

vi.mock('@/lib/auth', () => ({ requireRole: auth }));
vi.mock('@/lib/documents', () => ({
    DocumentValidationError: MockDocumentValidationError,
    ensureCanonicalDocumentPlatform: ensure,
    listDocuments: list,
}));

import { GET } from './route';

beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ bookGuid: 'book-1', user: { id: 3 }, role: 'readonly' });
    ensure.mockResolvedValue(undefined);
});

describe('GET /api/documents', () => {
    it('returns picker-safe metadata without storage, hashes, ownership, or extracted text', async () => {
        list.mockResolvedValue([{
            id: 8,
            bookGuid: 'book-1',
            ownerUserId: 3,
            title: 'Lease',
            storageKey: 'entity-documents/private-key.pdf',
            filename: 'lease.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1234n,
            contentHash: 'private-hash',
            dedupeKey: 'private-dedupe-key',
            extractionStatus: 'completed',
            extractedText: 'full private extracted text',
            extractionMetadata: { private: true },
            extractionError: null,
            extractedAt: new Date('2026-07-01T00:00:00.000Z'),
            sourceKind: 'entity_document',
            sourceId: '44',
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
            updatedAt: new Date('2026-07-02T00:00:00.000Z'),
        }]);

        const response = await GET(new NextRequest('http://localhost/api/documents?limit=25&q=lease'));

        expect(response.status).toBe(200);
        expect(auth).toHaveBeenCalledWith('readonly');
        expect(list).toHaveBeenCalledWith({ bookGuid: 'book-1', query: 'lease', limit: 25, offset: 0 });
        await expect(response.json()).resolves.toEqual({
            documents: [{
                id: 8,
                title: 'Lease',
                filename: 'lease.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 1234,
                sourceKind: 'entity_document',
                sourceId: '44',
                extractionStatus: 'completed',
                extractedAt: '2026-07-01T00:00:00.000Z',
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-07-02T00:00:00.000Z',
            }],
        });
    });
});
