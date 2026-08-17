/**
 * Currency Conversion Utilities
 *
 * Functions for handling multi-currency operations, exchange rate lookups,
 * and currency conversions using GnuCash price data.
 */

import prisma from './prisma';
import { toDecimalNumber as toDecimal } from './gnucash';
import { getActiveBookRootGuid } from './book-scope';
import { isPriceStale, priceAgeDays, stalenessDaysFor } from './price-staleness';

/**
 * The bound for a currency pair.
 *
 * Every rate in this module is a quote between two commodities in the CURRENCY
 * namespace, so it is asked for by name rather than left to a default: FX
 * markets close for the weekend like the exchanges do, which is the gap the
 * seven-day bound exists to clear. A crypto pair does not come through here —
 * crypto is a non-CURRENCY commodity priced through `account-valuation.ts`,
 * where the tighter continuous-market bound applies.
 */
const FX_STALENESS_DAYS = stalenessDaysFor('CURRENCY');

export interface ExchangeRate {
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    date: Date;
    source: string | null;
    /**
     * Whole days between `date` and the as-of date the rate was requested for.
     * Zero for a same-currency identity, which has no quote to age.
     */
    ageDays: number;
    /**
     * True when `date` is more than `FX_STALENESS_DAYS` before the as-of date.
     * The rate is still returned and still usable — a conversion the caller can
     * label is better than a conversion it cannot perform — but a caller that
     * renders the converted figure must say the quote is old.
     */
    stale: boolean;
}

export interface Currency {
    guid: string;
    mnemonic: string;
    fullname: string | null;
    fraction: number;
}

/**
 * Get the report currency for a specific book without consulting request
 * session state. Cross-book and API-token workflows must use this helper.
 */
export async function getBaseCurrencyForBook(bookGuid: string): Promise<Currency | null> {
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) return null;

    const rootAccount = await prisma.accounts.findUnique({
        where: { guid: book.root_account_guid },
        select: { commodity: true },
    });
    if (rootAccount?.commodity?.namespace !== 'CURRENCY') return null;
    return {
        guid: rootAccount.commodity.guid,
        mnemonic: rootAccount.commodity.mnemonic,
        fullname: rootAccount.commodity.fullname,
        fraction: rootAccount.commodity.fraction,
    };
}

/**
 * Get the active book's report currency from its root account.
 * Falls back to USD, then the first available currency, when no active book exists.
 */
export async function getBaseCurrency(): Promise<Currency | null> {
    try {
        const rootGuid = await getActiveBookRootGuid();
        const rootAccount = await prisma.accounts.findUnique({
            where: { guid: rootGuid },
            select: {
                commodity: true,
            },
        });

        if (rootAccount?.commodity?.namespace === 'CURRENCY') {
            return {
                guid: rootAccount.commodity.guid,
                mnemonic: rootAccount.commodity.mnemonic,
                fullname: rootAccount.commodity.fullname,
                fraction: rootAccount.commodity.fraction,
            };
        }
    } catch {
        // Non-request contexts may not have a session/book yet; use legacy fallback.
    }

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
 * Age fields for a quote, relative to the date the rate was asked for.
 *
 * Every ExchangeRate is built through this so no return path can quietly omit
 * the age — the omission being the original defect: the lookup selects the
 * newest quote at or before the as-of date and never says how far back that
 * reached, so a rate from three years ago reads exactly like this morning's.
 */
function ageOf(priceDate: Date, asOfDate: Date): { ageDays: number; stale: boolean } {
    return {
        ageDays: priceAgeDays(priceDate, asOfDate),
        stale: isPriceStale(priceDate, asOfDate, FX_STALENESS_DAYS),
    };
}

/**
 * Find the exchange rate between two currencies
 */
export async function findExchangeRate(
    fromGuid: string,
    toGuid: string,
    date?: Date
): Promise<ExchangeRate | null> {
    return findExchangeRateInternal(fromGuid, toGuid, date, true, new Set());
}

/**
 * Internal bounded lookup. Triangulation legs are deliberately direct/inverse
 * only: allowing a USD leg to triangulate through EUR (and vice versa) creates
 * a mutual-recursion loop when neither currency has a stored price.
 */
async function findExchangeRateInternal(
    fromGuid: string,
    toGuid: string,
    date: Date | undefined,
    allowTriangulation: boolean,
    visitedPairs: Set<string>,
): Promise<ExchangeRate | null> {
    const asOfDate = date || new Date();
    const pairKey = `${fromGuid}->${toGuid}`;
    if (visitedPairs.has(pairKey)) return null;
    const nextVisited = new Set(visitedPairs);
    nextVisited.add(pairKey);

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
            // An identity rests on no quote at all, so it can never go stale.
            ageDays: 0,
            stale: false,
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
            ...ageOf(directRate.date, asOfDate),
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
            // Inverting a quote does not refresh it.
            ...ageOf(inverseRate.date, asOfDate),
        };
    }

    if (!allowTriangulation) return null;

    // Try triangulation via USD
    const usd = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic: 'USD' },
    });

    if (usd && usd.guid !== fromGuid && usd.guid !== toGuid) {
        const fromToUsd = await findExchangeRateInternal(
            fromGuid, usd.guid, date, false, nextVisited,
        );
        const usdToTo = await findExchangeRateInternal(
            usd.guid, toGuid, date, false, nextVisited,
        );

        if (
            fromToUsd &&
            usdToTo &&
            !fromToUsd.source?.startsWith('triangulated') &&
            !usdToTo.source?.startsWith('triangulated')
        ) {
            // The product is only as current as its OLDER leg: one fresh leg
            // cannot refresh a rate the other leg quoted months ago.
            const date = fromToUsd.date < usdToTo.date ? fromToUsd.date : usdToTo.date;
            return {
                fromCurrency: fromToUsd.fromCurrency,
                toCurrency: usdToTo.toCurrency,
                rate: fromToUsd.rate * usdToTo.rate,
                date,
                source: 'triangulated:USD',
                ...ageOf(date, asOfDate),
            };
        }
    }

    // Try triangulation via EUR
    const eur = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic: 'EUR' },
    });

    if (eur && eur.guid !== fromGuid && eur.guid !== toGuid) {
        const fromToEur = await findExchangeRateInternal(
            fromGuid, eur.guid, date, false, nextVisited,
        );
        const eurToTo = await findExchangeRateInternal(
            eur.guid, toGuid, date, false, nextVisited,
        );

        if (fromToEur && eurToTo && !fromToEur.source?.startsWith('triangulated') && !eurToTo.source?.startsWith('triangulated')) {
            const date = fromToEur.date < eurToTo.date ? fromToEur.date : eurToTo.date;
            return {
                fromCurrency: fromToEur.fromCurrency,
                toCurrency: eurToTo.toCurrency,
                rate: fromToEur.rate * eurToTo.rate,
                date,
                source: 'triangulated:EUR',
                ...ageOf(date, asOfDate),
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
                ageDays: 0,
                stale: false,
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
