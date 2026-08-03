import { describe, expect, it } from 'vitest';
import {
    buildInvestmentSplits,
    type InvestmentSplitInput,
} from '../../components/InvestmentTransactionForm';
import { classifySecurityPosition } from '../data-health';
import {
    assertValueBalanced,
    calculateImbalances,
    generateTradingSplits,
    type SplitWithCommodity,
} from '../trading-accounts';

function valueOf(split: { value_num: number; value_denom: number }): number {
    return split.value_num / split.value_denom;
}

const COMMODITIES: Record<string, Omit<SplitWithCommodity, 'accountGuid' | 'value' | 'quantity'>> = {
    stock: {
        commodityGuid: 'vt-guid',
        commodityMnemonic: 'VT',
        commodityNamespace: 'NYSE',
        commodityFraction: 1_000_000,
    },
    cash: {
        commodityGuid: 'usd-guid',
        commodityMnemonic: 'USD',
        commodityNamespace: 'CURRENCY',
        commodityFraction: 100,
    },
    income: {
        commodityGuid: 'usd-guid',
        commodityMnemonic: 'USD',
        commodityNamespace: 'CURRENCY',
        commodityFraction: 100,
    },
    fees: {
        commodityGuid: 'usd-guid',
        commodityMnemonic: 'USD',
        commodityNamespace: 'CURRENCY',
        commodityFraction: 100,
    },
};

/**
 * Mirrors the pure half of `processMultiCurrencySplits`: derive commodity info
 * per split, generate the balancing trading splits, and return the FULL set
 * that would be written to the database.
 */
function withTradingSplits(splits: ReturnType<typeof buildInvestmentSplits>) {
    const withCommodity: SplitWithCommodity[] = splits.map(s => ({
        accountGuid: s.account_guid,
        ...COMMODITIES[s.account_guid],
        value: s.value_num / s.value_denom,
        quantity: (s.quantity_num ?? s.value_num) / (s.quantity_denom ?? s.value_denom),
    }));

    const imbalances = calculateImbalances(withCommodity);
    const tradingGuids = new Map(
        [...imbalances.keys()].map(guid => [guid, `trading-${guid}`]),
    );

    return [
        ...splits.map(s => ({ value_num: s.value_num, value_denom: s.value_denom })),
        ...generateTradingSplits(imbalances, tradingGuids).map(ts => ({
            value_num: ts.valueNum,
            value_denom: ts.valueDenom,
        })),
    ];
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

describe('trading splits keep the written transaction balanced', () => {
    // Regression: a return of capital nets to ZERO shares on the security but
    // carries value there. The generator used to drop any commodity whose
    // quantity netted to zero, discarding its value with it, so the set that
    // actually reached the database summed to -$500 instead of 0.
    it('balances a return of capital once trading splits are appended', () => {
        const splits = buildInvestmentSplits({
            ...BASE_INPUT,
            action: 'ReturnOfCapital',
            amount: 500,
        });

        expect(splits.reduce((sum, split) => sum + valueOf(split), 0)).toBe(0);

        const allSplits = withTradingSplits(splits);

        expect(allSplits).toHaveLength(4); // 2 original + Trading:NYSE:VT + Trading:CURRENCY:USD
        expect(allSplits.reduce((sum, split) => sum + valueOf(split), 0)).toBe(0);
        expect(() => assertValueBalanced(allSplits)).not.toThrow();
    });

    it('balances a buy with commission across trading splits', () => {
        const allSplits = withTradingSplits(buildInvestmentSplits(BASE_INPUT));

        expect(allSplits.reduce((sum, split) => sum + valueOf(split), 0)).toBe(0);
        expect(() => assertValueBalanced(allSplits)).not.toThrow();
    });

    it('throws rather than writing an unbalanced set', () => {
        expect(() => assertValueBalanced([
            { value_num: 50_000, value_denom: 100 },
            { value_num: -49_999, value_denom: 100 },
        ])).toThrow(/do not balance/);
    });

    it('compares across mixed denominators exactly', () => {
        expect(() => assertValueBalanced([
            { value_num: 1_000_000, value_denom: 1_000_000 },
            { value_num: -100, value_denom: 100 },
        ])).not.toThrow();
    });
});
