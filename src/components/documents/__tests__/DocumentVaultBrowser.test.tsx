import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityDocument } from '@/lib/services/entity-documents.service';
import { DocumentVaultBrowser } from '../DocumentVaultBrowser';

const documents: EntityDocument[] = [
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
        notes: null,
        taxYear: null,
        taxForm: null,
        issuer: 'Harbor Mutual',
        uploadedAt: '2026-02-01T00:00:00.000Z',
        daysUntilExpiry: 120,
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

function installFetch(options?: { tags?: boolean; search?: boolean }) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/thumbnail')) return new Response(null, { status: 404 });
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
            return jsonResponse({
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
    }));
}

function renderBrowser() {
    return render(
        <DocumentVaultBrowser
            documents={documents}
            categoryOptions={categoryOptions}
            onPreview={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onRequestDelete={vi.fn()}
        />
    );
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
    it('renders placeholder cards and toggles the same documents into the sortable table', async () => {
        installFetch();
        renderBrowser();

        expect(screen.getByTestId('document-card-view')).toBeInTheDocument();
        expect(screen.getByTestId('thumbnail-placeholder-1')).toBeInTheDocument();
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

    it('restores and persists view, grouping, sorting, and expansion preferences', async () => {
        window.localStorage.setItem('documentVault.browser.v1', JSON.stringify({
            viewMode: 'table',
            grouping: 'issuer',
            sorting: [{ id: 'issuer', desc: true }],
            expanded: { 'issuerGroup:Fidelity': false },
        }));
        installFetch();
        renderBrowser();

        expect(screen.getByTestId('document-table-view')).toBeInTheDocument();
        expect(screen.getByLabelText('Group by')).toHaveValue('issuer');
        fireEvent.click(screen.getByRole('button', { name: /cards/i }));
        fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'none' } });

        await waitFor(() => {
            const stored = JSON.parse(window.localStorage.getItem('documentVault.browser.v1') ?? '{}');
            expect(stored.viewMode).toBe('cards');
            expect(stored.grouping).toBe('none');
            expect(stored.sorting).toEqual([{ id: 'issuer', desc: true }]);
            expect(stored.expanded).toEqual({ 'issuerGroup:Fidelity': false });
        });
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

    it('reviews and replaces tags through the ordinary PUT endpoint', async () => {
        installFetch({ tags: true });
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
    });
});
