'use client';

import { useEffect, useRef, useState } from 'react';
import { loadPdfJs } from '@/lib/pdfjs-client';

/**
 * PDF preview rendered with pdf.js onto canvases — deliberately NOT the
 * browser's built-in viewer.
 *
 * The built-in viewer runs as a plugin inside the frame that receives the
 * bytes, which made preview hostage to how each browser treats the response:
 * under the vault's `Content-Security-Policy: sandbox` Chrome refuses to run
 * the plugin and DOWNLOADS the file instead — a native save dialog popping
 * over the app, reported as "preview freezes everything". Rendering with
 * pdf.js keeps everything an ordinary same-origin fetch + canvas paint, so
 * the byte response can keep the strictest isolation headers and no browser
 * plugin behaviour is involved at all.
 *
 * pdf.js loads lazily via a native browser import of the vendored copy in
 * public/ (see src/lib/pdfjs-client.ts for why the bundler is bypassed);
 * parsing runs in the pdf.js web worker, never on the main thread.
 */

/** Pages rendered at most — a bound on memory for pathological documents. */
const MAX_RENDERED_PAGES = 100;

/** Byte-fetch deadline; a stalled storage read must surface, not hang the modal. */
const BYTE_FETCH_DEADLINE_MS = 30_000;

/** Cap the backing-store scale so a huge monitor cannot demand giant bitmaps. */
const MAX_PIXEL_RATIO = 2;

type LoadState =
    | { status: 'loading' }
    | { status: 'ready'; pageCount: number; truncated: boolean }
    | { status: 'error'; message: string };

export function PdfCanvasPreview({ src, heading }: { src: string; heading: string }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<LoadState>({ status: 'loading' });

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let cancelled = false;
        // Track the document so unmount can free the worker's memory.
        let loadedDoc: { destroy: () => Promise<unknown> } | null = null;
        // Abort the byte fetch on unmount AND on the deadline: an unbounded
        // request behind the modal is exactly the freeze this component was
        // built to eliminate.
        const controller = new AbortController();
        const deadline = setTimeout(
            () => controller.abort(new DOMException('Preview timed out', 'TimeoutError')),
            BYTE_FETCH_DEADLINE_MS,
        );

        void (async () => {
            try {
                const pdfjs = await loadPdfJs();

                const response = await fetch(src, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(
                        response.status === 404
                            ? 'This document is no longer in the vault.'
                            : `The document could not be loaded (HTTP ${response.status}).`,
                    );
                }
                const data = await response.arrayBuffer();
                clearTimeout(deadline);
                if (cancelled) return;

                const doc = await pdfjs.getDocument({ data }).promise;
                loadedDoc = doc;
                if (cancelled) return;

                const pageCount = Math.min(doc.numPages, MAX_RENDERED_PAGES);
                setState({ status: 'ready', pageCount, truncated: doc.numPages > MAX_RENDERED_PAGES });

                // Render sequentially so page 1 appears immediately and memory
                // stays bounded; each canvas is appended as soon as it paints.
                const width = Math.max(container.clientWidth - 2, 320);
                const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
                for (let pageNo = 1; pageNo <= pageCount && !cancelled; pageNo++) {
                    const page = await doc.getPage(pageNo);
                    if (cancelled) return;
                    const base = page.getViewport({ scale: 1 });
                    const scale = width / base.width;
                    const viewport = page.getViewport({ scale });

                    const canvas = document.createElement('canvas');
                    canvas.width = Math.floor(viewport.width * ratio);
                    canvas.height = Math.floor(viewport.height * ratio);
                    canvas.style.width = `${Math.floor(viewport.width)}px`;
                    canvas.style.height = `${Math.floor(viewport.height)}px`;
                    canvas.className = 'mx-auto mb-3 block rounded-sm bg-white shadow-sm';
                    canvas.setAttribute('role', 'img');
                    canvas.setAttribute('aria-label', `Page ${pageNo} of ${heading}`);

                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
                    await page.render({
                        canvasContext: context,
                        viewport,
                        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
                    }).promise;
                    if (cancelled) return;
                    container.appendChild(canvas);
                    page.cleanup();
                }
            } catch (caught) {
                clearTimeout(deadline);
                if (cancelled) return;
                const timedOut = caught instanceof DOMException &&
                    (caught.name === 'TimeoutError' || caught.name === 'AbortError');
                setState({
                    status: 'error',
                    message: timedOut
                        ? 'The document is taking too long to load.'
                        : caught instanceof Error ? caught.message : 'The PDF could not be rendered.',
                });
            }
        })();

        return () => {
            cancelled = true;
            clearTimeout(deadline);
            controller.abort();
            container.replaceChildren();
            void loadedDoc?.destroy().catch(() => undefined);
        };
    }, [src, heading]);

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-auto rounded-lg border border-border bg-background-tertiary p-3">
            {state.status === 'loading' && (
                <p className="m-auto text-sm text-foreground-secondary">Rendering preview…</p>
            )}
            {state.status === 'error' && (
                <p className="m-auto max-w-md text-center text-sm text-foreground-secondary" role="alert">
                    {state.message} Use Download to open the file locally.
                </p>
            )}
            <div ref={containerRef} data-testid="pdf-canvas-pages" className="w-full" />
            {state.status === 'ready' && state.truncated && (
                <p className="py-2 text-center text-xs text-foreground-muted">
                    Showing the first {MAX_RENDERED_PAGES} pages — download the file for the rest.
                </p>
            )}
        </div>
    );
}
