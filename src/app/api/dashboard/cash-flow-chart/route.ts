import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;
        const periodParam = searchParams.get('period') || '1Y';

        const now = new Date();
        const endDate = now;

        let startDate: Date;
        switch (periodParam) {
            case '6M':
                startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
                break;
            case '2Y':
                startDate = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1));
                break;
            case 'ALL':
                startDate = await getEffectiveStartDate(null);
                break;
            case '1Y':
            default:
                startDate = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
                break;
        }

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

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

        // Group by month
        const monthlyData = new Map<
            string,
            { income: number; expenses: number }
        >();

        for (const split of splits) {
            const postDate = split.transaction.post_date;
            if (!postDate) continue;

            const monthKey = `${postDate.getUTCFullYear()}-${String(postDate.getUTCMonth() + 1).padStart(2, '0')}`;
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

        const current = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
        const endMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));

        while (current <= endMonth) {
            const monthKey = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`;
            const data = monthlyData.get(monthKey) || { income: 0, expenses: 0 };

            const incomeValue = Math.round(data.income * 100) / 100;
            const expensesValue = Math.round(data.expenses * 100) / 100;
            const netValue = Math.round((incomeValue - expensesValue) * 100) / 100;

            months.push(monthKey);
            income.push(incomeValue);
            expenses.push(expensesValue);
            netCashFlow.push(netValue);

            current.setUTCMonth(current.getUTCMonth() + 1);
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
