import { fireEvent, render, screen } from '@testing-library/react';
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
    accountCommodityGuid: 'commodity-guid',
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
});
