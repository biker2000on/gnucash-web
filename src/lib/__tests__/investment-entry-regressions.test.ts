import { describe, expect, it } from 'vitest';
import {
    buildInvestmentSplits,
    type InvestmentSplitInput,
} from '../../components/InvestmentTransactionForm';
import { classifySecurityPosition } from '../data-health';

function valueOf(split: ReturnType<typeof buildInvestmentSplits>[number]): number {
    return split.value_num / split.value_denom;
}

const BASE_INPUT: InvestmentSplitInput = {
    action: 'Buy',
    accountGuid: 'stock',
    commodityFraction: 1_000_000,
    shares: 10,
    total: 1_000,
    amount: 0,
    commission: 5,
    cashAccountGuid: 'cash',
    incomeAccountGuid: 'income',
    expenseAccountGuid: 'fees',
    memo: '',
    commoditySymbol: 'VT',
};

describe('security position classification', () => {
    it('only treats a positive position as owned', () => {
        expect(classifySecurityPosition(12.5)).toBe('owned');
        expect(classifySecurityPosition(0)).toBe('closed');
        expect(classifySecurityPosition(-0.002821)).toBe('negative');
    });

    it('treats sub-threshold representation noise as closed', () => {
        expect(classifySecurityPosition(0.00009)).toBe('closed');
        expect(classifySecurityPosition(-0.00009)).toBe('closed');
    });
});

describe('investment split construction', () => {
    it('builds a balanced buy with positive shares and value in the security account', () => {
        const splits = buildInvestmentSplits(BASE_INPUT);
        const stock = splits.find((split) => split.account_guid === 'stock');
        const cash = splits.find((split) => split.account_guid === 'cash');

        expect(stock).toMatchObject({
            quantity_num: 10_000_000,
            quantity_denom: 1_000_000,
            value_num: 100_000,
            value_denom: 100,
        });
        expect(valueOf(cash!)).toBe(-1_005);
        expect(splits.reduce((sum, split) => sum + valueOf(split), 0)).toBe(0);
    });

    it('builds a balanced sell with negative shares and value in the security account', () => {
        const splits = buildInvestmentSplits({ ...BASE_INPUT, action: 'Sell' });
        const stock = splits.find((split) => split.account_guid === 'stock');
        const cash = splits.find((split) => split.account_guid === 'cash');

        expect(stock).toMatchObject({
            quantity_num: -10_000_000,
            quantity_denom: 1_000_000,
            value_num: -100_000,
            value_denom: 100,
        });
        expect(valueOf(cash!)).toBe(995);
        expect(splits.reduce((sum, split) => sum + valueOf(split), 0)).toBe(0);
    });

    it('balances return of capital by reducing security basis and increasing cash', () => {
        const splits = buildInvestmentSplits({
            ...BASE_INPUT,
            action: 'ReturnOfCapital',
            amount: 125,
        });

        expect(valueOf(splits[0])).toBe(-125);
        expect(valueOf(splits[1])).toBe(125);
        expect(splits.reduce((sum, split) => sum + valueOf(split), 0)).toBe(0);
    });
});
