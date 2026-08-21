import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/documents/PdfCanvasPreview', () => ({
    PdfCanvasPreview: ({ src, heading }: { src: string; heading: string }) => (
        <div data-testid="pdf-canvas-preview" data-src={src} data-heading={heading} />
    ),
}));
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';

/** Stub the HEAD probe the modal runs when it opens. */
function installProbe(response: { status?: number; contentType?: string | null } | 'network-error') {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            if (response === 'network-error') throw new Error('offline');
            const status = response.status ?? 200;
            return {
                ok: status >= 200 && status < 300,
                status,
                headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? response.contentType ?? null : null) },
            } as unknown as Response;
        }),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const open = (props: Partial<React.ComponentProps<typeof DocumentPreviewModal>> = {}) =>
    render(
        <DocumentPreviewModal
            documentId={12}
            title="Homeowners policy"
            fileName="policy.pdf"
            isOpen
            onClose={() => {}}
            {...props}
        />,
    );

describe('DocumentPreviewModal', () => {
    it('renders a PDF through the pdf.js canvas preview at the inline URL', async () => {
        installProbe({ contentType: 'application/pdf' });
        open();

        const pdfPreview = await screen.findByTestId('pdf-canvas-preview');
        expect(pdfPreview.getAttribute('data-src')).toBe('/api/business/documents/12/download?disposition=inline&v=2');
        // Never the built-in viewer: under the response's CSP sandbox Chrome
        // downloads instead of rendering (native save dialog over the app).
        expect(document.querySelector('iframe')).toBeNull();
    });

    it('renders an image document as an img', async () => {
        installProbe({ contentType: 'image/png' });
        open({ title: 'Roof photo', fileName: 'roof.png' });

        const image = await screen.findByAltText('Preview of Roof photo');
        expect(image.tagName).toBe('IMG');
        expect(image.getAttribute('src')).toBe('/api/business/documents/12/download?disposition=inline&v=2');
    });

    it('offers a download instead of a frame for a type that cannot be previewed', async () => {
        installProbe({ contentType: 'application/zip' });
        open({ title: 'Archive', fileName: 'bundle.zip' });

        expect(await screen.findByText(/Preview isn’t available/i)).toBeTruthy();
        expect(screen.queryByTitle(/^Preview of/)).toBeNull();
        const link = screen.getByText('Download file') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/api/business/documents/12/download');
    });

    it('renders the preview immediately without any probe request', async () => {
        // The old HEAD probe ran the GET handler server-side and read the whole
        // object from storage with no deadline — the 2026-08-21 freeze. The
        // modal now renders optimistically from the caller's MIME/filename and
        // the byte fetch inside the renderer surfaces 404s itself.
        installProbe({ contentType: 'application/pdf' });
        open();

        await screen.findByTestId('pdf-canvas-preview');
        expect(globalThis.fetch).not.toHaveBeenCalledWith(
            expect.stringContaining('/download'),
            expect.objectContaining({ method: 'HEAD' }),
        );
    });

    it('falls back to the caller-supplied file name when the probe fails', async () => {
        installProbe('network-error');
        open();

        // The probe failing open still previews: kind comes from the caller's
        // mimeType/fileName, and the canvas renderer surfaces any real error.
        const pdfPreview = await screen.findByTestId('pdf-canvas-preview');
        expect(pdfPreview.getAttribute('data-heading')).toBe('Homeowners policy');
    });

    it('always exposes a download action in the header', async () => {
        installProbe({ contentType: 'application/pdf' });
        open();

        await waitFor(() => {
            const download = screen.getByText('Download') as HTMLAnchorElement;
            expect(download.getAttribute('href')).toBe('/api/business/documents/12/download');
        });
    });

    it('renders nothing when there is no document to show', () => {
        installProbe({ contentType: 'application/pdf' });
        const { container } = open({ documentId: null, isOpen: false });
        expect(container.innerHTML).toBe('');
    });
});
