import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReconciliationPanel } from '../ReconciliationPanel';

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({ dateFormat: 'MM/DD/YYYY' }),
}));

const baseProps = {
  accountCurrency: 'USD',
  currentBalance: 100,
  selectedBalance: 0,
  selectedSplits: new Set<string>(),
  onSelectAll: vi.fn(),
  onClearSelection: vi.fn(),
  onStartReconcile: vi.fn(),
  onCancelReconcile: vi.fn(),
};

describe('ReconciliationPanel SimpleFIN balance default', () => {
  it('does not refill after the user clears or edits the statement balance', async () => {
    const { rerender } = render(
      <ReconciliationPanel
        {...baseProps}
        isReconciling
        simpleFinBalance={{ balance: 125.5, balanceDate: '2026-07-27T00:00:00.000Z' }}
      />,
    );

    const balanceInput = await screen.findByDisplayValue('125.50');
    fireEvent.change(balanceInput, { target: { value: '' } });
    expect(balanceInput).toHaveValue(null);

    rerender(
      <ReconciliationPanel
        {...baseProps}
        isReconciling
        simpleFinBalance={{ balance: 130, balanceDate: '2026-07-27T01:00:00.000Z' }}
      />,
    );
    await waitFor(() => expect(balanceInput).toHaveValue(null));

    fireEvent.change(balanceInput, { target: { value: '129.25' } });
    expect(balanceInput).toHaveValue(129.25);
  });

  it('applies the latest SimpleFIN default once when a new reconciliation starts', async () => {
    const { rerender } = render(
      <ReconciliationPanel
        {...baseProps}
        isReconciling={false}
        simpleFinBalance={{ balance: 125.5, balanceDate: '2026-07-27T00:00:00.000Z' }}
      />,
    );

    rerender(
      <ReconciliationPanel
        {...baseProps}
        isReconciling
        simpleFinBalance={{ balance: 130, balanceDate: '2026-07-27T01:00:00.000Z' }}
      />,
    );

    await expect(screen.findByDisplayValue('130.00')).resolves.toBeVisible();
  });
});
