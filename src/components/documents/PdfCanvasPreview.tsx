'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPdfJs, type PdfJsDocument } from '@/lib/pdfjs-client';

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
 *
 * Zoom: 100% = fit the container width. The toolbar (and Ctrl+scroll)
 * re-render every page at the new scale — canvases are re-rasterized, not
 * CSS-scaled, so text stays crisp when zoomed in.
 */

/** Pages rendered at most — a bound on memory for pathological documents. */
const MAX_RENDERED_PAGES = 100;

/** Byte-fetch deadline; a stalled storage read must surface, not hang the modal. */
const BYTE_FETCH_DEADLINE_MS = 30_000;

/** Cap the backing-store scale so a huge monitor cannot demand giant bitmaps. */
const MAX_PIXEL_RATIO = 2;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

type LoadState =
    | { status: 'loading' }
    | { status: 'ready'; pageCount: number; truncated: boolean }
    | { status: 'error'; message: string };

export function PdfCanvasPreview({ src, heading }: { src: string; heading: string }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const docRef = useRef<PdfJsDocument | null>(null);
    const [state, setState] = useState<LoadState>({ status: 'loading' });
    const [zoom, setZoom] = useState(1);
    // Bumps when the document finishes loading so the render effect re-runs.
    const [docGeneration, setDocGeneration] = useState(0);

    // Load: fetch the bytes, parse the document. Renders nothing itself.
    useEffect(() => {
        let cancelled = false;
        // Abort the byte fetch on unmount AND on the deadline: an unbounded
        // request behind the modal is exactly the freeze this component was
        // built to eliminate.
        const controller = new AbortController();
        const deadline = setTimeout(
            () => controller.abort(new DOMException('Preview timed out', 'TimeoutError')),
            BYTE_FETCH_DEADLINE_MS,
        );

        setState({ status: 'loading' });
        setZoom(1);

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
                if (cancelled) {
                    void doc.destroy().catch(() => undefined);
                    return;
                }
                docRef.current = doc;
                setState({
                    status: 'ready',
                    pageCount: Math.min(doc.numPages, MAX_RENDERED_PAGES),
                    truncated: doc.numPages > MAX_RENDERED_PAGES,
                });
                setDocGeneration((generation) => generation + 1);
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
            const doc = docRef.current;
            docRef.current = null;
            void doc?.destroy().catch(() => undefined);
        };
    }, [src]);

    // Render: rasterize every page at the current zoom. Re-runs on zoom; a
    // superseded pass stops at the next page boundary via the cancel flag.
    useEffect(() => {
        const doc = docRef.current;
        const container = containerRef.current;
        if (!doc || !container || docGeneration === 0) return;

        let cancelled = false;
        void (async () => {
            try {
                const pageCount = Math.min(doc.numPages, MAX_RENDERED_PAGES);
                const width = Math.max((scrollRef.current?.clientWidth ?? container.clientWidth) - 26, 320);
                const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
                container.replaceChildren();
                for (let pageNo = 1; pageNo <= pageCount && !cancelled; pageNo++) {
                    const page = await doc.getPage(pageNo);
                    if (cancelled) return;
                    const base = page.getViewport({ scale: 1 });
                    const scale = (width / base.width) * zoom;
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
                if (cancelled) return;
                setState({
                    status: 'error',
                    message: caught instanceof Error ? caught.message : 'The PDF could not be rendered.',
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [docGeneration, zoom, heading]);

    const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    const zoomIn = useCallback(() => setZoom((z) => clampZoom(z * ZOOM_STEP)), []);
    const zoomOut = useCallback(() => setZoom((z) => clampZoom(z / ZOOM_STEP)), []);

    // Ctrl+scroll zoom, the way every PDF viewer does it. Attached natively:
    // React's synthetic wheel listener is passive, so preventDefault (needed
    // to stop the browser's own page zoom) would be ignored.
    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setZoom((z) => clampZoom(event.deltaY < 0 ? z * ZOOM_STEP : z / ZOOM_STEP));
        };
        scroller.addEventListener('wheel', onWheel, { passive: false });
        return () => scroller.removeEventListener('wheel', onWheel);
    }, []);

    const toolbarButton = 'rounded-md border border-border px-2 py-0.5 text-sm text-foreground-secondary transition-colors hover:border-primary hover:text-primary disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground-secondary';

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
            {state.status === 'ready' && (
                <div className="mb-2 flex items-center justify-center gap-2" role="toolbar" aria-label="PDF controls">
                    <button type="button" onClick={zoomOut} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out" className={toolbarButton}>−</button>
                    <span className="min-w-14 text-center font-mono text-xs text-foreground-secondary" aria-live="polite">
                        {Math.round(zoom * 100)}%
                    </span>
                    <button type="button" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" className={toolbarButton}>+</button>
                    <button type="button" onClick={() => setZoom(1)} disabled={zoom === 1} aria-label="Fit width" className={toolbarButton}>Fit</button>
                    <span className="ml-2 font-mono text-xs text-foreground-muted">
                        {state.pageCount} page{state.pageCount === 1 ? '' : 's'}
                    </span>
                </div>
            )}
            <div
                ref={scrollRef}
                className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-auto rounded-lg border border-border bg-background-tertiary p-3"
            >
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
        </div>
    );
}
