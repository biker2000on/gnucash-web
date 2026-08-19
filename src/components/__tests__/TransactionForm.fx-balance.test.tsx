/**
 * The form must validate the numbers it SUBMITS, not the numbers typed.
 *
 * buildCurrencySplitAmounts rounds each split to whole units of the
 * transaction currency's fraction before the request is built, so a
 * foreign-currency split of 1 @ 0.3333 is sent as 33/100. Balancing the raw
 * `amount x rate` products instead would see a 0.0033 gap and refuse a
 * transaction the API accepts as exactly balanced — the mirror image of the
 * defect this branch fixes.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionForm } from '../TransactionForm';

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: {
        value: string;
        onChange: (guid: string, name: string) => void;
        placeholder?: string;
    }) => (
        <input
            aria-label={`account:${props.placeholder}`}
            value={props.value}
            onChange={e => props.onChange(e.target.value, `Account ${e.target.value.slice(0, 4)}`)}
        />
    ),
}));

vi.mock('@/components/ui/DescriptionAutocomplete', () => ({
    DescriptionAutocomplete: (props: { value: string; onChange: (v: string) => void }) => (
        <input aria-label="Description" value={props.value} onChange={e => props.onChange(e.target.value)} />
    ),
}));

const USD = 'usd0000000000000000000000000001';
const EUR = 'eur0000000000000000000000000001';
const EUR_ACCOUNT = 'aaa0000000000000000000000000001';
const USD_ACCOUNT = 'bbb0000000000000000000000000001';

vi.mock('@/lib/hooks/useAccounts', () => ({
    useAccounts: () => ({
        data: [
            {
                guid: 'aaa0000000000000000000000000001',
                name: 'Euro Cash',
                fullname: 'Assets:Euro Cash',
                commodity_guid: 'eur0000000000000000000000000001',
                commodity_mnemonic: 'EUR',
                commodity_scu: 100,
            },
            {
                guid: 'bbb0000000000000000000000000001',
                name: 'Checking',
                fullname: 'Assets:Checking',
                commodity_guid: 'usd0000000000000000000000000001',
                commodity_mnemonic: 'USD',
                commodity_scu: 100,
            },
        ],
        isLoading: false,
    }),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({ defaultTaxRate: 0, dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/hooks/useFormKeyboardShortcuts', () => ({ useFormKeyboardShortcuts: () => {} }));
vi.mock('@/lib/hooks/useKeyboardShortcut', () => ({ useKeyboardShortcut: () => {} }));

beforeEach(() => {
    vi.clearAllMocks();
    // SplitRow asks for each account's commodity to decide whether to show the
    // exchange-rate box; the rate lookup is left failing so nothing auto-fills
    // over the rate the test types.
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.includes(`/api/accounts/${EUR_ACCOUNT}/info`)) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ commodity_guid: EUR }) });
        }
        if (url.includes(`/api/accounts/${USD_ACCOUNT}/info`)) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ commodity_guid: USD }) });
        }
        if (url.includes('/api/exchange-rates/pair')) {
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ guid: USD, mnemonic: 'USD' }]) });
    }));
});

/**
 * Advanced-mode entry: a EUR split at `rate` against a USD split.
 * Returns once the exchange-rate box has been filled in.
 */
async function fillForeignCurrencyEntry(eurDebit: string, usdCredit: string, rate: string) {
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Foreign purchase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Advanced (Multiple Splits)' }));

    const accounts = screen.getAllByLabelText('account:Select account...');
    fireEvent.change(accounts[0], { target: { value: EUR_ACCOUNT } });
    fireEvent.change(accounts[1], { target: { value: USD_ACCOUNT } });

    fireEvent.change(screen.getAllByPlaceholderText('Debit')[0], { target: { value: eurDebit } });
    fireEvent.change(screen.getAllByPlaceholderText('Credit')[1], { target: { value: usdCredit } });

    // Appears only once the EUR account's commodity has been fetched.
    const rateInput = await screen.findByPlaceholderText('1.0000');
    fireEvent.change(rateInput, { target: { value: rate } });
}

describe('foreign-currency balance validation', () => {
    it('accepts 1 EUR @ 0.3333 against $0.33 — the rounded values balance exactly', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        await fillForeignCurrencyEntry('1', '0.33', '0.3333');

        // The raw products differ by 0.0033; the submitted cents do not.
        expect(screen.queryByTestId('form-errors')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const payload = onSave.mock.calls[0][0];
        const values = payload.splits.map((split: { value_num: number; value_denom: number }) => split.value_num);
        expect(values).toEqual([33, -33]);
        expect(values.reduce((a: number, b: number) => a + b, 0)).toBe(0);
    });

    it('still rejects an entry whose ROUNDED values do not balance', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        // 1 EUR @ 0.3333 -> 33 cents, against a 50 cent credit: off by 17 cents.
        await fillForeignCurrencyEntry('1', '0.50', '0.3333');

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        expect(within(await screen.findByTestId('form-errors')).getByText(/Transaction is unbalanced by -0\.17/)).toBeTruthy();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('rejects a same-currency one-cent imbalance', async () => {

        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Off by a cent' } });
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Advanced (Multiple Splits)' }));
        const accounts = screen.getAllByLabelText('account:Select account...');
        fireEvent.change(accounts[0], { target: { value: USD_ACCOUNT } });
        fireEvent.change(accounts[1], { target: { value: USD_ACCOUNT } });
        fireEvent.change(screen.getAllByPlaceholderText('Debit')[0], { target: { value: '10.00' } });
        fireEvent.change(screen.getAllByPlaceholderText('Credit')[1], { target: { value: '9.99' } });

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        expect(within(await screen.findByTestId('form-errors')).getByText(/Transaction is unbalanced by 0\.01/)).toBeTruthy();
        expect(onSave).not.toHaveBeenCalled();
    });
});

/**
 * buildApiData drops rows with no account selected, so the balance the form
 * checks must drop them too — otherwise such a row's amount silently offsets a
 * real imbalance in the rows that ARE sent. The dropped amount is reported as
 * its own per-row error instead.
 */
describe('rows with an amount but no account', () => {
    /** Advanced mode with a third, initially blank, split row. */
    function openAdvancedWithThirdRow(description: string) {
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } });
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Advanced (Multiple Splits)' }));
        fireEvent.click(screen.getByRole('button', { name: '+ Add Split' }));

        const accounts = screen.getAllByLabelText('account:Select account...');
        fireEvent.change(accounts[0], { target: { value: USD_ACCOUNT } });
        fireEvent.change(accounts[1], { target: { value: USD_ACCOUNT } });
    }

    it('does not let an account-less row mask a real imbalance in the submitted rows', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        openAdvancedWithThirdRow('Masked imbalance');
        // Sent rows are off by a cent; the third row's 0.01 would hide it.
        fireEvent.change(screen.getAllByPlaceholderText('Debit')[0], { target: { value: '1.00' } });
        fireEvent.change(screen.getAllByPlaceholderText('Credit')[1], { target: { value: '0.99' } });
        fireEvent.change(screen.getAllByPlaceholderText('Credit')[2], { target: { value: '0.01' } });

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        expect(within(await screen.findByTestId('form-errors')).getByText(/Select an account for line 3 or clear its amount/)).toBeTruthy();
        // The row itself also carries the reason; the sr-only live region is the other alert.
        expect(screen.getAllByRole('alert').some(node => node.textContent?.includes('Select an account or clear this amount.'))).toBe(true);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('reports the row rather than a bogus imbalance when the sent rows balance', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        openAdvancedWithThirdRow('Stray amount');
        fireEvent.change(screen.getAllByPlaceholderText('Debit')[0], { target: { value: '1.00' } });
        fireEvent.change(screen.getAllByPlaceholderText('Credit')[1], { target: { value: '1.00' } });
        fireEvent.change(screen.getAllByPlaceholderText('Credit')[2], { target: { value: '0.05' } });

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        const errorList = await screen.findByTestId('form-errors');
        expect(within(errorList).getByText(/Select an account for line 3 or clear its amount/)).toBeTruthy();
        expect(within(errorList).queryByText(/unbalanced/i)).toBeNull();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('submits normally with a blank trailing row', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        openAdvancedWithThirdRow('Blank trailing row');
        fireEvent.change(screen.getAllByPlaceholderText('Debit')[0], { target: { value: '1.00' } });
        fireEvent.change(screen.getAllByPlaceholderText('Credit')[1], { target: { value: '1.00' } });

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        expect(screen.queryByTestId('form-errors')).toBeNull();
        expect(screen.getAllByRole('alert').every(node => node.textContent === '')).toBe(true);
        // The blank row is not sent.
        expect(onSave.mock.calls[0][0].splits).toHaveLength(2);
    });
});
