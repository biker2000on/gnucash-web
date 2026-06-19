import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PayslipDetailPanel } from '../PayslipDetailPanel';

vi.mock('@/components/ui/AccountSelector', () => ({
  AccountSelector: ({ onChange, placeholder }: { onChange: (guid: string, name: string) => void; placeholder?: string }) => (
    <button type="button" onClick={() => onChange('bank-guid', 'Checking')}>
      {placeholder ?? 'Select account'}
    </button>
  ),
}));

vi.mock('../TransactionPreview', () => ({
  TransactionPreview: () => <div data-testid="transaction-preview" />,
}));

const basePayslip = {
  id: 71,
  employer_name: 'Industrial Insight Inc',
  pay_date: '2026-06-15T00:00:00.000Z',
  status: 'ready',
  gross_pay: 6333.33,
  net_pay: 3731.66,
  storage_key: null,
  line_items: [
    { category: 'earnings', label: 'Salary', normalized_label: 'salary', amount: 6333.33 },
    { category: 'tax', label: 'Medicare', normalized_label: 'medicare', amount: -99.78 },
    { category: 'tax', label: 'Federal Income Tax', normalized_label: 'federal_income_tax', amount: -770.34 },
    { category: 'deduction', label: '401K', normalized_label: '401k', amount: -1026 },
  ],
};

describe('PayslipDetailPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('saves edited line items before posting the payslip transaction', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/payslips/71' && method === 'GET') {
        return Response.json(basePayslip);
      }

      if (url === '/api/payslips/mappings?employer=Industrial%20Insight%20Inc') {
        return Response.json([
          { normalized_label: 'salary', line_item_category: 'earnings', account_guid: 'income-guid' },
          { normalized_label: 'medicare', line_item_category: 'tax', account_guid: 'medicare-guid' },
          { normalized_label: 'federal_income_tax', line_item_category: 'tax', account_guid: 'federal-guid' },
          { normalized_label: '401k', line_item_category: 'deduction', account_guid: '401k-guid' },
        ]);
      }

      if (url === '/api/accounts?flat=true&noBalances=true') {
        return Response.json([{ guid: 'bank-guid', name: 'Checking', commodity_guid: 'usd-guid' }]);
      }

      if (url === '/api/payslips/71' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        return Response.json({ ...basePayslip, line_items: body.line_items });
      }

      if (url === '/api/accounts') {
        return Response.json([{ guid: 'bank-guid', name: 'Checking', commodity_guid: 'usd-guid' }]);
      }

      if (url === '/api/payslips/71/post') {
        return Response.json({ transaction_guid: 'tx-guid' });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PayslipDetailPanel payslipId={71} onClose={vi.fn()} />);

    const medicareInput = await screen.findByDisplayValue('-99.78');
    fireEvent.change(medicareInput, { target: { value: '-89.78' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select deposit account...' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post Transaction' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/payslips/71/post',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const patchCallIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) => url === '/api/payslips/71' && init?.method === 'PATCH',
    );
    const postCallIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) => url === '/api/payslips/71/post' && init?.method === 'POST',
    );
    expect(patchCallIndex).toBeGreaterThan(-1);
    expect(postCallIndex).toBeGreaterThan(patchCallIndex);

    const patchBody = JSON.parse(String(fetchMock.mock.calls[patchCallIndex][1]?.body));
    expect(patchBody.line_items[1].amount).toBe(-89.78);
  });
});
