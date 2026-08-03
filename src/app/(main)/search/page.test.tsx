import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SearchPage, { SEARCH_GROUP_ORDER } from './page';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('document search page', () => {
  it('orders canonical documents after transactions and advertises every source', () => {
    render(<SearchPage />);
    expect(SEARCH_GROUP_ORDER.map((group) => group.key)).toEqual([
      'transactions', 'documents', 'receipts', 'statements', 'payslips',
    ]);
    expect(screen.getByPlaceholderText(
      'Search documents, receipts, statements, payslips, transactions…',
    )).toBeInTheDocument();
    expect(screen.getByText(/Search vault documents/)).toBeInTheDocument();
  });

  it('states that hits are active-book only and points cross-book search at the Family Office', () => {
    render(<SearchPage />);
    expect(screen.getByText(/Results are limited to the active book/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Search every authorized book/ }))
      .toHaveAttribute('href', '/family-office');
  });

  it('renders canonical result count/group and the zero-hit empty state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: 'policy',
        transactions: [],
        documents: [{
          group: 'documents', id: '8', title: 'Umbrella policy', date: null,
          snippet: { text: 'Umbrella policy', highlightStart: 0, highlightEnd: 8 },
          href: '/business/documents', meta: 'Document',
        }],
        receipts: [], statements: [], payslips: [], totalHits: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: 'missing', transactions: [], documents: [], receipts: [],
        statements: [], payslips: [], totalHits: 0,
      }), { status: 200 }));

    render(<SearchPage />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'policy' } });
    await waitFor(() => expect(screen.getByText('Documents')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Documents\s+1/ })).toBeInTheDocument();
    expect(screen.getByText('Umbrella policy')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
