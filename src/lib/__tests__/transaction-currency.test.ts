import { describe, expect, it } from 'vitest';
import {
    buildCurrencySplitAmounts,
    deriveRecordedExchangeRate,
    editableDecimalMagnitude,
    formatEvaluatedAccountAmount,
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

    it('does not invert USD quantities and CNY values in a CNY transaction', () => {
        const usdTransfer = buildCurrencySplitAmounts(-240.62, 6.8702);
        const expense = buildCurrencySplitAmounts(82.96, 6.8702);
        const usdTrading = buildCurrencySplitAmounts(157.66, 6.8702);

        expect(usdTransfer).toMatchObject({
            valueNum: -165311,
            quantityNum: -24062,
        });
        expect(expense).toMatchObject({
            valueNum: 56995,
            quantityNum: 8296,
        });
        expect(usdTrading).toMatchObject({
            valueNum: 108316,
            quantityNum: 15766,
        });

        expect(
            usdTransfer.valueNum + expense.valueNum + usdTrading.valueNum,
        ).toBe(0);
        expect(
            usdTransfer.quantityNum + expense.quantityNum + usdTrading.quantityNum,
        ).toBe(0);
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

    it('preserves investment precision and the recorded historical rate when editing', () => {
        expect(editableDecimalMagnitude('-0.25600000000000000000')).toBe('0.256');
        expect(formatEvaluatedAccountAmount('0.256', 0.256)).toBe('0.256');
        expect(deriveRecordedExchangeRate('-13.3300000000000000', '-0.2560000000000000'))
            .toBe('52.0703125');

        expect(buildCurrencySplitAmounts(-0.256, 52.0703125, 10_000)).toEqual({
            valueNum: -1333,
            valueDenom: 100,
            quantityNum: -2560,
            quantityDenom: 10_000,
        });
    });

    it('preserves six-decimal cryptocurrency quantities', () => {
        expect(editableDecimalMagnitude('299.92500000000000000000')).toBe('299.925');
        expect(buildCurrencySplitAmounts(299.925, 1, 1_000_000)).toEqual({
            valueNum: 29993,
            valueDenom: 100,
            quantityNum: 299925000,
            quantityDenom: 1_000_000,
        });
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
