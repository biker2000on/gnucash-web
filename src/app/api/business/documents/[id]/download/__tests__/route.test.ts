import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK_A = 'book-a';

const { requireRoleMock, getFileMock } = vi.hoisted(() => ({
    requireRoleMock: vi.fn(),
    getFileMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/services/entity-documents.service', () => ({
    getEntityDocumentFile: getFileMock,
    EntityDocumentNotFoundError: class EntityDocumentNotFoundError extends Error {},
}));

import { GET } from '../route';
import { EntityDocumentNotFoundError } from '@/lib/services/entity-documents.service';

const params = { params: Promise.resolve({ id: '12' }) };
const request = (query = '') => new Request(`http://localhost/api/business/documents/12/download${query}`);

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: BOOK_A, user: { id: 1 }, role: 'readonly' });
    getFileMock.mockResolvedValue({
        buffer: Buffer.from('%PDF-1.4 fake'),
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
    });
});

describe('GET document download', () => {
    it('downloads as an attachment when no disposition is requested', async () => {
        const response = await GET(request(), params);
        expect(response.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''policy.pdf");
        expect(response.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('serves a safelisted type inline with the isolation headers', async () => {
        const response = await GET(request('?disposition=inline'), params);
        expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''policy.pdf");
        expect(response.headers.get('Content-Type')).toBe('application/pdf');
        // PDFs must NOT be CSP-sandboxed: Chrome refuses to run its PDF viewer in
        // a sandboxed document and downloads the file instead (a native save
        // dialog over the app). Images keep the sandbox.
        expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('falls back to attachment for a type that must never be framed', async () => {
        getFileMock.mockResolvedValue({
            buffer: Buffer.from('<script>alert(1)</script>'),
            fileName: 'evil.html',
            mimeType: 'text/html',
        });
        const response = await GET(request('?disposition=inline'), params);
        expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
        expect(response.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('still scopes the read to the authorized book', async () => {
        await GET(request('?disposition=inline'), params);
        expect(getFileMock).toHaveBeenCalledWith(BOOK_A, 12);
    });

    it('rejects a non-numeric id before touching the vault', async () => {
        const response = await GET(request(), { params: Promise.resolve({ id: 'abc' }) });
        expect(response.status).toBe(400);
        expect(getFileMock).not.toHaveBeenCalled();
    });

    it('reports a deleted document as 404 so the preview can explain itself', async () => {
        getFileMock.mockRejectedValue(new EntityDocumentNotFoundError('Document not found'));
        const response = await GET(request('?disposition=inline'), params);
        expect(response.status).toBe(404);
    });
});
