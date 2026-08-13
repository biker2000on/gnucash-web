/**
 * The apply-history route reports matches it refused to re-book because their
 * split is reconciled ('y') or frozen ('f'). The modal used to keep only
 * `applied` and `moreRemain`, so those rows were skipped invisibly — the exact
 * silent-no-op the reconciled guard exists to prevent. These tests pin that
 * the count AND the server's actionable message reach the user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { successMock, errorMock } = vi.hoisted(() => ({
  successMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ success: successMock, error: errorMock }),
}));

import ApplyHistoryModal from '../ApplyHistoryModal';

const rule = {
  id: 1,
  pattern: 'king soopers',
  matchType: 'contains',
  accountName: 'Root:Expenses:Groceries',
};

const SPLIT_GUID = 's'.repeat(32);
const RECONCILED_MESSAGE =
  `Left unchanged because they are reconciled or frozen — unreconcile them first: `
  + `split ${SPLIT_GUID} on Assets:Checking is reconciled (reconcile_state 'y').`;

const previewPayload = {
  dryRun: true,
  matchCount: 2,
  skippedCount: 0,
  moreRemain: false,
  matches: [{
    guid: 't'.repeat(32),
    date: '2026-01-05',
    description: 'KING SOOPERS #1',
    currentAccount: 'Imbalance-USD',
    newAccount: 'Groceries',
    amount: -42.5,
  }],
  skipped: [],
};

/** Preview first (the Apply button is disabled without one), then apply. */
function mockFetchSequence(applyPayload: Record<string, unknown>) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => previewPayload })
    .mockResolvedValueOnce({ ok: true, json: async () => applyPayload });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function previewThenApply(applyPayload: Record<string, unknown>) {
  mockFetchSequence(applyPayload);
  render(<ApplyHistoryModal rule={rule} onClose={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /preview/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^apply/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /^apply/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApplyHistoryModal reconciled-skip reporting', () => {
  it('renders the skipped count and the server message naming the split', async () => {
    await previewThenApply({
      dryRun: false,
      applied: 1,
      matchCount: 2,
      skippedCount: 0,
      skipped: [],
      lockedSkipped: 0,
      reconciledSkipped: 1,
      reconciledSplits: [{
        guid: SPLIT_GUID,
        tx_guid: 't'.repeat(32),
        account_guid: 'a'.repeat(32),
        reconcile_state: 'y',
      }],
      reconciledMessage: RECONCILED_MESSAGE,
      moreRemain: false,
    });

    const panel = await screen.findByTestId('reconciled-skipped');
    expect(panel).toHaveTextContent('1 change was skipped');
    expect(panel).toHaveTextContent(/reconciled or frozen splits cannot be recategorized/i);
    // The actionable part: which split, and what to do about it.
    expect(panel).toHaveTextContent(SPLIT_GUID);
    expect(panel).toHaveTextContent(/unreconcile/i);
  });

  it('warns instead of reporting plain success when rows were skipped', async () => {
    await previewThenApply({
      dryRun: false,
      applied: 1,
      matchCount: 3,
      skippedCount: 0,
      skipped: [],
      lockedSkipped: 0,
      reconciledSkipped: 2,
      reconciledSplits: [],
      reconciledMessage: RECONCILED_MESSAGE,
      moreRemain: false,
    });

    await waitFor(() => expect(errorMock).toHaveBeenCalled());
    expect(errorMock.mock.calls[0][0]).toMatch(/2 left unchanged because their splits are reconciled or frozen/i);
    // A success toast alone would tell the user everything worked.
    expect(successMock).not.toHaveBeenCalled();
  });

  it('reports plain success and shows no warning panel when nothing was skipped', async () => {
    await previewThenApply({
      dryRun: false,
      applied: 2,
      matchCount: 2,
      skippedCount: 0,
      skipped: [],
      lockedSkipped: 0,
      reconciledSkipped: 0,
      reconciledSplits: [],
      moreRemain: false,
    });

    await waitFor(() => expect(successMock).toHaveBeenCalled());
    expect(successMock.mock.calls[0][0]).toMatch(/Recategorized 2 transactions/);
    expect(errorMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reconciled-skipped')).toBeNull();
  });
});
