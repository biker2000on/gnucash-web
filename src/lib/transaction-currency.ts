/**
 * Parse an account-currency -> transaction-currency exchange rate.
 */
export function parseExchangeRate(rate: string | number | null | undefined): number | null {
    if (rate === null || rate === undefined || rate === '') return null;

    const parsed = typeof rate === 'number' ? rate : Number(rate);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Preserve the source decimal's meaningful precision for an editable amount.
 * The sign is represented by the debit/credit column, so the returned string
 * is always a magnitude.
 */
export function editableDecimalMagnitude(decimal: string | null | undefined): string {
    const trimmed = decimal?.trim();
    if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return '0';

    const unsigned = trimmed.replace(/^[+-]/, '');
    const [integerPart = '0', fractionPart = ''] = unsigned.split('.');
    const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '') || '0';
    const normalizedFraction = fractionPart.replace(/0+$/, '');

    return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

/**
 * Recover the historical account->transaction rate recorded by a split.
 * Editing must use this rate instead of replacing old values with today's quote.
 */
export function deriveRecordedExchangeRate(
    valueDecimal: string | null | undefined,
    quantityDecimal: string | null | undefined,
): string | undefined {
    const value = Number(valueDecimal);
    const quantity = Number(quantityDecimal);
    if (!Number.isFinite(value) || !Number.isFinite(quantity) || quantity === 0) return undefined;

    const rate = Math.abs(value / quantity);
    return Number.isFinite(rate) && rate > 0 ? rate.toString() : undefined;
}

/**
 * Keep the precision already present in a plain decimal when a split input
 * blurs. Math expressions retain the form's historical two-decimal behavior.
 */
export function formatEvaluatedAccountAmount(input: string, result: number): string {
    const plainDecimal = input.trim().match(/^[+-]?\d+(?:\.(\d+))?$/);
    const existingPrecision = plainDecimal?.[1]?.length ?? 0;
    const precision = Math.min(8, Math.max(2, existingPrecision));
    return result.toFixed(precision);
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
    accountFraction: number = 100,
    transactionFraction: number = 100,
): {
    valueNum: number;
    valueDenom: number;
    quantityNum: number;
    quantityDenom: number;
} {
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
        throw new RangeError('Exchange rate must be a positive finite number');
    }
    if (!Number.isInteger(accountFraction) || accountFraction <= 0) {
        throw new RangeError('Account fraction must be a positive integer');
    }
    if (!Number.isInteger(transactionFraction) || transactionFraction <= 0) {
        throw new RangeError('Transaction fraction must be a positive integer');
    }

    const transactionAmount = accountAmount * exchangeRate;

    return {
        valueNum: Math.round(transactionAmount * transactionFraction),
        valueDenom: transactionFraction,
        quantityNum: Math.round(accountAmount * accountFraction),
        quantityDenom: accountFraction,
    };
}
