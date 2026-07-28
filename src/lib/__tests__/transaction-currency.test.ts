import { describe, expect, it } from 'vitest';
import {
    buildCurrencySplitAmounts,
    parseExchangeRate,
} from '@/lib/transaction-currency';
import { calculateImbalances, generateTradingSplits } from '@/lib/trading-accounts';

describe('foreign-currency transaction split conversion', () => {
    it('keeps the entered Alipay amount as CNY quantity and converts its value to USD', () => {
        // 34.18 CNY at 0.1423 USD/CNY = 4.863814 USD, rounded to cents.
        expect(buildCurrencySplitAmounts(34.18, 0.1423)).toEqual({
            valueNum: 486,
            valueDenom: 100,
            quantityNum: 3418,
            quantityDenom: 100,
        });
    });

    it('preserves the sign when converting a credit split', () => {
        expect(buildCurrencySplitAmounts(-34.18, 0.1423)).toEqual({
            valueNum: -486,
            valueDenom: 100,
            quantityNum: -3418,
            quantityDenom: 100,
        });
    });

    it('uses identical value and quantity for a same-currency split', () => {
        expect(buildCurrencySplitAmounts(34.18)).toEqual({
            valueNum: 3418,
            valueDenom: 100,
            quantityNum: 3418,
            quantityDenom: 100,
        });
    });

    it('rejects unusable exchange rates instead of silently creating a wrong value', () => {
        expect(parseExchangeRate('0.1423')).toBe(0.1423);
        expect(parseExchangeRate('')).toBeNull();
        expect(parseExchangeRate('not-a-rate')).toBeNull();
        expect(parseExchangeRate(0)).toBeNull();
        expect(() => buildCurrencySplitAmounts(34.18, 0)).toThrow(RangeError);
    });

    it('generates the USD trading leg from the converted value, not the CNY quantity', () => {
        const alipay = buildCurrencySplitAmounts(-34.18, 0.1423);
        const expense = buildCurrencySplitAmounts(4.86);
        const imbalances = calculateImbalances([
            {
                accountGuid: 'alipay-guid',
                commodityGuid: 'cny-guid',
                commodityMnemonic: 'CNY',
                commodityNamespace: 'CURRENCY',
                commodityFraction: 100,
                value: alipay.valueNum / alipay.valueDenom,
                quantity: alipay.quantityNum / alipay.quantityDenom,
            },
            {
                accountGuid: 'expense-guid',
                commodityGuid: 'usd-guid',
                commodityMnemonic: 'USD',
                commodityNamespace: 'CURRENCY',
                commodityFraction: 100,
                value: expense.valueNum / expense.valueDenom,
                quantity: expense.quantityNum / expense.quantityDenom,
            },
        ]);

        const tradingSplits = generateTradingSplits(imbalances, new Map([
            ['cny-guid', 'trading-cny-guid'],
            ['usd-guid', 'trading-usd-guid'],
        ]));

        expect(tradingSplits.find(split => split.accountGuid === 'trading-usd-guid')).toMatchObject({
            valueNum: -486,
            valueDenom: 100,
            quantityNum: -486,
            quantityDenom: 100,
        });
    });
});
