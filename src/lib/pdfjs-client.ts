'use client';

/**
 * Loads pdf.js in the BROWSER via a native dynamic import of the vendored
 * copy in `public/` — deliberately outside the bundler.
 *
 * Webpack cannot process `pdfjs-dist`'s ESM builds: evaluating either the
 * modern or the legacy build through the bundle dies in
 * `__webpack_require__.r` with "Object.defineProperty called on non-object".
 * `webpackIgnore` hands the import statement to the browser untouched, so the
 * official build runs exactly as shipped. Both files are committed copies of
 * the installed package (`public/pdf.min.mjs`, `public/pdf.worker.min.mjs`);
 * `src/__tests__/pdf-worker-asset.test.ts` fails the suite if they drift from
 * `node_modules/pdfjs-dist/build/` after a version bump.
 */

/** The subset of pdf.js this app renders with. */
export interface PdfJsPageViewport {
    width: number;
    height: number;
}

export interface PdfJsPage {
    getViewport(options: { scale: number }): PdfJsPageViewport;
    render(options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: PdfJsPageViewport;
        transform?: number[];
    }): { promise: Promise<void>; cancel(): void };
    cleanup(): void;
}

export interface PdfJsDocument {
    numPages: number;
    getPage(pageNo: number): Promise<PdfJsPage>;
    destroy(): Promise<unknown>;
}

export interface PdfJsModule {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(options: { data: ArrayBuffer }): { promise: Promise<PdfJsDocument> };
}

let modulePromise: Promise<PdfJsModule> | null = null;

export function loadPdfJs(): Promise<PdfJsModule> {
    if (!modulePromise) {
        // The specifier is a runtime URL, not a module path — keep TS from
        // trying to resolve it while webpack passes it through untouched.
        const specifier = '/pdf.min.mjs';
        modulePromise = (import(/* webpackIgnore: true */ specifier) as Promise<PdfJsModule>).then((pdfjs) => {
            if (!pdfjs.GlobalWorkerOptions.workerSrc) {
                pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
            }
            return pdfjs;
        });
        // A transient load failure (offline, deploy in flight) must not poison
        // every later preview with the same rejected promise.
        modulePromise.catch(() => { modulePromise = null; });
    }
    return modulePromise;
}
