import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';

/**
 * Build a full path for an account by traversing its parent chain.
 * Uses a pre-fetched account map for efficiency.
 */
function buildAccountPath(
    accountGuid: string,
    accountMap: Map<string, { name: string; parent_guid: string | null }>
): string {
    const segments: string[] = [];
    let currentGuid: string | null = accountGuid;

    while (currentGuid) {
        const acc = accountMap.get(currentGuid);
        if (!acc) break;
        segments.unshift(acc.name);
        currentGuid = acc.parent_guid;
    }

    return segments.join(':');
}

/**
 * Check if an account path contains "Tax" (case-insensitive) in any segment.
 */
function isTaxAccount(path: string): boolean {
    return path.toLowerCase().includes('tax');
}

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        const now = new Date();
        const endDate = endDateParam ? new Date(endDateParam) : now;
        const startDate = await getEffectiveStartDate(startDateParam);

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

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
                commodity_guid: true,
            },
        });

        const accountMap = new Map(
            allAccounts.map(a => [a.guid, { name: a.name, parent_guid: a.parent_guid }])
        );

        // Get non-hidden INCOME and EXPENSE accounts
        const relevantAccounts = allAccounts.filter(
            a => (a.account_type === 'INCOME' || a.account_type === 'EXPENSE') && a.hidden === 0
        );

        const incomeGuids = new Set(
            relevantAccounts.filter(a => a.account_type === 'INCOME').map(a => a.guid)
        );
        const expenseGuids = new Set(
            relevantAccounts.filter(a => a.account_type === 'EXPENSE').map(a => a.guid)
        );

        // Build paths for expense accounts to detect tax accounts
        const taxExpenseGuids = new Set<string>();
        for (const guid of expenseGuids) {
            const path = buildAccountPath(guid, accountMap);
            if (isTaxAccount(path)) {
                taxExpenseGuids.add(guid);
            }
        }

        const allRelevantGuids = [...incomeGuids, ...expenseGuids];

        // Build currency map for income/expense accounts
        const accountCurrencyMap = new Map<string, string>();
        for (const acc of relevantAccounts) {
            if (acc.commodity_guid) {
                accountCurrencyMap.set(acc.guid, acc.commodity_guid);
            }
        }

        // Get base currency and pre-fetch exchange rates
        const baseCurrency = await getBaseCurrency();
        if (!baseCurrency) {
            return NextResponse.json({ error: 'No base currency found' }, { status: 500 });
        }
        const nonBaseCurrencyGuids = new Set<string>();
        for (const currGuid of accountCurrencyMap.values()) {
            if (currGuid !== baseCurrency.guid) {
                nonBaseCurrencyGuids.add(currGuid);
            }
        }

        const exchangeRates = new Map<string, number>();
        for (const currGuid of nonBaseCurrencyGuids) {
            const rate = await findExchangeRate(currGuid, baseCurrency.guid, endDate);
            if (rate) {
                exchangeRates.set(currGuid, rate.rate);
            }
        }

        // Fetch all splits for these accounts within date range
        const splits = await prisma.splits.findMany({
            where: {
                account_guid: {
                    in: allRelevantGuids,
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
                transaction: {
                    select: {
                        post_date: true,
                    },
                },
            },
        });

        // Group by month
        const monthlyData = new Map<
            string,
            { income: number; expenses: number; taxes: number }
        >();

        for (const split of splits) {
            const postDate = split.transaction.post_date;
            if (!postDate) continue;

            const monthKey = `${postDate.getFullYear()}-${String(postDate.getMonth() + 1).padStart(2, '0')}`;
            const entry = monthlyData.get(monthKey) || { income: 0, expenses: 0, taxes: 0 };

            const rawValue = parseFloat(toDecimal(split.value_num, split.value_denom));
            const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
            const rate = (accountCurrGuid && accountCurrGuid !== baseCurrency.guid)
                ? (exchangeRates.get(accountCurrGuid) || 1) : 1;
            const value = rawValue * rate;

            if (incomeGuids.has(split.account_guid)) {
                // Income splits are negative in GnuCash; negate to get positive income
                entry.income += -value;
            } else if (expenseGuids.has(split.account_guid)) {
                // Expense splits are positive in GnuCash
                entry.expenses += value;

                if (taxExpenseGuids.has(split.account_guid)) {
                    entry.taxes += value;
                }
            }

            monthlyData.set(monthKey, entry);
        }

        // Generate all months in range (even if no data)
        const monthly: Array<{
            month: string;
            income: number;
            expenses: number;
            taxes: number;
            netProfit: number;
        }> = [];

        const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

        while (current <= endMonth) {
            const monthKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
            const data = monthlyData.get(monthKey) || { income: 0, expenses: 0, taxes: 0 };

            monthly.push({
                month: monthKey,
                income: Math.round(data.income * 100) / 100,
                expenses: Math.round(data.expenses * 100) / 100,
                taxes: Math.round(data.taxes * 100) / 100,
                netProfit: Math.round((data.income - data.expenses) * 100) / 100,
            });

            current.setMonth(current.getMonth() + 1);
        }

        return NextResponse.json({ monthly });
    } catch (error) {
        console.error('Error fetching income/expense data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch income/expense data' },
            { status: 500 }
        );
    }
}
