/**
 * Inline-preview contract for document-vault files.
 *
 * `GET /api/business/documents/[id]/download` serves `attachment` by default and
 * only switches to `inline` when the caller asks for it *and* the stored MIME type
 * is on the safelist below. Serving user-uploaded bytes inline from our own origin
 * is a stored-XSS vector (an HTML or SVG upload would run script in the app origin
 * and could reach the session cookie), so the safelist deliberately excludes
 * `text/html` and `image/svg+xml` — anything not listed falls back to a download.
 *
 * Shared by the route (server) and the preview modal (client) so both sides agree
 * on which documents can be shown in a frame.
 */

/** MIME types that may be served inline. Rendered by the browser, never scripted. */
export const INLINE_PREVIEW_MIME_TYPES = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
] as const;

/**
 * Headers added to inline responses.
 *
 * `sandbox` is the load-bearing one: it drops the response into a unique opaque
 * origin, so even if a safelisted type somehow carried script it could not touch
 * the app origin or its cookies. `default-src 'none'` blocks subresource loads.
 * Verified in Chrome 141 that the built-in PDF viewer still renders under this
 * exact policy, so no relaxation was needed (see DocumentPreviewModal for the
 * matching note about the iframe `sandbox` *attribute*, which is a different
 * mechanism and does break the viewer).
 */
export const INLINE_RESPONSE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
};

/** Strip parameters (`application/pdf; charset=…`) and normalise case. */
function normalizeMime(mimeType: string | null | undefined): string {
    return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** True when the MIME type is safe to render inline in the browser. */
export function isInlinePreviewableMime(mimeType: string | null | undefined): boolean {
    return (INLINE_PREVIEW_MIME_TYPES as readonly string[]).includes(normalizeMime(mimeType));
}

/** How the preview modal should render a document, or null when it cannot. */
export type DocumentPreviewKind = 'pdf' | 'image';

const EXTENSION_MIME: Readonly<Record<string, string>> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};

/**
 * Decide how to preview a document. Prefers the server-reported MIME type and
 * falls back to the file extension, which is all some callers (renewal chips,
 * linked-document chips) carry. Returns null when the file is not previewable —
 * callers must then offer a download instead of an empty frame.
 */
export function resolvePreviewKind(
    mimeType: string | null | undefined,
    fileName?: string | null,
): DocumentPreviewKind | null {
    let mime = normalizeMime(mimeType);
    if (!isInlinePreviewableMime(mime) && fileName) {
        const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
        mime = EXTENSION_MIME[extension] ?? '';
    }
    if (!isInlinePreviewableMime(mime)) return null;
    return mime === 'application/pdf' ? 'pdf' : 'image';
}

/** Download URL (forces `attachment`). Unchanged from before preview existed. */
export function documentDownloadUrl(documentId: number): string {
    return `/api/business/documents/${documentId}/download`;
}

/** Same bytes, asking for `inline`; the server still decides by MIME type. */
export function documentInlineUrl(documentId: number): string {
    return `${documentDownloadUrl(documentId)}?disposition=inline`;
}

/**
 * Response headers for a served document. `attachment` is the default and the
 * only outcome for anything off the inline safelist, regardless of what the
 * caller asked for.
 */
export function buildDocumentServeHeaders(options: {
    mimeType: string;
    fileName: string;
    /** Raw `disposition` query parameter, if any. */
    requestedDisposition?: string | null;
}): Record<string, string> {
    const wantsInline = options.requestedDisposition?.trim().toLowerCase() === 'inline';
    const inline = wantsInline && isInlinePreviewableMime(options.mimeType);
    const disposition = inline ? 'inline' : 'attachment';

    return {
        'Content-Type': options.mimeType,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`,
        'Cache-Control': 'private, max-age=86400',
        // nosniff on every response: it never changes how an attachment behaves,
        // and it stops a mislabelled body being re-typed as HTML.
        'X-Content-Type-Options': 'nosniff',
        ...(inline ? INLINE_RESPONSE_SECURITY_HEADERS : {}),
    };
}
