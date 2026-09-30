import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityYearStatusNotice } from '../EntityYearStatusNotice';
import type { EntityStatusRow } from '@/lib/entity-status';

function row(partial: Partial<EntityStatusRow> & { effectiveFrom: string }): EntityStatusRow {
  return {
    id: 1,
    legalForm: 'llc_single_member',
    taxClassification: 'disregarded',
    electionForm: null,
    electionFiledOn: null,
    electionAcceptedOn: null,
    shortYearConfirmed: false,
    electionDocumentId: null,
    acceptanceDocumentId: null,
    notes: null,
    ...partial,
  };
}

const LLC = row({ effectiveFrom: '1900-01-01' });
const S_CORP = row({ id: 2, effectiveFrom: '2027-01-01', taxClassification: 's_corp' });

function mockStatus(taxYear: object, current: EntityStatusRow) {
  vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ current, taxYear }), { status: 200 }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EntityYearStatusNotice', () => {
  it('renders nothing when the year matches today', async () => {
    mockStatus({ year: 2026, status: LLC, segments: [], mixed: false, entityType: 'llc_single' }, LLC);
    const { container } = render(<EntityYearStatusNotice year={2026} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/entity/status?year=2026'));
    expect(container).toBeEmptyDOMElement();
  });

  it('explains that a past year used a different status', async () => {
    mockStatus({ year: 2026, status: LLC, segments: [], mixed: false, entityType: 'llc_single' }, S_CORP);
    render(<EntityYearStatusNotice year={2026} />);
    expect(await screen.findByText(/For tax year 2026 this entity is/)).toBeInTheDocument();
    expect(screen.getByText('Single-member LLC, disregarded (Schedule C/F)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tax status history' })).toHaveAttribute(
      'href',
      '/settings#entity-status',
    );
  });

  it('warns about short tax years for a mid-year change', async () => {
    const mid = row({ id: 3, effectiveFrom: '2027-07-01', taxClassification: 'c_corp' });
    mockStatus(
      {
        year: 2027,
        status: mid,
        segments: [
          { from: '2027-01-01', to: '2027-06-30', row: LLC },
          { from: '2027-07-01', to: '2027-12-31', row: mid },
        ],
        mixed: true,
        entityType: 'c_corp',
      },
      mid,
    );
    render(<EntityYearStatusNotice year={2027} />);
    expect(await screen.findByText(/changes during 2027/)).toBeInTheDocument();
    expect(screen.getByText(/short tax years may need/)).toBeInTheDocument();
  });
});
