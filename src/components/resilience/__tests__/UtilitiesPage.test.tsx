import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UtilitiesPlannerPage } from '../UtilitiesPage';
import type { UtilityBill } from '@/lib/resilience/types';

const { toastMock, searchParamsMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  searchParamsMock: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
}));
vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => toastMock,
}));
// The drop zone drives the receipt upload pipeline, which is out of scope for
// the review-queue behavior under test.
vi.mock('@/components/ui/FileDropZone', () => ({
  FileDropZone: () => <div data-testid="dropzone" />,
}));
vi.mock('@/components/receipts/ReceiptUploadZone', () => ({
  receiptUploadOutcome: vi.fn(),
  uploadReceiptFile: vi.fn(),
}));

function bill(overrides: Partial<UtilityBill>): UtilityBill {
  return {
    id: 'bill-1',
    date: '2026-05-06',
    type: 'electric',
    provider: 'Duke Energy',
    usage: 1165,
    unit: 'kWh',
    totalCost: 167.12,
    periodStart: null,
    periodEnd: null,
    charges: [],
    transactionGuid: null,
    receiptId: null,
    ...overrides,
  };
}

const savedBill = bill({ id: 'existing-1', receiptId: 4 });
const freshSuggestion = bill({
  id: 'receipt-10-electric',
  date: '2026-06-06',
  periodStart: '2026-05-06',
  periodEnd: '2026-06-06',
  usage: 1200,
  totalCost: 180,
  receiptId: 10,
});
const gasSuggestion = bill({
  id: 'receipt-11-gas',
  date: '2026-06-10',
  type: 'gas',
  unit: 'therms',
  usage: 40,
  totalCost: 62.5,
  receiptId: 11,
});
// Same figures and date as the saved bill, from a different receipt: a
// re-upload of a bill that was already imported.
const duplicateSuggestion = bill({ id: 'receipt-12-electric', receiptId: 12 });

function sectionResponse(profileBills: UtilityBill[], suggestions: UtilityBill[]) {
  return {
    profile: {
      bills: profileBills,
      solar: { enabled: false, systemCost: 0, incentives: 0, annualProductionKwh: 0, degradationRate: 0.5, electricRateInflation: 3, annualMaintenance: 0, analysisYears: 25 },
    },
    analysis: { trailing12Cost: 0, byType: [] },
    solar: { upfrontCost: 0, paybackYear: null, lifetimeSavings: 0, currentElectricRate: 0 },
    suggestions,
  };
}

let lastPutBody: { profile: { bills: UtilityBill[] } } | null = null;

beforeEach(() => {
  lastPutBody = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      lastPutBody = JSON.parse(String(init.body));
      // The server recomputes and re-filters; imported receipts stop being
      // suggestions once saved.
      const savedIds = new Set(lastPutBody!.profile.bills.map(item => item.receiptId));
      return {
        ok: true,
        json: async () => ({
          ...sectionResponse(
            lastPutBody!.profile.bills,
            [freshSuggestion, gasSuggestion, duplicateSuggestion].filter(item => !savedIds.has(item.receiptId)),
          ),
          profile: lastPutBody!.profile,
        }),
      };
    }
    return {
      ok: true,
      json: async () => sectionResponse([savedBill], [freshSuggestion, gasSuggestion, duplicateSuggestion]),
    };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderPage() {
  render(<UtilitiesPlannerPage />);
  await waitFor(() => expect(screen.getByText('Utility bills')).toBeTruthy());
}

describe('utilities bill review queue', () => {
  it('shows each suggestion once with evidence link and flags likely duplicates', async () => {
    await renderPage();

    // Three suggestions in the queue; the re-upload carries a warning chip.
    expect(screen.getByText(/Select all without warnings \(2 of 3\)/)).toBeTruthy();
    expect(screen.getByText(/Possible duplicate — matches the 2026-05-06 electric bill/)).toBeTruthy();

    // Every suggestion links to its source receipt.
    const links = screen.getAllByRole('link', { name: 'View receipt' });
    const hrefs = links.map(link => link.getAttribute('href'));
    expect(hrefs).toContain('/api/receipts/10');
    expect(hrefs).toContain('/api/receipts/11');
    expect(hrefs).toContain('/api/receipts/12');
  });

  it('imports a single bill: the row leaves the queue and lands staged in the table', async () => {
    await renderPage();

    // The checkbox is a direct child of the row container.
    const row = screen.getByLabelText(/Select electric bill 2026-05-06 → 2026-06-06/).closest('div')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Import' }));

    // Instant feedback: queue shrinks, toast confirms, table row is marked staged.
    expect(toastMock.success).toHaveBeenCalledWith('Bill staged in the table below — Save to keep it');
    expect(screen.getByText(/Select all without warnings \(1 of 2\)/)).toBeTruthy();
    expect(screen.getByText('staged')).toBeTruthy();
    expect(screen.getByText(/1 imported bill staged — not saved yet/)).toBeTruthy();
  });

  it('bulk-imports every clean suggestion and leaves the flagged duplicate behind', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select all bills without warnings'));
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (2)' }));

    expect(toastMock.success).toHaveBeenCalledWith('2 bills staged in the table below — Save to keep them');
    // Only the duplicate remains reviewable.
    expect(screen.getByText(/Select all without warnings \(0 of 1\)/)).toBeTruthy();
    expect(screen.getAllByText('staged')).toHaveLength(2);
  });

  it('undo returns staged bills to the queue', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select all bills without warnings'));
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo staged imports (2)' }));

    expect(toastMock.info).toHaveBeenCalledWith('2 staged bills returned to the review queue');
    expect(screen.getByText(/Select all without warnings \(2 of 3\)/)).toBeTruthy();
    expect(screen.queryByText('staged')).toBeNull();
  });

  it('save persists the staged bills and clears the staged state', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select all bills without warnings'));
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(lastPutBody).not.toBeNull());
    const savedReceiptIds = lastPutBody!.profile.bills.map(item => item.receiptId);
    expect(savedReceiptIds).toEqual([4, 10, 11]);
    // Once saved, rows stop being "staged" — they are ordinary bills now.
    await waitFor(() => expect(screen.queryByText('staged')).toBeNull());
  });

  it('discard reverts staged imports along with all other unsaved edits', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select all bills without warnings'));
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByText(/Select all without warnings \(2 of 3\)/)).toBeTruthy();
    expect(screen.queryByText('staged')).toBeNull();
    // The saved bill is still there.
    expect(screen.getByText('Duke Energy')).toBeTruthy();
  });
});
