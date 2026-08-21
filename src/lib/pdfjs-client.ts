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

/**
 * A module import that stalls (flaky network, proxy wedge) neither resolves
 * nor rejects — and a pending memo would poison every later preview in the
 * tab. Racing a rejection turns the stall into the visible error state and
 * lets the reset below arm a retry.
 */
const MODULE_LOAD_DEADLINE_MS = 15_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('The PDF renderer took too long to load. Check the connection and try again.')), ms);
        }),
    ]);
}

export function loadPdfJs(): Promise<PdfJsModule> {
    if (!modulePromise) {
        modulePromise = withDeadline((
            // The literal specifier is REQUIRED: webpack honours the
            // webpackIgnore magic comment only on a literal import() and then
            // emits a true native import. With a variable the comment is
            // dropped and the production build compiles this into an
            // expression shim that cannot load the file at all (dev happened
            // to work, prod froze the vault preview).
            // @ts-expect-error -- runtime URL served from public/, not a module path
            import(/* webpackIgnore: true */ '/pdf.min.mjs') as Promise<PdfJsModule>
        ), MODULE_LOAD_DEADLINE_MS).then((pdfjs) => {
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
