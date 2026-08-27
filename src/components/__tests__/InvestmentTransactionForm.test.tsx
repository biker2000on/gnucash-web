import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestmentTransactionForm } from '../InvestmentTransactionForm';

const { accountSelectorMock } = vi.hoisted(() => ({
    accountSelectorMock: vi.fn(),
}));

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: {
        value: string;
        onChange: (guid: string, name: string) => void;
        placeholder?: string;
        accountTypes?: string[];
    }) => {
        accountSelectorMock(props);
        return (
            <button
                type="button"
                data-testid={`account-selector-${props.placeholder}`}
                onClick={() => props.onChange(`${props.accountTypes?.[0].toLowerCase()}-guid`, 'Selected account')}
            >
                {props.value || props.placeholder}
            </button>
        );
    },
}));

vi.mock('@/lib/hooks/useAccounts', () => ({
    useAccounts: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({ dateFormat: 'MM/DD/YYYY' }),
}));

const formProps = {
    accountGuid: 'investment-guid',
    accountName: 'Brokerage',
    commoditySymbol: 'ACME',
    onSave: vi.fn(),
    onCancel: vi.fn(),
};

describe('InvestmentTransactionForm account pickers', () => {
    // The date-shortcut case reads the field's default (today) and then
    // recomputes the expected value from a fresh `new Date()`; across midnight
    // those are different days. Pin the clock - only Date is faked, and these
    // cases are synchronous fireEvent, so no timer-driven helper is affected.
    const NOW = new Date(2026, 5, 15, 12, 0, 0);

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        accountSelectorMock.mockClear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: () => Promise.resolve([{ guid: 'usd-guid', mnemonic: 'USD' }]),
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses AccountSelector with the right account types in every transaction context', () => {
        render(<InvestmentTransactionForm {...formProps} />);

        const expensePicker = screen.getByTestId('account-selector-Select expense account...');
        const buyCashPicker = screen.getByTestId('account-selector-Select cash/bank account...');
        expect(expensePicker).toHaveTextContent('Select expense account...');
        expect(buyCashPicker).toHaveTextContent('Select cash/bank account...');

        fireEvent.click(buyCashPicker);
        expect(screen.getByTestId('account-selector-Select cash/bank account...')).toHaveTextContent('bank-guid');

        fireEvent.click(expensePicker);
        expect(screen.getByTestId('account-selector-Select expense account...')).toHaveTextContent('expense-guid');

        let visibleSelectors = accountSelectorMock.mock.calls.slice(-2).map(([props]) => props);
        expect(visibleSelectors.map((props: { accountTypes?: string[] }) => props.accountTypes))
            .toEqual([['EXPENSE'], ['BANK', 'ASSET', 'CASH']]);

        fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
        visibleSelectors = accountSelectorMock.mock.calls.slice(-2).map(([props]) => props);
        expect(visibleSelectors.map((props: { accountTypes?: string[] }) => props.accountTypes))
            .toEqual([['EXPENSE'], ['BANK', 'ASSET', 'CASH']]);

        fireEvent.click(screen.getByRole('button', { name: 'Dividend' }));
        visibleSelectors = accountSelectorMock.mock.calls.slice(-2).map(([props]) => props);
        expect(visibleSelectors.map((props: { accountTypes?: string[] }) => props.accountTypes))
            .toEqual([['BANK', 'ASSET', 'CASH'], ['INCOME']]);

        const incomePicker = screen.getByTestId('account-selector-Select income account...');
        fireEvent.click(incomePicker);
        expect(screen.getByTestId('account-selector-Select income account...')).toHaveTextContent('income-guid');

        fireEvent.click(screen.getByRole('button', { name: 'Return of Capital' }));
        visibleSelectors = accountSelectorMock.mock.calls.slice(-1).map(([props]) => props);
        expect(visibleSelectors.map((props: { accountTypes?: string[] }) => props.accountTypes))
            .toEqual([['BANK', 'ASSET', 'CASH']]);

        fireEvent.click(screen.getByRole('button', { name: 'Stock Split' }));
        expect(screen.queryByTestId('account-selector-Select cash/bank account...')).not.toBeInTheDocument();
        expect(screen.queryByTestId('account-selector-Select income account...')).not.toBeInTheDocument();
    });

    it('supports the standard date field keyboard shortcuts', () => {
        render(<InvestmentTransactionForm {...formProps} />);

        const dateInput = screen.getByPlaceholderText('MM/DD/YYYY');
        const initialDate = dateInput.getAttribute('value')!;
        const [month, day, year] = initialDate.split('/').map(Number);
        const shiftedDate = new Date(year, month - 1, day, 12);
        shiftedDate.setDate(shiftedDate.getDate() + 1);
        const nextDate = [
            String(shiftedDate.getMonth() + 1).padStart(2, '0'),
            String(shiftedDate.getDate()).padStart(2, '0'),
            shiftedDate.getFullYear(),
        ].join('/');

        fireEvent.keyDown(dateInput, { key: '+' });
        expect(dateInput).toHaveValue(nextDate);

        shiftedDate.setDate(shiftedDate.getDate() + 1);
        const followingDate = [
            String(shiftedDate.getMonth() + 1).padStart(2, '0'),
            String(shiftedDate.getDate()).padStart(2, '0'),
            shiftedDate.getFullYear(),
        ].join('/');
        fireEvent.keyDown(dateInput, { key: '=' });
        expect(dateInput).toHaveValue(followingDate);

        fireEvent.keyDown(dateInput, { key: '-' });
        expect(dateInput).toHaveValue(nextDate);

        fireEvent.keyDown(dateInput, { key: 't' });
        const today = new Date();
        expect(dateInput).toHaveValue([
            String(today.getMonth() + 1).padStart(2, '0'),
            String(today.getDate()).padStart(2, '0'),
            today.getFullYear(),
        ].join('/'));
    });

    // The form never read `accountCommodityGuid` — the prop and the write-only
    // "Split Ratio (informational)" field were dead weight. The @ts-expect-error
    // is the real assertion for the prop: it fails to compile if the prop comes back.
    it('no longer accepts the unused accountCommodityGuid prop', () => {
        render(
            <InvestmentTransactionForm
                {...formProps}
                // @ts-expect-error accountCommodityGuid was removed — the form never read it
                accountCommodityGuid="commodity-guid"
            />,
        );

        expect(screen.getByText('Investment Transaction')).toBeInTheDocument();
    });

    it('does not render a write-only split-ratio field for a stock split', () => {
        render(<InvestmentTransactionForm {...formProps} />);

        fireEvent.click(screen.getByRole('button', { name: 'Stock Split' }));

        expect(screen.getByText('New Shares to Add')).toBeInTheDocument();
        expect(screen.queryByText(/Split Ratio/i)).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('e.g., 2-for-1')).not.toBeInTheDocument();
    });
});

describe('InvestmentTransactionForm submit keyboard shortcuts', () => {
    beforeEach(() => {
        accountSelectorMock.mockClear();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith('/api/commodities')) {
                return { ok: true, json: async () => [{ guid: 'usd-guid', mnemonic: 'USD' }] };
            }
            if (url === '/api/transactions' && init?.method === 'POST') {
                return { ok: true, json: async () => ({}) };
            }
            throw new Error(`Unexpected request: ${url}`);
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Fill out a valid Dividend entry (fewest required fields). */
    async function fillDividend() {
        fireEvent.click(screen.getByRole('button', { name: 'Dividend' }));
        fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '12.34' } });
        fireEvent.click(screen.getByTestId('account-selector-Select cash/bank account...'));
        fireEvent.click(screen.getByTestId('account-selector-Select income account...'));
        // Let the currency fetch resolve into state so submission is not
        // rejected with "Currency not loaded".
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }

    it('submits on Ctrl+Enter like the other transaction modals', async () => {
        const onSave = vi.fn();
        render(<InvestmentTransactionForm {...formProps} onSave={onSave} />);
        await fillDividend();

        fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(fetch).toHaveBeenCalledWith('/api/transactions', expect.objectContaining({ method: 'POST' }));
    });

    it('Ctrl+Shift+Enter records and starts a fresh form with the same date', async () => {
        const onSave = vi.fn();
        const onSaveAndNew = vi.fn();
        render(<InvestmentTransactionForm {...formProps} onSave={onSave} onSaveAndNew={onSaveAndNew} />);
        await fillDividend();

        const dateInput = screen.getByPlaceholderText('MM/DD/YYYY') as HTMLInputElement;
        const dateBefore = dateInput.value;

        fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, shiftKey: true });

        await vi.waitFor(() => expect(onSaveAndNew).toHaveBeenCalledTimes(1));
        // Modal stays open on a cleared form: parent close callback not called,
        // the amount is blank again, and the date survives for the next entry.
        expect(onSave).not.toHaveBeenCalled();
        expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('');
        expect(dateInput.value).toBe(dateBefore);
    });

    it('renders a Record & New button only when onSaveAndNew is wired', () => {
        const { rerender } = render(<InvestmentTransactionForm {...formProps} />);
        expect(screen.queryByRole('button', { name: 'Record & New' })).not.toBeInTheDocument();

        rerender(<InvestmentTransactionForm {...formProps} onSaveAndNew={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Record & New' })).toBeInTheDocument();
    });
});
