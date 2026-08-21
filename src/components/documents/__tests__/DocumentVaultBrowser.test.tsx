import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
    DocumentVaultBrowser,
    type VaultDocumentRow,
} from '../DocumentVaultBrowser';

const documents: VaultDocumentRow[] = [
    {
        id: 1,
        title: 'Home policy',
        docType: 'insurance',
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        expiresOn: '2027-01-31',
        issuedOn: '2026-02-01',
        returnCopyDueOn: null,
        notes: 'Renewal packet from the broker',
        taxYear: null,
        taxForm: null,
        issuer: 'Harbor Mutual',
        uploadedAt: '2026-02-01T00:00:00.000Z',
        daysUntilExpiry: 120,
        canonicalDocumentId: 81,
        tags: ['renewal'],
        thumbnailStatus: 'complete',
    },
    {
        id: 2,
        title: 'Fidelity 1099',
        docType: 'tax',
        fileName: '1099.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        expiresOn: null,
        issuedOn: '2026-01-20',
        returnCopyDueOn: null,
        notes: null,
        taxYear: 2025,
        taxForm: '1099_div',
        issuer: 'Fidelity',
        uploadedAt: '2026-01-20T00:00:00.000Z',
        daysUntilExpiry: null,
        canonicalDocumentId: 82,
        tags: ['tax'],
        thumbnailStatus: 'pending',
    },
];

const categoryOptions = [
    { value: 'insurance', label: 'Insurance' },
    { value: 'tax', label: 'Tax records' },
];

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
}

function webpResponse(): Response {
    return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/webp' },
    });
}

interface FetchOptions {
    tags?: boolean;
    search?: boolean;
    searchBody?: unknown;
}

function installFetch(options?: FetchOptions) {
    const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/thumbnail')) return webpResponse();
        if (url === '/api/business/documents/tags') {
            return options?.tags
                ? jsonResponse({ tags: [{ name: 'tax', count: 1 }, { name: 'renewal', count: 1 }] })
                : new Response(null, { status: 404 });
        }
        if (url === '/api/business/documents/1/tags') return jsonResponse({ tags: ['renewal'] });
        if (url === '/api/business/documents/2/tags') {
            if (init?.method === 'PUT') return jsonResponse(JSON.parse(String(init.body)));
            return jsonResponse({ tags: ['tax'] });
        }
        if (url.startsWith('/api/search/documents?') && options?.search) {
            return jsonResponse(options.searchBody ?? {
                query: 'income',
                documents: [
                    {
                        group: 'documents',
                        id: '81',
                        sourceKind: 'entity_document',
                        sourceId: '1',
                        title: 'Home policy',
                        date: '2026-02-01',
                        snippet: { text: 'No income wording', highlightStart: 3, highlightEnd: 9 },
                        href: '/business/documents',
                    },
                    {
                        group: 'documents',
                        id: '82',
                        sourceKind: 'entity_document',
                        sourceId: '2',
                        title: 'Fidelity 1099',
                        date: '2026-01-20',
                        snippet: { text: 'Dividend income', highlightStart: 9, highlightEnd: 15 },
                        href: '/business/documents',
                    },
                ],
                receipts: [],
                statements: [],
                payslips: [],
                transactions: [],
                totalHits: 2,
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', handler);
    return handler;
}

function renderBrowser(rows: VaultDocumentRow[] = documents) {
    return render(
        <DocumentVaultBrowser
            documents={rows}
            categoryOptions={categoryOptions}
            onPreview={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onRequestDelete={vi.fn()}
        />
    );
}

function urlsOf(handler: ReturnType<typeof installFetch>): string[] {
    return handler.mock.calls.map(([input]) => String(input));
}

beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

describe('DocumentVaultBrowser', () => {
    it('renders cards and toggles the same documents into the sortable table', async () => {
        installFetch();
        renderBrowser();

        expect(screen.getByTestId('document-card-view')).toBeInTheDocument();
        expect(screen.getByText('Home policy')).toBeInTheDocument();
        expect(screen.getByText('Fidelity 1099')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /table/i }));
        const table = screen.getByRole('table');
        for (const heading of ['Title', 'Category', 'Issuer', 'Issued', 'Expires', 'Size', 'Type']) {
            expect(within(table).getByRole('columnheader', { name: new RegExp(`^${heading}`) })).toBeInTheDocument();
        }
        expect(within(table).getByText('Home policy')).toBeInTheDocument();
        expect(within(table).getByText('Fidelity 1099')).toBeInTheDocument();
    });

    it('restores and persists view, grouping, sorting, and card expansion preferences', async () => {
        window.localStorage.setItem('documentVault.browser.v2', JSON.stringify({
            viewMode: 'table',
            grouping: 'issuer',
            sorting: [{ id: 'issuer', desc: true }],
            cardExpanded: { Fidelity: false },
        }));
        installFetch();
        renderBrowser();

        await waitFor(() => expect(screen.getByTestId('document-table-view')).toBeInTheDocument());
        expect(screen.getByLabelText('Group by')).toHaveValue('issuer');
        fireEvent.click(screen.getByRole('button', { name: /cards/i }));
        fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'none' } });

        await waitFor(() => {
            const stored = JSON.parse(window.localStorage.getItem('documentVault.browser.v2') ?? '{}');
            expect(stored.viewMode).toBe('cards');
            expect(stored.grouping).toBe('none');
            expect(stored.sorting).toEqual([{ id: 'issuer', desc: true }]);
            expect(stored.cardExpanded).toEqual({ Fidelity: false });
        });
    });

    it('ignores malformed persisted state instead of feeding it to the table', async () => {
        window.localStorage.setItem('documentVault.browser.v2', JSON.stringify({
            viewMode: 'grid',
            grouping: 'colour',
            sorting: 'nope',
            tableExpanded: ['not', 'a', 'record'],
        }));
        installFetch();
        renderBrowser();

        await waitFor(() => expect(screen.getByTestId('document-card-view')).toBeInTheDocument());
        expect(screen.getByLabelText('Group by')).toHaveValue('category');
    });

    // HIGH-A
    it('keeps card collapse out of the table expansion state', async () => {
        installFetch();
        renderBrowser();

        // Collapse the "Insurance" card group.
        const cardGroupToggle = screen.getByRole('button', { name: /Insurance/ });
        fireEvent.click(cardGroupToggle);
        expect(cardGroupToggle).toHaveAttribute('aria-expanded', 'false');

        // The table's groups are still expanded and still render their rows.
        fireEvent.click(screen.getByRole('button', { name: /table/i }));
        const table = screen.getByRole('table');
        expect(within(table).getByText('Home policy')).toBeInTheDocument();
        expect(within(table).getByText('Fidelity 1099')).toBeInTheDocument();

        // And collapsing a table group leaves the card groups alone.
        const tableGroupToggle = within(table).getAllByRole('button', { expanded: true })[0];
        fireEvent.click(tableGroupToggle);
        fireEvent.click(screen.getByRole('button', { name: /cards/i }));
        const taxGroup = screen.getByRole('button', { name: /Tax records/ });
        expect(taxGroup).toHaveAttribute('aria-expanded', 'true');
    });

    // HIGH-B
    it('warns about prior-year missing tax forms under category grouping and in table view', async () => {
        const withHistory: VaultDocumentRow[] = [
            ...documents,
            {
                ...documents[1],
                id: 3,
                canonicalDocumentId: 83,
                title: 'Ally 1099-INT 2024',
                taxYear: 2024,
                taxForm: '1099_int',
                issuer: 'Ally Bank',
                tags: [],
            },
            {
                ...documents[1],
                id: 4,
                canonicalDocumentId: 84,
                title: 'Fidelity 1099-DIV 2024',
                taxYear: 2024,
                taxForm: '1099_div',
                issuer: 'Fidelity',
                tags: [],
            },
        ];
        installFetch();
        renderBrowser(withHistory);

        // Default grouping is "category" — the warning must still appear.
        expect(screen.getByLabelText('Group by')).toHaveValue('category');
        expect(screen.getByTestId('missing-tax-forms')).toHaveTextContent(/Missing vs 2024/);
        expect(screen.getByTestId('missing-tax-forms')).toHaveTextContent(/Ally Bank/);

        fireEvent.click(screen.getByRole('button', { name: /table/i }));
        expect(screen.getByTestId('missing-tax-forms')).toHaveTextContent(/Missing vs 2024/);
    });

    // CODEX-2
    it('seeds tags from the list response and issues no per-document tag requests', async () => {
        const handler = installFetch({ tags: true });
        renderBrowser();

        await waitFor(() => expect(screen.getAllByRole('button', { name: 'Edit tags' }).length).toBe(2));
        // Chips render straight from the sidecar.
        expect(screen.getAllByText('renewal').length).toBeGreaterThan(0);
        expect(screen.getAllByText('tax').length).toBeGreaterThan(0);

        const perDocumentTagCalls = urlsOf(handler).filter((url) =>
            /\/api\/business\/documents\/\d+\/tags$/.test(url));
        expect(perDocumentTagCalls).toEqual([]);
    });

    // CODEX-2 / MED
    it('fetches a thumbnail only for complete rows and shows a terminal failed state', async () => {
        // Thumbnails are additionally gated on viewport proximity; simulate an
        // observer that immediately reports every card as visible.
        vi.stubGlobal('IntersectionObserver', class {
            constructor(private cb: IntersectionObserverCallback) {}
            observe() { this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
            disconnect() {}
            unobserve() {}
            takeRecords() { return []; }
        });
        const handler = installFetch();
        renderBrowser([
            documents[0],
            documents[1],
            { ...documents[1], id: 5, canonicalDocumentId: 85, title: 'Broken scan', thumbnailStatus: 'failed' },
        ]);

        await waitFor(() => {
            const thumbCalls = urlsOf(handler).filter((url) => url.endsWith('/thumbnail'));
            expect(thumbCalls).toEqual(['/api/business/documents/1/thumbnail']);
        });
        // pending -> "Preview pending"; failed -> distinct "No preview".
        expect(screen.getByTestId('thumbnail-placeholder-2')).toBeInTheDocument();
        expect(screen.getByTestId('thumbnail-failed-5')).toBeInTheDocument();
        expect(screen.queryByTestId('thumbnail-placeholder-5')).not.toBeInTheDocument();
    });

    // CODEX-1
    it('resolves a search hit by sourceId even when a canonical id collides with another document id', async () => {
        /*
         * The trap: "Decoy" is listed FIRST and its CANONICAL id (1) equals the
         * ENTITY id of "Real target". A resolver that ORs the two key spaces
         * together (`c.id === sourceId || c.canonicalDocumentId === hit.id`)
         * hits Decoy first and attributes the snippet — and any action the UI
         * offers on the hit — to the wrong file.
         */
        const colliding: VaultDocumentRow[] = [
            { ...documents[0], id: 7, canonicalDocumentId: 1, title: 'Decoy', tags: [], thumbnailStatus: 'pending' },
            { ...documents[0], id: 1, canonicalDocumentId: 99, title: 'Real target', tags: [], thumbnailStatus: 'pending' },
        ];
        installFetch({
            search: true,
            searchBody: {
                query: 'income',
                documents: [
                    {
                        group: 'documents',
                        id: '1',            // canonical id — collides with Decoy's canonicalDocumentId
                        sourceKind: 'entity_document',
                        sourceId: '1',      // authoritative: entity document 1 = "Real target"
                        title: 'Decoy',     // and the title points the wrong way too
                        date: '2026-02-01',
                        snippet: { text: 'income marker', highlightStart: 0, highlightEnd: 6 },
                        href: '/business/documents',
                    },
                ],
                receipts: [], statements: [], payslips: [], transactions: [], totalHits: 1,
            },
        });
        renderBrowser(colliding);

        fireEvent.change(screen.getByLabelText('Search document text'), { target: { value: 'income' } });

        await waitFor(() => expect(screen.getByText('1 document')).toBeInTheDocument());
        expect(screen.getByText('Real target')).toBeInTheDocument();
        expect(screen.queryByText('Decoy')).not.toBeInTheDocument();
    });

    it('composes full-text search, category, and tag filters across both views', async () => {
        installFetch({ tags: true, search: true });
        renderBrowser();

        fireEvent.change(screen.getByLabelText('Search document text'), { target: { value: 'income' } });
        await waitFor(() => expect(screen.getAllByText('income').length).toBeGreaterThan(0));
        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'tax' } });
        fireEvent.click(await screen.findByRole('button', { name: 'tax 1' }));

        expect(screen.getByText('Fidelity 1099')).toBeInTheDocument();
        expect(screen.queryByText('Home policy')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /table/i }));
        expect(within(screen.getByRole('table')).getByText('Fidelity 1099')).toBeInTheDocument();
        expect(within(screen.getByRole('table')).queryByText('Home policy')).not.toBeInTheDocument();
    });

    it('reviews and replaces tags through the ordinary PUT endpoint, then refreshes the vocabulary', async () => {
        const handler = installFetch({ tags: true });
        renderBrowser();

        const editors = await screen.findAllByRole('button', { name: 'Edit tags' });
        fireEvent.click(editors[1]);
        const dialog = screen.getByRole('dialog', { name: 'Edit tags for Fidelity 1099' });
        fireEvent.change(within(dialog).getByLabelText('Tags, separated by commas'), {
            target: { value: 'tax, reviewed' },
        });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save tags' }));

        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith('/api/business/documents/2/tags', expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ tags: ['reviewed', 'tax'] }),
            }));
        });
        // Vocabulary re-read (initial load + post-save) so new chips/counts show.
        await waitFor(() => {
            const vocabCalls = urlsOf(handler).filter((url) => url === '/api/business/documents/tags');
            expect(vocabCalls.length).toBeGreaterThanOrEqual(2);
        });
    });

    it('closes the tag editor on Escape and returns focus to its trigger', async () => {
        installFetch({ tags: true });
        renderBrowser();

        const editors = await screen.findAllByRole('button', { name: 'Edit tags' });
        fireEvent.click(editors[0]);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.keyDown(window.document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(editors[0]).toHaveFocus();
    });

    it('shows the relative expiry pill and file/notes metadata', async () => {
        installFetch();
        renderBrowser();

        expect(screen.getByText('Expires in 120d')).toBeInTheDocument();
        expect(screen.getByText('policy.pdf')).toBeInTheDocument();
        expect(screen.getByText('Renewal packet from the broker')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /table/i }));
        const table = screen.getByRole('table');
        expect(within(table).getByRole('columnheader', { name: /^File/ })).toBeInTheDocument();
        expect(within(table).getByText('policy.pdf')).toBeInTheDocument();
    });
});
