import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReconciliationPanel } from '../ReconciliationPanel';

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({ dateFormat: 'MM/DD/YYYY' }),
}));

const baseProps = {
  accountGuid: 'checking-account',
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

describe('ReconciliationPanel finish gate', () => {
  it('blocks Finish when the exact minor-unit difference is non-zero', () => {
    render(
      <ReconciliationPanel
        {...baseProps}
        isReconciling
        selectedBalance={20}
        selectedSplits={new Set(['split-1'])}
      />,
    );

    fireEvent.change(screen.getByLabelText('Statement Balance'), { target: { value: '120.01' } });
    expect(screen.getByRole('button', { name: 'Finish' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('exactly zero');
  });

  it('allows Finish only at an exact zero and posts the statement balance and date', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const complete = vi.fn();
    render(
      <ReconciliationPanel
        {...baseProps}
        isReconciling
        selectedBalance={20}
        selectedSplits={new Set(['split-1'])}
        onReconcileComplete={complete}
      />,
    );

    fireEvent.change(screen.getByLabelText('Statement Balance'), { target: { value: '120.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/accounts/checking-account/reconcile', expect.any(Object));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      splitGuids: ['split-1'],
      endingBalance: 120,
      allowDiscrepancy: false,
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('requires explicit confirmation before finishing with a recorded discrepancy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ReconciliationPanel
        {...baseProps}
        isReconciling
        selectedBalance={20}
        selectedSplits={new Set(['split-1'])}
      />,
    );

    fireEvent.change(screen.getByLabelText('Statement Balance'), { target: { value: '120.01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record discrepancy and finish…' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm finish with recorded discrepancy' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1].body).toContain('"allowDiscrepancy":true');
  });
});
