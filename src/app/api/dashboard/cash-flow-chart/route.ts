import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';
import { requireRole } from '@/lib/auth';

type GroupBy = 'month' | 'quarter' | 'year';

const VALID_GROUP_BYS: GroupBy[] = ['month', 'quarter', 'year'];

/** Bucket key for a date: "YYYY-MM", "YYYY-Qn", or "YYYY". */
function periodKey(year: number, month: number, groupBy: GroupBy): string {
    if (groupBy === 'year') return String(year);
    if (groupBy === 'quarter') return `${year}-Q${Math.floor(month / 3) + 1}`;
    return `${year}-${String(month + 1).padStart(2, '0')}`;
}

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');
        const groupByParam = searchParams.get('groupBy');
        const groupBy: GroupBy = VALID_GROUP_BYS.includes(groupByParam as GroupBy)
            ? (groupByParam as GroupBy)
            : 'month';

        const endDate = endDateParam ? new Date(endDateParam + 'T23:59:59Z') : new Date();

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

        let startDate: Date;
        if (startDateParam) {
            startDate = new Date(startDateParam + 'T00:00:00Z');
        } else {
            startDate = await getEffectiveStartDate(null, bookAccountGuids);
        }

        // Fetch all accounts in active book
        const allAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
            },
            select: {
                guid: true,
                account_type: true,
                hidden: true,
                commodity_guid: true,
            },
        });

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
                quantity_num: true,
                quantity_denom: true,
                transaction: {
                    select: {
                        post_date: true,
                    },
                },
            },
        });

        // Group by period (month/quarter/year)
        const monthlyData = new Map<
            string,
            { income: number; expenses: number }
        >();

        for (const split of splits) {
            const postDate = split.transaction.post_date;
            if (!postDate) continue;

            const monthKey = periodKey(postDate.getUTCFullYear(), postDate.getUTCMonth(), groupBy);
            const entry = monthlyData.get(monthKey) || { income: 0, expenses: 0 };

            const rawValue = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
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
            }

            monthlyData.set(monthKey, entry);
        }

        // Generate all months in range (even if no data)
        const months: string[] = [];
        const income: number[] = [];
        const expenses: number[] = [];
        const netCashFlow: number[] = [];

        const monthStep = groupBy === 'year' ? 12 : groupBy === 'quarter' ? 3 : 1;
        let alignedStartMonth = startDate.getUTCMonth();
        if (groupBy === 'quarter') alignedStartMonth = Math.floor(alignedStartMonth / 3) * 3;
        if (groupBy === 'year') alignedStartMonth = 0;
        const current = new Date(Date.UTC(startDate.getUTCFullYear(), alignedStartMonth, 1));
        const endMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));

        while (current <= endMonth) {
            const monthKey = periodKey(current.getUTCFullYear(), current.getUTCMonth(), groupBy);
            const data = monthlyData.get(monthKey) || { income: 0, expenses: 0 };

            const incomeValue = Math.round(data.income * 100) / 100;
            const expensesValue = -Math.round(data.expenses * 100) / 100;
            const netValue = Math.round((incomeValue + expensesValue) * 100) / 100;

            months.push(monthKey);
            income.push(incomeValue);
            expenses.push(expensesValue);
            netCashFlow.push(netValue);

            current.setUTCMonth(current.getUTCMonth() + monthStep);
        }

        return NextResponse.json({ months, income, expenses, netCashFlow });
    } catch (error) {
        console.error('Error fetching cash flow data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch cash flow data' },
            { status: 500 }
        );
    }
}
