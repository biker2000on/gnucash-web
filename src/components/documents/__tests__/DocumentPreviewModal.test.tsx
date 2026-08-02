import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    it('frames a PDF at the inline URL', async () => {
        installProbe({ contentType: 'application/pdf' });
        open();

        const frame = await screen.findByTitle('Preview of Homeowners policy');
        expect(frame.tagName).toBe('IFRAME');
        expect(frame.getAttribute('src')).toBe('/api/business/documents/12/download?disposition=inline');
    });

    it('leaves the iframe sandbox attribute off, which Chrome needs for its PDF viewer', async () => {
        installProbe({ contentType: 'application/pdf' });
        open();

        const frame = await screen.findByTitle('Preview of Homeowners policy');
        // Isolation is provided by the response CSP `sandbox; default-src 'none'`
        // instead — see the note in DocumentPreviewModal.
        expect(frame.hasAttribute('sandbox')).toBe(false);
    });

    it('renders an image document as an img', async () => {
        installProbe({ contentType: 'image/png' });
        open({ title: 'Roof photo', fileName: 'roof.png' });

        const image = await screen.findByAltText('Preview of Roof photo');
        expect(image.tagName).toBe('IMG');
        expect(image.getAttribute('src')).toBe('/api/business/documents/12/download?disposition=inline');
    });

    it('offers a download instead of a frame for a type that cannot be previewed', async () => {
        installProbe({ contentType: 'application/zip' });
        open({ title: 'Archive', fileName: 'bundle.zip' });

        expect(await screen.findByText(/Preview isn’t available/i)).toBeTruthy();
        expect(screen.queryByTitle(/^Preview of/)).toBeNull();
        const link = screen.getByText('Download file') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/api/business/documents/12/download');
    });

    it('explains a deleted document rather than showing an empty frame', async () => {
        installProbe({ status: 404 });
        open();

        expect(await screen.findByText(/no longer in the vault/i)).toBeTruthy();
        expect(screen.queryByTitle(/^Preview of/)).toBeNull();
    });

    it('falls back to the caller-supplied file name when the probe fails', async () => {
        installProbe('network-error');
        open();

        const frame = await screen.findByTitle('Preview of Homeowners policy');
        expect(frame.tagName).toBe('IFRAME');
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
