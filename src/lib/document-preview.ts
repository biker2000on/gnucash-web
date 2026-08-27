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
 * Isolation headers for an inline response, chosen per type.
 *
 * IMAGES keep the CSP `sandbox`: it drops the response into a unique opaque
 * origin, so even if a safelisted type somehow carried script it could not
 * touch the app origin or its cookies, and `<img>` rendering is unaffected by
 * it. `default-src 'none'` blocks subresource loads.
 *
 * PDFs get no CSP, deliberately: the preview modal frames the inline URL so
 * the BROWSER'S OWN viewer renders it (text selection, search, print — the
 * things a canvas paint never had), and that viewer refuses to run under
 * `sandbox` — Chrome downloads the file instead, a native save dialog popping
 * over the app. The isolation `sandbox` bought is covered differently here:
 * `nosniff` (on every response) pins the declared `application/pdf`, so the
 * body cannot be re-typed as HTML, and the viewer itself runs in the browser's
 * own isolated process, not the app origin. The stored-XSS types the safelist
 * exists for — `text/html`, `image/svg+xml` — never reach inline at all.
 *
 * (History: while these responses carried `sandbox` unconditionally, PDFs had
 * to render via a vendored pdf.js onto canvases; that dependency and its
 * vendored worker are gone with this split.)
 */
function inlineSecurityHeaders(mimeType: string): Readonly<Record<string, string>> {
    if (normalizeMime(mimeType) === 'application/pdf') return {};
    return { 'Content-Security-Policy': "sandbox; default-src 'none'" };
}

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
    // `v=3` busts the 24h-cached responses that still carry the CSP `sandbox`
    // on PDFs, which makes Chrome download the file instead of rendering it in
    // the built-in viewer the modal now frames.
    return `${documentDownloadUrl(documentId)}?disposition=inline&v=3`;
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
        ...(inline ? inlineSecurityHeaders(options.mimeType) : {}),
    };
}
