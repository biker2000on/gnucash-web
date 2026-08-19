import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import BookCreateForm, { BOOK_NAME_REQUIRED, validateBookName } from '../BookCreateForm';
import NewBookForm from '../NewBookForm';
import { CreateBookWizard } from '@/components/CreateBookWizard';
import { INPUT } from '@/components/ui/form';

/**
 * `NewBookForm` (POST /api/books/default) and the wizard's import step
 * (POST /api/books/from-template) used to carry two copies of the same name
 * field, the same "Please enter a book name" rule, and the same submit-state
 * spinner. Both now compose `BookCreateForm`; these tests pin the shared
 * behaviour and that each caller still reaches its own endpoint.
 */

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('validateBookName', () => {
    it('rejects an empty or whitespace-only name with the one shared message', () => {
        expect(validateBookName('')).toBe(BOOK_NAME_REQUIRED);
        expect(validateBookName('   ')).toBe(BOOK_NAME_REQUIRED);
    });

    it('accepts a name with content', () => {
        expect(validateBookName('  My Finances  ')).toBeNull();
    });
});

describe('BookCreateForm', () => {
    it('uses the shared INPUT recipe rather than a hand-rolled one', () => {
        render(<BookCreateForm onSubmit={vi.fn()} onError={vi.fn()} />);
        const input = screen.getByLabelText(/Book Name/);
        // DESIGN.md: form controls are radius md and come from ui/form.tsx's
        // INPUT. A fourth hand-rolled recipe (this one was rounded-lg with its
        // own focus ring) is exactly what the shared constant exists to stop.
        expect(input.className).toContain(INPUT);
        expect(input.className).not.toContain('rounded-lg');
    });

    it('keeps submit disabled until the name has content, then submits it trimmed', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(<BookCreateForm onSubmit={onSubmit} onError={vi.fn()} />);

        const submit = screen.getByRole('button', { name: 'Create Book' });
        expect(submit).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/Book Name/), { target: { value: '  My Finances  ' } });
        expect(submit).toBeEnabled();

        fireEvent.click(submit);
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith({ name: 'My Finances', currency: 'USD' })
        );
    });

    it('clears the previous error, shows the busy state, and reports a failure', async () => {
        let release: () => void = () => {};
        const onSubmit = vi.fn().mockImplementation(
            () => new Promise((_resolve, reject) => { release = () => reject(new Error('Book name already in use')); })
        );
        const onError = vi.fn();
        render(<BookCreateForm onSubmit={onSubmit} onError={onError} />);

        fireEvent.change(screen.getByLabelText(/Book Name/), { target: { value: 'Ledger' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Book' }));

        await screen.findByText('Creating...');
        expect(onError).toHaveBeenCalledWith(null);
        expect(screen.getByRole('button', { name: /Creating/ })).toBeDisabled();

        release();
        await waitFor(() => expect(onError).toHaveBeenCalledWith('Book name already in use'));
        await waitFor(() => expect(screen.queryByText('Creating...')).not.toBeInTheDocument());
    });

    it('hides the currency selector when the caller does not want one', () => {
        const { rerender } = render(<BookCreateForm onSubmit={vi.fn()} onError={vi.fn()} />);
        expect(screen.getByLabelText('Currency')).toBeInTheDocument();

        rerender(<BookCreateForm onSubmit={vi.fn()} onError={vi.fn()} showCurrency={false} />);
        expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
    });
});

describe('the two book-creation surfaces still reach their own endpoints', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ bookGuid: 'book-1', guid: 'book-1' }),
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);
    });

    it('NewBookForm posts to /api/books/default with the entity selection', async () => {
        const onSuccess = vi.fn();
        render(<NewBookForm onSuccess={onSuccess} />);

        fireEvent.change(screen.getByLabelText(/Book Name/), { target: { value: 'Household' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Book' }));

        await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('book-1'));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/books/default');
        expect(JSON.parse(init.body)).toMatchObject({
            name: 'Household',
            currency: 'USD',
            entityType: 'household',
        });
    });

    it("the wizard's import step posts to /api/books/from-template", async () => {
        const onBookCreated = vi.fn();
        render(<CreateBookWizard onBookCreated={onBookCreated} />);

        fireEvent.click(screen.getByRole('button', { name: /Import from GnuCash/i }));
        fireEvent.change(screen.getByLabelText(/Book Name/), { target: { value: 'Imported' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Book' }));

        await waitFor(() => expect(onBookCreated).toHaveBeenCalledWith('book-1'));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/books/from-template');
        expect(JSON.parse(init.body)).toEqual({ name: 'Imported', currency: 'USD' });
    });

    it('the wizard announces a failed import-step creation through its hoisted live region', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            json: async () => ({ error: 'A book with that name already exists' }),
        } as unknown as Response);
        render(<CreateBookWizard onBookCreated={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Import from GnuCash/i }));
        const liveRegion = screen.getByRole('alert');
        fireEvent.change(screen.getByLabelText(/Book Name/), { target: { value: 'Imported' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Book' }));

        await waitFor(() =>
            expect(liveRegion).toHaveTextContent('A book with that name already exists')
        );
    });
});
