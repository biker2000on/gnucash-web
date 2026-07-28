import { toNumDenom } from '@/lib/validation';

/**
 * Parse an account-currency -> transaction-currency exchange rate.
 */
export function parseExchangeRate(rate: string | number | null | undefined): number | null {
    if (rate === null || rate === undefined || rate === '') return null;

    const parsed = typeof rate === 'number' ? rate : Number(rate);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Convert an amount entered in an account's native commodity into GnuCash's
 * split quantity/value pair.
 *
 * Quantity is always the entered account amount. Value is denominated in the
 * transaction currency, so an account->transaction rate multiplies quantity.
 */
export function buildCurrencySplitAmounts(
    accountAmount: number,
    exchangeRate: number = 1,
): {
    valueNum: number;
    valueDenom: number;
    quantityNum: number;
    quantityDenom: number;
} {
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
        throw new RangeError('Exchange rate must be a positive finite number');
    }

    const transactionAmount = accountAmount * exchangeRate;
    const { num: valueNum, denom: valueDenom } = toNumDenom(transactionAmount);
    const { num: quantityNum, denom: quantityDenom } = toNumDenom(accountAmount);

    return {
        valueNum,
        valueDenom,
        quantityNum,
        quantityDenom,
    };
}

