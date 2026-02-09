import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT'];

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

        // ========== NET WORTH CALCULATION ==========

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

        // Fetch splits for asset + liability accounts
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

        // Fetch investment splits
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

        // Fetch all prices for investment commodities
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

        // Build price lookup
        const priceMap = new Map<string, Array<{ date: Date; value: number }>>();
        for (const p of allPrices) {
            const arr = priceMap.get(p.commodity_guid) || [];
            arr.push({
                date: p.date,
                value: parseFloat(toDecimal(p.value_num, p.value_denom)),
            });
            priceMap.set(p.commodity_guid, arr);
        }

        const accountCommodityMap = new Map<string, string>();
        for (const a of investmentAccounts) {
            if (a.commodity_guid) {
                accountCommodityMap.set(a.guid, a.commodity_guid);
            }
        }

        const assetSet = new Set(assetAccountGuids);
        const liabilitySet = new Set(liabilityAccountGuids);

        function getLatestPriceAsOf(commodityGuid: string, asOf: Date): number {
            const prices = priceMap.get(commodityGuid);
            if (!prices || prices.length === 0) return 0;
            for (const p of prices) {
                if (p.date <= asOf) return p.value;
            }
            return 0;
        }

        function computeNetWorthAtDate(asOf: Date): { assets: number; liabilities: number; investmentValue: number } {
            let assetTotal = 0;
            let liabilityTotal = 0;

            for (const split of cashSplits) {
                const postDate = split.transaction.post_date;
                if (!postDate || postDate > asOf) continue;
                const value = parseFloat(toDecimal(split.value_num, split.value_denom));
                if (assetSet.has(split.account_guid)) {
                    assetTotal += value;
                } else if (liabilitySet.has(split.account_guid)) {
                    liabilityTotal += value;
                }
            }

            const sharesByAccount = new Map<string, number>();
            for (const split of investmentSplits) {
                const postDate = split.transaction.post_date;
                if (!postDate || postDate > asOf) continue;
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
                const price = getLatestPriceAsOf(commodityGuid, asOf);
                investmentValue += shares * price;
            }

            return { assets: assetTotal, liabilities: liabilityTotal, investmentValue };
        }

        const endNW = computeNetWorthAtDate(endDate);
        const startNW = computeNetWorthAtDate(startDate);

        const netWorthEnd = endNW.assets + endNW.investmentValue + endNW.liabilities;
        const netWorthStart = startNW.assets + startNW.investmentValue + startNW.liabilities;
        const netWorthChange = netWorthEnd - netWorthStart;
        const netWorthChangePercent = netWorthStart !== 0
            ? (netWorthChange / Math.abs(netWorthStart)) * 100
            : 0;

        // ========== INCOME / EXPENSE CALCULATION ==========

        // Fetch all accounts in active book for path building
        const allAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
            },
            select: {
                guid: true,
                name: true,
                account_type: true,
                parent_guid: true,
                hidden: true,
            },
        });

        const accountNameMap = new Map(
            allAccounts.map(a => [a.guid, { name: a.name, parent_guid: a.parent_guid }])
        );

        const incomeAccounts = allAccounts.filter(
            a => a.account_type === 'INCOME' && a.hidden === 0
        );
        const expenseAccounts = allAccounts.filter(
            a => a.account_type === 'EXPENSE' && a.hidden === 0
        );

        const incomeGuids = new Set(incomeAccounts.map(a => a.guid));
        const expenseGuids = new Set(expenseAccounts.map(a => a.guid));

        // Fetch income/expense splits within date range
        const iesplits = await prisma.splits.findMany({
            where: {
                account_guid: {
                    in: [...incomeGuids, ...expenseGuids],
                },
                transaction: {
                    post_date: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
            },
            select: {
                account_guid: true,
                value_num: true,
                value_denom: true,
            },
        });

        let totalIncome = 0;
        let totalExpenses = 0;
        const expenseByAccount = new Map<string, number>();

        for (const split of iesplits) {
            const value = parseFloat(toDecimal(split.value_num, split.value_denom));

            if (incomeGuids.has(split.account_guid)) {
                totalIncome += -value; // negate: income is negative in GnuCash
            } else if (expenseGuids.has(split.account_guid)) {
                totalExpenses += value;
                expenseByAccount.set(
                    split.account_guid,
                    (expenseByAccount.get(split.account_guid) || 0) + value
                );
            }
        }

        // Find top expense category (by top-level expense account)
        // Group expenses by their immediate parent under the Expense root
        const rootAccount = allAccounts.find(
            a => a.account_type === 'ROOT' && !a.name.toLowerCase().includes('template')
        );
        const expenseRoot = rootAccount
            ? allAccounts.find(
                a => a.account_type === 'EXPENSE' && a.parent_guid === rootAccount.guid
            )
            : null;

        // Build parent chain to find the top-level category for each expense account
        function getTopLevelCategory(accountGuid: string): string | null {
            if (!expenseRoot) return null;
            let currentGuid: string | null = accountGuid;
            let lastBeforeRoot = accountGuid;

            while (currentGuid) {
                const acc = accountNameMap.get(currentGuid);
                if (!acc) break;
                if (acc.parent_guid === expenseRoot.guid) {
                    return acc.name;
                }
                if (currentGuid === expenseRoot.guid) {
                    // This is the expense root itself
                    const directAcc = accountNameMap.get(lastBeforeRoot);
                    return directAcc?.name || null;
                }
                lastBeforeRoot = currentGuid;
                currentGuid = acc.parent_guid;
            }
            return null;
        }

        const categoryTotals = new Map<string, number>();
        for (const [accountGuid, amount] of expenseByAccount) {
            const category = getTopLevelCategory(accountGuid) || 'Other';
            categoryTotals.set(category, (categoryTotals.get(category) || 0) + amount);
        }

        let topExpenseCategory = '';
        let topExpenseAmount = 0;
        for (const [category, amount] of categoryTotals) {
            if (amount > topExpenseAmount) {
                topExpenseAmount = amount;
                topExpenseCategory = category;
            }
        }

        // Savings rate
        const savingsRate = totalIncome > 0
            ? ((totalIncome - totalExpenses) / totalIncome) * 100
            : 0;

        return NextResponse.json({
            netWorth: Math.round(netWorthEnd * 100) / 100,
            netWorthChange: Math.round(netWorthChange * 100) / 100,
            netWorthChangePercent: Math.round(netWorthChangePercent * 100) / 100,
            totalIncome: Math.round(totalIncome * 100) / 100,
            totalExpenses: Math.round(totalExpenses * 100) / 100,
            savingsRate: Math.round(savingsRate * 100) / 100,
            topExpenseCategory,
            topExpenseAmount: Math.round(topExpenseAmount * 100) / 100,
            investmentValue: Math.round(endNW.investmentValue * 100) / 100,
        });
    } catch (error) {
        console.error('Error fetching KPI data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch KPI data' },
            { status: 500 }
        );
    }
}
