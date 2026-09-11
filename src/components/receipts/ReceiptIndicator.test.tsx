import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptIndicator } from './ReceiptIndicator';

vi.mock('./ReceiptModal', () => ({
  ReceiptModal: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>Receipt viewer</div> : null,
}));
vi.mock('@/components/ui/Tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ReceiptIndicator', () => {
  it('shows the count and opens receipts without opening the transaction row', () => {
    const openRow = vi.fn();
    render(<div onClick={openRow}><ReceiptIndicator transactionGuid="taj" receiptCount={2} /></div>);
    fireEvent.click(screen.getByRole('button', { name: '2 receipts attached' }));
    expect(screen.getByText('Receipt viewer')).toBeTruthy();
    expect(openRow).not.toHaveBeenCalled();
  });

  it('updates matching indicators after uploads and deletions', () => {
    render(<><ReceiptIndicator transactionGuid="taj" receiptCount={0} /><ReceiptIndicator transactionGuid="other" receiptCount={0} /></>);
    act(() => { window.dispatchEvent(new CustomEvent('gnucash:receipts-changed', { detail: { transactionGuid: 'taj', count: 1 } })); });
    expect(screen.getByRole('button', { name: '1 receipt attached' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Attach receipt' })).toHaveLength(1);
    act(() => { window.dispatchEvent(new CustomEvent('gnucash:receipts-changed', { detail: { transactionGuid: 'taj', count: 0 } })); });
    expect(screen.getAllByRole('button', { name: 'Attach receipt' })).toHaveLength(2);
  });

  it('loads the current receipt count for transaction details', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 1 }] });
    vi.stubGlobal('fetch', fetcher);
    render(<ReceiptIndicator transactionGuid="taj" />);
    expect(await screen.findByRole('button', { name: '1 receipt attached' })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith('/api/transactions/taj/receipts');
  });
});
