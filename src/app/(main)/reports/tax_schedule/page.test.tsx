import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TaxSchedulePage from './page';

const report = {
  year: 2025,
  generatedAt: '2026-01-01T00:00:00Z',
  items: [{ code: 'N684', form: 'Schedule D', line: 'Part I', description: 'Short-term gain', sign: 'income', payerSupported: false, accounts: [], total: 8400 }],
  unmappedTaxRelated: [],
  overrides: {},
};

afterEach(() => vi.unstubAllGlobals());

describe('Tax Schedule page', () => {
  it('renders the current API payload without capital-gains integration fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => report })));
    render(<TaxSchedulePage />);
    await waitFor(() => expect(screen.getByText('Short-term gain')).toBeInTheDocument());
    expect(screen.getByText('$8,400.00')).toBeInTheDocument();
  });

  it('shows a download error when the TXF request fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => report })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Export unavailable' }) });
    vi.stubGlobal('fetch', fetch);
    render(<TaxSchedulePage />);
    await waitFor(() => expect(screen.getByText('Short-term gain')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Download .txf' }));
    await waitFor(() => expect(screen.getByText('TXF download failed')).toBeInTheDocument());
  });
});
