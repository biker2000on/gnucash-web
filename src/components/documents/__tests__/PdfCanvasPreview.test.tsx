/**
 * PdfCanvasPreview — pdf.js canvas renderer.
 *
 * pdf.js is mocked: these tests pin the component's contract (fetch the
 * bytes, one canvas per page, bounded page count, error fallback), not the
 * library's rasterization.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDocumentMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pdfjs-client', () => ({
    loadPdfJs: async () => ({
        GlobalWorkerOptions: { workerSrc: 'test-worker' },
        getDocument: getDocumentMock,
    }),
}));

import { PdfCanvasPreview } from '../PdfCanvasPreview';

function fakeDoc(numPages: number) {
    return {
        numPages,
        getPage: vi.fn(async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
            cleanup: vi.fn(),
        })),
        destroy: vi.fn(async () => undefined),
    };
}

describe('PdfCanvasPreview', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        getDocumentMock.mockReset();
        // jsdom has no 2d context; the component only hands it to pdf.js.
        HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
    });

    it('renders one canvas per page from the fetched bytes', async () => {
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakeDoc(3)) });
        render(<PdfCanvasPreview src="/api/business/documents/7/download?disposition=inline&v=2" heading="Policy" />);

        await waitFor(() => {
            expect(screen.getByTestId('pdf-canvas-pages').querySelectorAll('canvas')).toHaveLength(3);
        });
        expect(fetch).toHaveBeenCalledWith('/api/business/documents/7/download?disposition=inline&v=2');
        expect(screen.getByLabelText('Page 1 of Policy')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('caps rendering at 100 pages and says so', async () => {
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakeDoc(150)) });
        render(<PdfCanvasPreview src="/x" heading="Big" />);

        await waitFor(() => {
            expect(screen.getByTestId('pdf-canvas-pages').querySelectorAll('canvas')).toHaveLength(100);
        }, { timeout: 10_000 });
        expect(screen.getByText(/first 100 pages/)).toBeTruthy();
    });

    it('shows the error fallback when the bytes cannot be fetched', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
        render(<PdfCanvasPreview src="/x" heading="Gone" />);

        await waitFor(() => {
            expect(screen.getByRole('alert').textContent).toContain('no longer in the vault');
        });
        expect(getDocumentMock).not.toHaveBeenCalled();
    });

    it('shows the error fallback when pdf.js cannot parse the document', async () => {
        getDocumentMock.mockReturnValue({ promise: Promise.reject(new Error('Invalid PDF structure')) });
        render(<PdfCanvasPreview src="/x" heading="Corrupt" />);

        await waitFor(() => {
            expect(screen.getByRole('alert').textContent).toContain('Invalid PDF structure');
        });
    });
});
