import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { getBaseCurrency } from '@/lib/currency';

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'RECEIVABLE'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];

/**
 * Generate an array of monthly date points between start and end (inclusive).
 * Each date point is the last moment of that month (or end date for the final month).
 */
function generateMonthlyDatePoints(start: Date, end: Date): Date[] {
    const points: Date[] = [];
    const current = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

    while (current <= endMonth) {
        // End of this month
        const endOfMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0, 23, 59, 59, 999);
        // Cap at the end date
        points.push(endOfMonth > end ? new Date(end) : endOfMonth);
        current.setMonth(current.getMonth() + 1);
    }

    return points;
}

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        const now = new Date();
        const endDate = endDateParam ? new Date(endDateParam) : now;
        const startDate = await getEffectiveStartDate(startDateParam);

        const datePoints = generateMonthlyDatePoints(startDate, endDate);

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

        // Fetch base currency for conversions
        const baseCurrency = await getBaseCurrency();

        // Fetch all non-hidden accounts of relevant types in active book
        const accounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
                hidden: 0,
                account_type: {
                    in: [...ASSET_TYPES, ...LIABILITY_TYPES, ...INVESTMENT_TYPES],
                },
            },
            select: {
                guid: true,
                account_type: true,
                commodity_guid: true,
                commodity: {
                    select: {
                        namespace: true,
                    },
                },
            },
        });

        const assetAccountGuids = accounts
            .filter(a => ASSET_TYPES.includes(a.account_type))
            .map(a => a.guid);

        const liabilityAccountGuids = accounts
            .filter(a => LIABILITY_TYPES.includes(a.account_type))
            .map(a => a.guid);

        const investmentAccounts = accounts.filter(
            a => INVESTMENT_TYPES.includes(a.account_type) && a.commodity?.namespace !== 'CURRENCY'
        );
        const investmentAccountGuids = investmentAccounts.map(a => a.guid);

        // Fetch ALL splits for asset + liability accounts (value-based)
        const cashSplits = await prisma.splits.findMany({
            where: {
                account_guid: {
                    in: [...assetAccountGuids, ...liabilityAccountGuids],
                },
            },
            select: {
                account_guid: true,
                quantity_num: true,
                quantity_denom: true,
                transaction: {
                    select: {
                        post_date: true,
                    },
                },
            },
        });

        // Fetch ALL splits for investment accounts (quantity-based for shares)
        const investmentSplits = await prisma.splits.findMany({
            where: {
                account_guid: {
                    in: investmentAccountGuids,
                },
            },
            select: {
                account_guid: true,
                quantity_num: true,
                quantity_denom: true,
                transaction: {
                    select: {
                        post_date: true,
                    },
                },
            },
        });

        // Fetch ALL prices for investment commodities
        const investmentCommodityGuids = [
            ...new Set(
                investmentAccounts
                    .map(a => a.commodity_guid)
                    .filter((g): g is string => g !== null)
            ),
        ];

        const allPrices = await prisma.prices.findMany({
            where: {
                commodity_guid: {
                    in: investmentCommodityGuids,
                },
            },
            select: {
                commodity_guid: true,
                date: true,
                value_num: true,
                value_denom: true,
            },
            orderBy: {
                date: 'desc',
            },
        });

        // Build a map: commodity_guid -> sorted prices (desc by date)
        const priceMap = new Map<string, Array<{ date: Date; value: number }>>();
        for (const p of allPrices) {
            const arr = priceMap.get(p.commodity_guid) || [];
            arr.push({
                date: p.date,
                value: parseFloat(toDecimal(p.value_num, p.value_denom)),
            });
            priceMap.set(p.commodity_guid, arr);
        }

        // Build account -> commodity_guid map for investment accounts
        const accountCommodityMap = new Map<string, string>();
        for (const a of investmentAccounts) {
            if (a.commodity_guid) {
                accountCommodityMap.set(a.guid, a.commodity_guid);
            }
        }

        // Track which account guids are assets vs liabilities
        const assetSet = new Set(assetAccountGuids);
        const liabilitySet = new Set(liabilityAccountGuids);

        // ========== CURRENCY CONVERSION SETUP ==========
        // Build account -> currency guid map for cash/liability accounts
        const accountCurrencyMap = new Map<string, string>();
        for (const a of accounts) {
            if (a.commodity_guid && !INVESTMENT_TYPES.includes(a.account_type)) {
                accountCurrencyMap.set(a.guid, a.commodity_guid);
            }
        }

        // Identify non-base currency GUIDs from cash/liability accounts
        const nonBaseCurrencyGuids = [
            ...new Set(
                [...assetAccountGuids, ...liabilityAccountGuids]
                    .map(guid => accountCurrencyMap.get(guid))
                    .filter((g): g is string => g !== undefined && g !== baseCurrency?.guid)
            ),
        ];

        // Bulk-fetch ALL price records for non-base currencies (for time series conversion)
        const currencyPrices = nonBaseCurrencyGuids.length > 0 && baseCurrency
            ? await prisma.prices.findMany({
                where: {
                    commodity_guid: { in: nonBaseCurrencyGuids },
                    currency_guid: baseCurrency.guid,
                },
                select: {
                    commodity_guid: true,
                    date: true,
                    value_num: true,
                    value_denom: true,
                },
                orderBy: { date: 'desc' },
            })
            : [];

        // Build sorted map: currency_guid -> Array<{date, rate}> (sorted desc by date)
        const currencyRateMap = new Map<string, Array<{ date: Date; rate: number }>>();
        for (const p of currencyPrices) {
            const arr = currencyRateMap.get(p.commodity_guid) || [];
            arr.push({
                date: p.date,
                rate: parseFloat(toDecimal(p.value_num, p.value_denom)),
            });
            currencyRateMap.set(p.commodity_guid, arr);
        }

        // Also check for inverse rates (currency_guid=non-base, commodity_guid=base)
        const inverseCurrencyPrices = nonBaseCurrencyGuids.length > 0 && baseCurrency
            ? await prisma.prices.findMany({
                where: {
                    commodity_guid: baseCurrency.guid,
                    currency_guid: { in: nonBaseCurrencyGuids },
                },
                select: {
                    currency_guid: true,
                    date: true,
                    value_num: true,
                    value_denom: true,
                },
                orderBy: { date: 'desc' },
            })
            : [];

        // Add inverse rates to the map (only if no direct rate exists for that currency yet at that date)
        for (const p of inverseCurrencyPrices) {
            if (!p.currency_guid) continue;
            const directRates = currencyRateMap.get(p.currency_guid);
            const inverseRate = parseFloat(toDecimal(p.value_num, p.value_denom));
            if (inverseRate === 0) continue;
            const rate = 1 / inverseRate;
            if (!directRates || directRates.length === 0) {
                const arr = currencyRateMap.get(p.currency_guid) || [];
                arr.push({ date: p.date, rate });
                currencyRateMap.set(p.currency_guid, arr);
            } else {
                // Only add if no direct rate exists for this exact date
                const hasDirectAtDate = directRates.some(
                    dr => dr.date.getTime() === p.date.getTime()
                );
                if (!hasDirectAtDate) {
                    directRates.push({ date: p.date, rate });
                }
            }
        }

        // Re-sort all rate arrays desc by date after adding inverse rates
        for (const [, rates] of currencyRateMap) {
            rates.sort((a, b) => b.date.getTime() - a.date.getTime());
        }

        // Log debug info for currencies with no rates at all
        for (const currGuid of nonBaseCurrencyGuids) {
            const rates = currencyRateMap.get(currGuid);
            if (!rates || rates.length === 0) {
                console.debug(`No exchange rate records found for currency ${currGuid}, will use fallback rate of 1`);
            }
        }

        // Helper: find latest currency rate on or before a date
        function getCurrencyRateAsOf(currencyGuid: string, asOf: Date): number {
            const rates = currencyRateMap.get(currencyGuid);
            if (!rates || rates.length === 0) return 1; // fallback
            // rates are sorted desc by date
            for (const r of rates) {
                if (r.date <= asOf) return r.rate;
            }
            // If all rates are after asOf, use the oldest available rate
            return rates[rates.length - 1].rate;
        }

        // Helper: find latest price for commodity on or before a date
        function getLatestPriceAsOf(commodityGuid: string, asOf: Date): number {
            const prices = priceMap.get(commodityGuid);
            if (!prices || prices.length === 0) return 0;
            // prices are sorted desc by date
            for (const p of prices) {
                if (p.date <= asOf) {
                    return p.value;
                }
            }
            return 0;
        }

        // Compute time series using a pointer-based running-total approach.
        // Instead of O(datePoints * totalSplits), this is O(totalSplits + datePoints * foreignCurrencies).
        //
        // Strategy:
        // - Pre-sort splits by post_date ascending, pre-compute raw values
        // - For base-currency cash splits: accumulate running asset/liability totals with a pointer
        // - For foreign-currency cash splits: accumulate running raw totals per currency,
        //   then multiply by exchange rate at each datePoint
        // - For investment splits: accumulate running share counts per account with a pointer,
        //   then multiply by price at each datePoint

        // Pre-process and sort cash splits by post_date ascending
        type ProcessedCashSplit = {
            postDate: Date;
            rawValue: number;
            accountGuid: string;
            isAsset: boolean;
            isLiability: boolean;
            currencyGuid: string | undefined;
            isBaseCurrency: boolean;
        };

        const processedCashSplits: ProcessedCashSplit[] = [];
        for (const split of cashSplits) {
            const postDate = split.transaction.post_date;
            if (!postDate) continue;
            const rawValue = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
            const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
            const isBase = !accountCurrGuid || !baseCurrency || accountCurrGuid === baseCurrency.guid;
            processedCashSplits.push({
                postDate,
                rawValue,
                accountGuid: split.account_guid,
                isAsset: assetSet.has(split.account_guid),
                isLiability: liabilitySet.has(split.account_guid),
                currencyGuid: accountCurrGuid,
                isBaseCurrency: isBase,
            });
        }
        processedCashSplits.sort((a, b) => a.postDate.getTime() - b.postDate.getTime());

        // Pre-process and sort investment splits by post_date ascending
        type ProcessedInvestmentSplit = {
            postDate: Date;
            qty: number;
            accountGuid: string;
        };

        const processedInvestmentSplits: ProcessedInvestmentSplit[] = [];
        for (const split of investmentSplits) {
            const postDate = split.transaction.post_date;
            if (!postDate) continue;
            const qty = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
            processedInvestmentSplits.push({
                postDate,
                qty,
                accountGuid: split.account_guid,
            });
        }
        processedInvestmentSplits.sort((a, b) => a.postDate.getTime() - b.postDate.getTime());

        // Collect the set of foreign currencies that appear in cash/liability accounts
        const foreignCurrencyGuids = new Set<string>();
        for (const s of processedCashSplits) {
            if (!s.isBaseCurrency && s.currencyGuid) {
                foreignCurrencyGuids.add(s.currencyGuid);
            }
        }

        // Running state for pointer-based accumulation
        let cashPointer = 0;
        let baseCurrAssetTotal = 0;
        let baseCurrLiabilityTotal = 0;
        // For foreign currencies: track raw running totals split by asset/liability
        const foreignAssetRaw = new Map<string, number>(); // currencyGuid -> raw total
        const foreignLiabilityRaw = new Map<string, number>();

        let investPointer = 0;
        const sharesByAccount = new Map<string, number>(); // accountGuid -> running shares

        const timeSeries = datePoints.map(datePoint => {
            // Advance cash pointer: accumulate all splits with postDate <= datePoint
            while (cashPointer < processedCashSplits.length) {
                const split = processedCashSplits[cashPointer];
                if (split.postDate > datePoint) break;

                if (split.isBaseCurrency) {
                    // Base-currency split: accumulate directly
                    if (split.isAsset) {
                        baseCurrAssetTotal += split.rawValue;
                    } else if (split.isLiability) {
                        baseCurrLiabilityTotal += split.rawValue;
                    }
                } else if (split.currencyGuid) {
                    // Foreign-currency split: accumulate raw value per currency
                    if (split.isAsset) {
                        foreignAssetRaw.set(
                            split.currencyGuid,
                            (foreignAssetRaw.get(split.currencyGuid) || 0) + split.rawValue
                        );
                    } else if (split.isLiability) {
                        foreignLiabilityRaw.set(
                            split.currencyGuid,
                            (foreignLiabilityRaw.get(split.currencyGuid) || 0) + split.rawValue
                        );
                    }
                }
                cashPointer++;
            }

            // Compute asset/liability totals: base currency + foreign currency * rate at datePoint
            let assetTotal = baseCurrAssetTotal;
            let liabilityTotal = baseCurrLiabilityTotal;

            for (const currGuid of foreignCurrencyGuids) {
                const rate = getCurrencyRateAsOf(currGuid, datePoint);
                const assetRaw = foreignAssetRaw.get(currGuid) || 0;
                const liabRaw = foreignLiabilityRaw.get(currGuid) || 0;
                if (assetRaw !== 0) assetTotal += assetRaw * rate;
                if (liabRaw !== 0) liabilityTotal += liabRaw * rate;
            }

            // Advance investment pointer: accumulate shares for splits with postDate <= datePoint
            while (investPointer < processedInvestmentSplits.length) {
                const split = processedInvestmentSplits[investPointer];
                if (split.postDate > datePoint) break;

                sharesByAccount.set(
                    split.accountGuid,
                    (sharesByAccount.get(split.accountGuid) || 0) + split.qty
                );
                investPointer++;
            }

            // Compute investment value from accumulated shares * price at datePoint
            let investmentValue = 0;
            for (const [accountGuid, shares] of sharesByAccount) {
                const commodityGuid = accountCommodityMap.get(accountGuid);
                if (!commodityGuid) continue;
                const price = getLatestPriceAsOf(commodityGuid, datePoint);
                investmentValue += shares * price;
            }

            const assets = assetTotal + investmentValue;
            // liabilities are naturally negative in GnuCash
            const liabilities = liabilityTotal;
            const netWorth = assets + liabilities;

            return {
                date: datePoint.toISOString().split('T')[0],
                netWorth: Math.round(netWorth * 100) / 100,
                assets: Math.round(assets * 100) / 100,
                liabilities: Math.round(liabilities * 100) / 100,
            };
        });

        return NextResponse.json({ timeSeries });
    } catch (error) {
        console.error('Error fetching net worth data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch net worth data' },
            { status: 500 }
        );
    }
}
