import { describe, expect, it } from 'vitest';
import {
    buildDocumentServeHeaders,
    documentDownloadUrl,
    documentInlineUrl,
    INLINE_PREVIEW_MIME_TYPES,
    isInlinePreviewableMime,
    resolvePreviewKind,
} from '@/lib/document-preview';

const serve = (mimeType: string, requestedDisposition?: string | null) =>
    buildDocumentServeHeaders({ mimeType, fileName: 'policy.pdf', requestedDisposition });

describe('inline preview safelist', () => {
    it.each([...INLINE_PREVIEW_MIME_TYPES])('allows %s', (mime) => {
        expect(isInlinePreviewableMime(mime)).toBe(true);
    });

    it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/plain', 'application/octet-stream'])(
        'refuses %s',
        (mime) => {
            expect(isInlinePreviewableMime(mime)).toBe(false);
        },
    );

    it('ignores parameters and casing on the stored mime type', () => {
        expect(isInlinePreviewableMime('APPLICATION/PDF; charset=binary')).toBe(true);
    });

    it('treats a missing mime type as not previewable', () => {
        expect(isInlinePreviewableMime(null)).toBe(false);
        expect(isInlinePreviewableMime(undefined)).toBe(false);
    });
});

describe('buildDocumentServeHeaders', () => {
    it('defaults to attachment when no disposition is requested', () => {
        expect(serve('application/pdf')['Content-Disposition']).toBe(
            "attachment; filename*=UTF-8''policy.pdf",
        );
    });

    it('serves a safelisted type inline when asked', () => {
        const headers = serve('application/pdf', 'inline');
        expect(headers['Content-Disposition']).toBe("inline; filename*=UTF-8''policy.pdf");
        expect(headers['Content-Type']).toBe('application/pdf');
    });

    it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('serves %s inline when asked', (mime) => {
        expect(serve(mime, 'inline')['Content-Disposition']).toMatch(/^inline;/);
    });

    it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])(
        'forces attachment for %s even when inline is requested',
        (mime) => {
            const headers = serve(mime, 'inline');
            expect(headers['Content-Disposition']).toMatch(/^attachment;/);
            expect(headers['Content-Security-Policy']).toBeUndefined();
        },
    );

    it('ignores an unrecognised disposition value', () => {
        expect(serve('application/pdf', 'INLINE ')['Content-Disposition']).toMatch(/^inline;/);
        expect(serve('application/pdf', 'embed')['Content-Disposition']).toMatch(/^attachment;/);
        expect(serve('application/pdf', '')['Content-Disposition']).toMatch(/^attachment;/);
    });

    it('sends the isolation headers only on inline responses', () => {
        const inline = serve('application/pdf', 'inline');
        expect(inline['Content-Security-Policy']).toBe("sandbox; default-src 'none'");
        expect(inline['X-Content-Type-Options']).toBe('nosniff');

        const attachment = serve('application/pdf');
        expect(attachment['Content-Security-Policy']).toBeUndefined();
        // nosniff is safe on downloads too and does not change their behaviour.
        expect(attachment['X-Content-Type-Options']).toBe('nosniff');
    });

    it('keeps the download cache policy private', () => {
        expect(serve('application/pdf', 'inline')['Cache-Control']).toBe('private, max-age=86400');
    });

    it('percent-encodes the filename', () => {
        const headers = buildDocumentServeHeaders({
            mimeType: 'application/pdf',
            fileName: 'my policy (2026).pdf',
            requestedDisposition: 'inline',
        });
        expect(headers['Content-Disposition']).toBe("inline; filename*=UTF-8''my%20policy%20(2026).pdf");
    });
});

describe('resolvePreviewKind', () => {
    it('reads the mime type first', () => {
        expect(resolvePreviewKind('application/pdf')).toBe('pdf');
        expect(resolvePreviewKind('image/png')).toBe('image');
    });

    it('falls back to the file extension when the mime type is missing', () => {
        expect(resolvePreviewKind(null, 'statement.PDF')).toBe('pdf');
        expect(resolvePreviewKind(undefined, 'scan.jpeg')).toBe('image');
    });

    it('returns null for types that must not be framed', () => {
        expect(resolvePreviewKind('text/html', 'note.html')).toBeNull();
        expect(resolvePreviewKind('image/svg+xml', 'logo.svg')).toBeNull();
        expect(resolvePreviewKind(null, 'archive.zip')).toBeNull();
        expect(resolvePreviewKind(null, null)).toBeNull();
    });
});

describe('document urls', () => {
    it('keeps the download url free of the disposition parameter', () => {
        expect(documentDownloadUrl(7)).toBe('/api/business/documents/7/download');
        expect(documentInlineUrl(7)).toBe('/api/business/documents/7/download?disposition=inline');
    });
});
