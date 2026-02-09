import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, LineItem, ReportFilters } from './types';

interface AccountWithBalance {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
    balance: number;
    previousBalance?: number;
}

/**
 * Convert GnuCash fraction to decimal number
 */
function toDecimal(num: bigint | null, denom: bigint | null): number {
    if (num === null || denom === null || denom === 0n) return 0;
    return Number(num) / Number(denom);
}

/**
 * Build hierarchical line items from flat account list
 */
function buildHierarchy(accounts: AccountWithBalance[], parentGuid: string | null = null, depth = 0): LineItem[] {
    const children = accounts.filter(a => a.parent_guid === parentGuid);

    return children.map(account => {
        const childItems = buildHierarchy(accounts, account.guid, depth + 1);
        const childrenTotal = childItems.reduce((sum, item) => sum + item.amount, 0);

        return {
            guid: account.guid,
            name: account.name,
            amount: account.balance + childrenTotal,
            previousAmount: account.previousBalance !== undefined
                ? account.previousBalance + childItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0)
                : undefined,
            children: childItems.length > 0 ? childItems : undefined,
            depth,
        };
    });
}

/**
 * Get account balances for a date range
 */
async function getAccountBalances(
    accounts: { guid: string; name: string; account_type: string; parent_guid: string | null }[],
    startDate: Date,
    endDate: Date
): Promise<AccountWithBalance[]> {
    return Promise.all(
        accounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: {
                            gte: startDate,
                            lte: endDate,
                        },
                    },
                },
                select: {
                    quantity_num: true,
                    quantity_denom: true,
                },
            });

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            return {
                ...account,
                balance,
            };
        })
    );
}

/**
 * Generate Income Statement (Profit & Loss) report
 */
export async function generateIncomeStatement(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    // Determine root GUID from book scoping or fallback
    let rootGuid: string | null = null;
    if (filters.bookAccountGuids && filters.bookAccountGuids.length > 0) {
        const rootAccount = await prisma.accounts.findFirst({
            where: {
                guid: { in: filters.bookAccountGuids },
                account_type: 'ROOT',
            },
            select: { guid: true }
        });
        rootGuid = rootAccount?.guid || null;
    } else {
        const rootAccount = await prisma.accounts.findFirst({
            where: {
                account_type: 'ROOT',
                name: { startsWith: 'Root' }
            },
            select: { guid: true }
        });
        rootGuid = rootAccount?.guid || null;
    }

    // Get all income and expense accounts
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: {
                in: ['INCOME', 'EXPENSE'],
            },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
        },
    });

    // Get balances for current period
    const accountBalances = await getAccountBalances(accounts, startDate, endDate);

    // Get balances for previous period if comparison is enabled
    let previousAccountBalances: AccountWithBalance[] = [];
    if (filters.compareToPrevious) {
        const periodLength = endDate.getTime() - startDate.getTime();
        const previousStartDate = new Date(startDate.getTime() - periodLength);
        const previousEndDate = new Date(startDate.getTime() - 1);
        previousAccountBalances = await getAccountBalances(accounts, previousStartDate, previousEndDate);

        // Merge previous balances
        accountBalances.forEach(account => {
            const prev = previousAccountBalances.find(p => p.guid === account.guid);
            if (prev) {
                account.previousBalance = prev.balance;
            }
        });
    }

    // Separate income and expenses
    const incomeAccounts = accountBalances.filter(a => a.account_type === 'INCOME');
    const expenseAccounts = accountBalances.filter(a => a.account_type === 'EXPENSE');

    // Build hierarchies - income is typically negative in GnuCash, so we negate it
    const incomeItems = buildHierarchy(incomeAccounts, rootGuid).map(item => ({
        ...item,
        amount: -item.amount, // Negate income to show as positive
        previousAmount: item.previousAmount !== undefined ? -item.previousAmount : undefined,
    }));
    const expenseItems = buildHierarchy(expenseAccounts, rootGuid);

    // Calculate totals
    const totalIncome = incomeItems.reduce((sum, item) => sum + item.amount, 0);
    const totalExpenses = expenseItems.reduce((sum, item) => sum + item.amount, 0);
    const netIncome = totalIncome - totalExpenses;

    const previousTotalIncome = filters.compareToPrevious
        ? incomeItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0)
        : undefined;
    const previousTotalExpenses = filters.compareToPrevious
        ? expenseItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0)
        : undefined;

    const sections: ReportSection[] = [
        {
            title: 'Income',
            items: incomeItems,
            total: totalIncome,
            previousTotal: previousTotalIncome,
        },
        {
            title: 'Expenses',
            items: expenseItems,
            total: totalExpenses,
            previousTotal: previousTotalExpenses,
        },
    ];

    return {
        type: ReportType.INCOME_STATEMENT,
        title: 'Income Statement',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
        grandTotal: netIncome,
        previousGrandTotal: previousTotalIncome !== undefined && previousTotalExpenses !== undefined
            ? previousTotalIncome - previousTotalExpenses
            : undefined,
    };
}
