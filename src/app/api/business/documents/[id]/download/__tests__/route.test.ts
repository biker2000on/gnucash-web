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

    it('serves an inline PDF without the CSP sandbox so the built-in viewer renders it', async () => {
        const response = await GET(request('?disposition=inline'), params);
        expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''policy.pdf");
        expect(response.headers.get('Content-Type')).toBe('application/pdf');
        // No sandbox for application/pdf: the preview modal frames this URL
        // and the browser's own PDF viewer refuses to run sandboxed — Chrome
        // downloads the file instead. nosniff pins the declared type so the
        // body can never be re-typed as HTML.
        expect(response.headers.get('Content-Security-Policy')).toBeNull();
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('keeps the CSP sandbox on inline images', async () => {
        getFileMock.mockResolvedValue({
            buffer: Buffer.from('fake-png-bytes'),
            fileName: 'roof.png',
            mimeType: 'image/png',
        });
        const response = await GET(request('?disposition=inline'), params);
        expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''roof.png");
        // <img> rendering is unaffected by sandbox, so images keep the opaque
        // origin as defence in depth.
        expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
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
