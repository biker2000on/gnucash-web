import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityDocument } from '@/lib/services/entity-documents.service';
import EntityDocumentsPage from './page';

const toast = {
  success: vi.fn(),
  error: vi.fn(),
};

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => toast,
}));

interface TestDocumentsResponse {
  documents: EntityDocument[];
  expiringSoon: EntityDocument[];
  warningDays: number;
}

const emptyDocuments: TestDocumentsResponse = {
  documents: [],
  expiringSoon: [],
  warningDays: 60,
};

function installFetch(
  entity:
    | {
        entityType: string;
        entityName?: string | null;
        businessActivity?: string;
      }
    | 'error',
  documents: TestDocumentsResponse = emptyDocuments
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/entity') {
        return {
          ok: entity !== 'error',
          status: entity === 'error' ? 500 : 200,
          json: async () => (entity === 'error' ? { error: 'failed' } : entity),
        } as Response;
      }
      if (url === '/api/business/documents') {
        return {
          ok: true,
          status: 200,
          json: async () => documents,
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EntityDocumentsPage entity context', () => {
  it('shows household copy and removes business-only upload types', async () => {
    installFetch({ entityType: 'household', businessActivity: 'general' });
    render(<EntityDocumentsPage />);

    await screen.findByRole('heading', { name: 'Household Documents' });
    const typeSelect = screen.getByRole('combobox');

    expect(screen.getByPlaceholderText('e.g. Home insurance declaration')).toBeInTheDocument();
    expect(within(typeSelect).getByRole('option', { name: 'Identity records' })).toBeInTheDocument();
    for (const name of [
      'Formation documents',
      'EIN letters',
      'Tax elections',
      'E-595QF certificates',
      'E-595CF certificates',
    ]) {
      expect(within(typeSelect).queryByRole('option', { name })).not.toBeInTheDocument();
    }
  });

  it('shows S-Corp election guidance and relevant upload choices', async () => {
    installFetch({
      entityType: 's_corp',
      entityName: 'Blue Ridge Holdings',
      businessActivity: 'general',
    });
    render(<EntityDocumentsPage />);

    await screen.findByRole('heading', { name: 'S-Corp Documents' });
    const typeSelect = screen.getByRole('combobox');

    expect(screen.getByText(/Blue Ridge Holdings:/)).toHaveTextContent(/formation, election/i);
    expect(screen.getByPlaceholderText('e.g. Form 2553 acceptance letter')).toBeInTheDocument();
    expect(within(typeSelect).getByRole('option', { name: 'Tax elections' })).toBeInTheDocument();
    expect(screen.getByText('Form 2553 and IRS acceptance')).toBeInTheDocument();
  });

  it('emphasizes nonprofit determination, governance, tax, and insurance records', async () => {
    installFetch({
      entityType: 'nonprofit_501c3',
      entityName: 'Community Pantry',
      businessActivity: 'general',
    });
    render(<EntityDocumentsPage />);

    await screen.findByRole('heading', { name: 'Nonprofit Documents' });
    const typeSelect = screen.getByRole('combobox');

    expect(screen.getByText(/Community Pantry:/)).toHaveTextContent(/IRS determination/i);
    expect(screen.getByText('Form 990 and related tax filings')).toBeInTheDocument();
    expect(within(typeSelect).getByRole('option', { name: 'Governance' })).toBeInTheDocument();
    expect(within(typeSelect).getByRole('option', { name: 'IRS determination' })).toBeInTheDocument();
    expect(within(typeSelect).getByRole('option', { name: 'Insurance' })).toBeInTheDocument();
  });

  it('keeps documents visible under neutral copy when the entity request fails', async () => {
    installFetch('error', {
      documents: [
        {
          id: 9,
          title: 'Legacy articles',
          docType: 'formation',
          fileName: 'articles.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          expiresOn: null,
          issuedOn: null,
          returnCopyDueOn: null,
          notes: null,
          uploadedAt: '2026-07-30T00:00:00.000Z',
          daysUntilExpiry: null,
        },
      ],
      expiringSoon: [],
      warningDays: 60,
    });
    render(<EntityDocumentsPage />);

    await screen.findByText('Legacy articles');
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByText('Other document types')).toBeInTheDocument();
    expect(screen.queryByText(/failed to load documents/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/entity');
      expect(fetch).toHaveBeenCalledWith('/api/business/documents');
    });
  });
});
