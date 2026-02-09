import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT'];

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
        const startDate = startDateParam
            ? new Date(startDateParam)
            : new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

        const datePoints = generateMonthlyDatePoints(startDate, endDate);

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

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
                value_num: true,
                value_denom: true,
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

        // Compute time series
        const timeSeries = datePoints.map(datePoint => {
            // Sum cash/liability splits up to datePoint
            let assetTotal = 0;
            let liabilityTotal = 0;

            for (const split of cashSplits) {
                const postDate = split.transaction.post_date;
                if (!postDate || postDate > datePoint) continue;

                const value = parseFloat(toDecimal(split.value_num, split.value_denom));

                if (assetSet.has(split.account_guid)) {
                    assetTotal += value;
                } else if (liabilitySet.has(split.account_guid)) {
                    liabilityTotal += value;
                }
            }

            // Sum investment values at datePoint
            // Group shares by account, then value by price
            const sharesByAccount = new Map<string, number>();
            for (const split of investmentSplits) {
                const postDate = split.transaction.post_date;
                if (!postDate || postDate > datePoint) continue;

                const qty = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
                sharesByAccount.set(
                    split.account_guid,
                    (sharesByAccount.get(split.account_guid) || 0) + qty
                );
            }

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
