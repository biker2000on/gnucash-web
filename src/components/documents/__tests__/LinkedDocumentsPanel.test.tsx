import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LinkedDocumentsPanel } from '@/components/documents/LinkedDocumentsPanel';

const currentUser = vi.hoisted(() => ({ isReadonly: false }));

vi.mock('@/hooks/useCurrentUser', () => ({
    useCurrentUser: () => ({ user: null, loading: false, isReadonly: currentUser.isReadonly }),
}));

const ROLES = [
    { value: 'lease', label: 'Lease' },
    { value: 'tenant_notice', label: 'Tenant notice' },
] as const;

const canonicalDocument = {
    id: 55,
    title: 'Uploaded lease',
    filename: 'lease.pdf',
    mimeType: 'application/pdf',
    sourceKind: 'entity_document',
    sourceId: '91',
    extractionStatus: 'completed',
};

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

beforeEach(() => {
    currentUser.isReadonly = false;
    vi.clearAllMocks();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('LinkedDocumentsPanel', () => {
    it('renders enriched linked metadata and the source preview action', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.startsWith('/api/documents/links?')) {
                return jsonResponse({
                    links: [{
                        link: { id: 7, documentId: 55, targetType: 'rental_unit', targetId: 'unit-1', role: 'lease' },
                        document: canonicalDocument,
                    }],
                });
            }
            return jsonResponse({ documents: [canonicalDocument] });
        }));

        render(<LinkedDocumentsPanel targetType="rental_unit" targetId="unit-1" roles={ROLES} />);

        expect(await screen.findByText('Uploaded lease')).toBeTruthy();
        expect(screen.getByText(/Lease · Document vault · Text ready/)).toBeTruthy();
        const open = screen.getByRole('link', { name: 'Open' });
        expect(open.getAttribute('href')).toBe('/api/business/documents/91/download?disposition=inline');
    });

    it('shows linked evidence but hides every mutation for readonly users', async () => {
        currentUser.isReadonly = true;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).startsWith('/api/documents/links?')) {
                return jsonResponse({
                    links: [{
                        link: { id: 7, documentId: 55, targetType: 'rental_unit', targetId: 'unit-1', role: 'lease' },
                        document: canonicalDocument,
                    }],
                });
            }
            return jsonResponse({ documents: [canonicalDocument] });
        }));

        render(<LinkedDocumentsPanel targetType="rental_unit" targetId="unit-1" roles={ROLES} />);
        expect(await screen.findByText('Uploaded lease')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Upload and attach' })).toBeNull();
        expect(screen.queryByLabelText('Upload a supporting document')).toBeNull();
    });

    it('uploads to the shared vault, attaches the canonical ID, and refreshes links', async () => {
        let attached = false;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === '/api/business/documents' && init?.method === 'POST') {
                return jsonResponse({ document: { id: 91, canonicalDocumentId: 55 } }, 201);
            }
            if (url === '/api/documents/links' && init?.method === 'POST') {
                attached = true;
                return jsonResponse({ link: { id: 7 } }, 201);
            }
            if (url.startsWith('/api/documents/links?')) {
                return jsonResponse({
                    links: attached ? [{
                        link: { id: 7, documentId: 55, targetType: 'rental_unit', targetId: 'unit-1', role: 'lease' },
                        document: canonicalDocument,
                    }] : [],
                });
            }
            if (url.startsWith('/api/documents')) {
                return jsonResponse({ documents: attached ? [canonicalDocument] : [], hasMore: false, nextOffset: null });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<LinkedDocumentsPanel targetType="rental_unit" targetId="unit-1" roles={ROLES} />);
        await screen.findByText('No supporting documents linked.');

        const file = new File(['pdf'], 'lease.pdf', { type: 'application/pdf' });
        fireEvent.change(screen.getByLabelText('Upload a supporting document'), { target: { files: [file] } });
        fireEvent.click(screen.getByRole('button', { name: 'Upload and attach' }));

        expect(await screen.findByText('Uploaded lease')).toBeTruthy();
        const attachRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST' && String(init.body).includes('documentId'));
        expect(attachRequest).toBeTruthy();
        expect(JSON.parse(String(attachRequest?.[1]?.body))).toEqual({
            documentId: 55,
            targetType: 'rental_unit',
            targetId: 'unit-1',
            role: 'lease',
        });
        await waitFor(() => expect(
            fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/documents?limit=25')),
        ).toBe(true));
    });

    it('searches the vault server-side, debounces, and abandons superseded requests', async () => {
        const vaultCalls: string[] = [];
        const aborted: boolean[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith('/api/documents/links?')) return jsonResponse({ links: [] });
            if (url.startsWith('/api/documents?')) {
                vaultCalls.push(url);
                aborted.push(init?.signal?.aborted ?? false);
                return jsonResponse({ documents: [], hasMore: false, nextOffset: null });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<LinkedDocumentsPanel targetType="rental_unit" targetId="unit-1" roles={ROLES} />);
        await screen.findByText('No supporting documents linked.');
        await waitFor(() => expect(vaultCalls).toHaveLength(1));

        const searchBox = screen.getByRole('searchbox', { name: 'Search the document vault' });
        fireEvent.change(searchBox, { target: { value: 'de' } });
        fireEvent.change(searchBox, { target: { value: 'dee' } });
        fireEvent.change(searchBox, { target: { value: 'deed' } });

        await waitFor(() => expect(vaultCalls).toHaveLength(2));
        expect(vaultCalls[1]).toBe('/api/documents?limit=25&q=deed');
        // Every intermediate keystroke was debounced away, so no stale page can land.
        expect(vaultCalls.filter(url => url.includes('q=de&') || url.endsWith('q=de'))).toHaveLength(0);
        expect(aborted).toEqual([false, false]);
    });

    it('pages past the first result set instead of stopping at one page', async () => {
        const vaultCalls: string[] = [];
        const page = (offset: number) => ({
            documents: [{ ...canonicalDocument, id: 100 + offset, title: `Doc ${offset}` }],
            hasMore: offset === 0,
            nextOffset: offset === 0 ? 25 : null,
        });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.startsWith('/api/documents/links?')) return jsonResponse({ links: [] });
            if (url.startsWith('/api/documents?')) {
                vaultCalls.push(url);
                return jsonResponse(page(url.includes('offset=25') ? 25 : 0));
            }
            throw new Error(`Unexpected request: ${url}`);
        }));

        render(<LinkedDocumentsPanel targetType="rental_unit" targetId="unit-1" roles={ROLES} />);
        const loadMore = await screen.findByRole('button', { name: 'Load more results' });
        fireEvent.click(loadMore);

        await waitFor(() => expect(vaultCalls).toContain('/api/documents?limit=25&offset=25'));
        expect(await screen.findByRole('option', { name: /Doc 25/ })).toBeTruthy();
        expect(screen.getByRole('option', { name: /Doc 0/ })).toBeTruthy();
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull());
    });
});
