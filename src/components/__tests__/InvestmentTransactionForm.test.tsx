import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    beforeEach(() => {
        accountSelectorMock.mockClear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: () => Promise.resolve([{ guid: 'usd-guid', mnemonic: 'USD' }]),
        }));
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
});
