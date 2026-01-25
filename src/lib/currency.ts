/**
 * Currency Conversion Utilities
 *
 * Functions for handling multi-currency operations, exchange rate lookups,
 * and currency conversions using GnuCash price data.
 */

import prisma from './prisma';
import { toDecimal as toDecimalString } from './gnucash';

function toDecimal(num: bigint | number | string | null, denom: bigint | number | string | null): number {
    if (num === null || denom === null) return 0;
    return parseFloat(toDecimalString(num, denom));
}

export interface ExchangeRate {
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    date: Date;
    source: string | null;
}

export interface Currency {
    guid: string;
    mnemonic: string;
    fullname: string | null;
    fraction: number;
}

/**
 * Get the base currency (first CURRENCY commodity, typically from the root account)
 */
export async function getBaseCurrency(): Promise<Currency | null> {
    // Try to find USD first, then any other currency
    const usd = await prisma.commodities.findFirst({
        where: {
            namespace: 'CURRENCY',
            mnemonic: 'USD',
        },
    });

    if (usd) {
        return {
            guid: usd.guid,
            mnemonic: usd.mnemonic,
            fullname: usd.fullname,
            fraction: usd.fraction,
        };
    }

    // Fall back to first currency found
    const currency = await prisma.commodities.findFirst({
        where: {
            namespace: 'CURRENCY',
        },
        orderBy: { mnemonic: 'asc' },
    });

    if (!currency) return null;

    return {
        guid: currency.guid,
        mnemonic: currency.mnemonic,
        fullname: currency.fullname,
        fraction: currency.fraction,
    };
}

/**
 * Get all currencies in use
 */
export async function getAllCurrencies(): Promise<Currency[]> {
    const currencies = await prisma.commodities.findMany({
        where: {
            namespace: 'CURRENCY',
        },
        orderBy: { mnemonic: 'asc' },
    });

    return currencies.map(c => ({
        guid: c.guid,
        mnemonic: c.mnemonic,
        fullname: c.fullname,
        fraction: c.fraction,
    }));
}

/**
 * Find the exchange rate between two currencies
 */
export async function findExchangeRate(
    fromGuid: string,
    toGuid: string,
    date?: Date
): Promise<ExchangeRate | null> {
    const asOfDate = date || new Date();

    // Same currency
    if (fromGuid === toGuid) {
        const currency = await prisma.commodities.findUnique({
            where: { guid: fromGuid },
        });
        return {
            fromCurrency: currency?.mnemonic || '',
            toCurrency: currency?.mnemonic || '',
            rate: 1.0,
            date: asOfDate,
            source: 'same-currency',
        };
    }

    // Try direct rate
    const directRate = await prisma.prices.findFirst({
        where: {
            commodity_guid: fromGuid,
            currency_guid: toGuid,
            date: { lte: asOfDate },
        },
        orderBy: { date: 'desc' },
        include: {
            commodity: true,
            currency: true,
        },
    });

    if (directRate) {
        return {
            fromCurrency: directRate.commodity.mnemonic,
            toCurrency: directRate.currency.mnemonic,
            rate: toDecimal(directRate.value_num, directRate.value_denom),
            date: directRate.date,
            source: directRate.source,
        };
    }

    // Try inverse rate
    const inverseRate = await prisma.prices.findFirst({
        where: {
            commodity_guid: toGuid,
            currency_guid: fromGuid,
            date: { lte: asOfDate },
        },
        orderBy: { date: 'desc' },
        include: {
            commodity: true,
            currency: true,
        },
    });

    if (inverseRate) {
        const rate = toDecimal(inverseRate.value_num, inverseRate.value_denom);
        return {
            fromCurrency: inverseRate.currency.mnemonic,
            toCurrency: inverseRate.commodity.mnemonic,
            rate: rate !== 0 ? 1 / rate : 0,
            date: inverseRate.date,
            source: `inverse:${inverseRate.source}`,
        };
    }

    // Try triangulation via USD
    const usd = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic: 'USD' },
    });

    if (usd && usd.guid !== fromGuid && usd.guid !== toGuid) {
        const fromToUsd = await findExchangeRate(fromGuid, usd.guid, date);
        const usdToTo = await findExchangeRate(usd.guid, toGuid, date);

        if (fromToUsd && usdToTo && fromToUsd.source !== 'triangulated' && usdToTo.source !== 'triangulated') {
            return {
                fromCurrency: fromToUsd.fromCurrency,
                toCurrency: usdToTo.toCurrency,
                rate: fromToUsd.rate * usdToTo.rate,
                date: fromToUsd.date < usdToTo.date ? fromToUsd.date : usdToTo.date,
                source: 'triangulated:USD',
            };
        }
    }

    // Try triangulation via EUR
    const eur = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic: 'EUR' },
    });

    if (eur && eur.guid !== fromGuid && eur.guid !== toGuid) {
        const fromToEur = await findExchangeRate(fromGuid, eur.guid, date);
        const eurToTo = await findExchangeRate(eur.guid, toGuid, date);

        if (fromToEur && eurToTo && !fromToEur.source?.startsWith('triangulated') && !eurToTo.source?.startsWith('triangulated')) {
            return {
                fromCurrency: fromToEur.fromCurrency,
                toCurrency: eurToTo.toCurrency,
                rate: fromToEur.rate * eurToTo.rate,
                date: fromToEur.date < eurToTo.date ? fromToEur.date : eurToTo.date,
                source: 'triangulated:EUR',
            };
        }
    }

    return null;
}

/**
 * Convert an amount from one currency to another
 */
export async function convertAmount(
    amount: number,
    fromGuid: string,
    toGuid: string,
    date?: Date
): Promise<{ amount: number; rate: ExchangeRate } | null> {
    if (fromGuid === toGuid) {
        const currency = await prisma.commodities.findUnique({
            where: { guid: fromGuid },
        });
        return {
            amount,
            rate: {
                fromCurrency: currency?.mnemonic || '',
                toCurrency: currency?.mnemonic || '',
                rate: 1.0,
                date: date || new Date(),
                source: 'same-currency',
            },
        };
    }

    const rate = await findExchangeRate(fromGuid, toGuid, date);
    if (!rate) return null;

    return {
        amount: amount * rate.rate,
        rate,
    };
}

/**
 * Get all exchange rates for a base currency
 */
export async function getAllExchangeRates(baseCurrencyGuid: string): Promise<ExchangeRate[]> {
    const currencies = await getAllCurrencies();
    const rates: ExchangeRate[] = [];

    for (const currency of currencies) {
        if (currency.guid === baseCurrencyGuid) continue;

        const rate = await findExchangeRate(currency.guid, baseCurrencyGuid);
        if (rate) {
            rates.push(rate);
        }
    }

    return rates;
}

/**
 * Get currency by mnemonic (e.g., "USD", "EUR")
 */
export async function getCurrencyByMnemonic(mnemonic: string): Promise<Currency | null> {
    const currency = await prisma.commodities.findFirst({
        where: {
            namespace: 'CURRENCY',
            mnemonic: mnemonic.toUpperCase(),
        },
    });

    if (!currency) return null;

    return {
        guid: currency.guid,
        mnemonic: currency.mnemonic,
        fullname: currency.fullname,
        fraction: currency.fraction,
    };
}
