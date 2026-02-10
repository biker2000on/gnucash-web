import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, ReportFilters } from './types';
import { toDecimal, buildHierarchy, resolveRootGuid } from './utils';

/**
 * Generate Equity Statement report
 * Shows changes in equity over a period:
 * - Opening Equity (balance before startDate)
 * - Net Income (income - expense for period)
 * - Other Equity Changes (direct equity transactions during period)
 * - Closing Equity (balance at endDate)
 */
export async function generateEquityStatement(filters: ReportFilters): Promise<ReportData> {
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(new Date().getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Determine root GUID from book scoping or fallback
    const rootGuid = await resolveRootGuid(filters.bookAccountGuids);

    // Get all equity, income, and expense accounts
    const equityAccounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: 'EQUITY',
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
        },
    });

    const incomeAccounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: 'INCOME',
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
        },
    });

    const expenseAccounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: 'EXPENSE',
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
        },
    });

    // Calculate opening equity (balance before startDate)
    const openingEquityBalances = await Promise.all(
        equityAccounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: { post_date: { lt: startDate } },
                },
                select: { quantity_num: true, quantity_denom: true },
            });

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            return {
                ...account,
                balance: -balance, // Negate for display (positive = increase in equity)
            };
        })
    );

    // Calculate period income (negated for display)
    const periodIncomeBalances = await Promise.all(
        incomeAccounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: { post_date: { gte: startDate, lte: endDate } },
                },
                select: { quantity_num: true, quantity_denom: true },
            });

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            return {
                ...account,
                balance: -balance, // Negate income (stored as negative/credits)
            };
        })
    );

    // Calculate period expenses
    const periodExpenseBalances = await Promise.all(
        expenseAccounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: { post_date: { gte: startDate, lte: endDate } },
                },
                select: { quantity_num: true, quantity_denom: true },
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

    // Calculate other equity changes (direct equity transactions during period)
    const otherEquityChangesBalances = await Promise.all(
        equityAccounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: { post_date: { gte: startDate, lte: endDate } },
                },
                select: { quantity_num: true, quantity_denom: true },
            });

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            return {
                ...account,
                balance: -balance, // Negate for display
            };
        })
    );

    // Calculate closing equity (balance at endDate)
    const closingEquityBalances = await Promise.all(
        equityAccounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: { post_date: { lte: endDate } },
                },
                select: { quantity_num: true, quantity_denom: true },
            });

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            return {
                ...account,
                balance: -balance, // Negate for display
            };
        })
    );

    // Build hierarchies
    const openingItems = buildHierarchy(openingEquityBalances, rootGuid);
    const otherChangesItems = buildHierarchy(otherEquityChangesBalances, rootGuid);
    const closingItems = buildHierarchy(closingEquityBalances, rootGuid);

    // Calculate net income (income - expense)
    const totalIncome = periodIncomeBalances.reduce((sum, acc) => sum + acc.balance, 0);
    const totalExpense = periodExpenseBalances.reduce((sum, acc) => sum + acc.balance, 0);
    const netIncome = totalIncome - totalExpense;

    // Calculate totals
    const totalOpeningEquity = openingItems.reduce((sum, item) => sum + item.amount, 0);
    const totalOtherChanges = otherChangesItems.reduce((sum, item) => sum + item.amount, 0);
    const totalClosingEquity = closingItems.reduce((sum, item) => sum + item.amount, 0);

    const sections: ReportSection[] = [
        {
            title: 'Opening Equity',
            items: openingItems,
            total: totalOpeningEquity,
        },
        {
            title: 'Net Income',
            items: [
                {
                    guid: 'net-income',
                    name: 'Net Income for Period',
                    amount: netIncome,
                    isTotal: true,
                },
            ],
            total: netIncome,
        },
        {
            title: 'Other Equity Changes',
            items: otherChangesItems,
            total: totalOtherChanges,
        },
        {
            title: 'Closing Equity',
            items: closingItems,
            total: totalClosingEquity,
        },
    ];

    // Validation: Closing Equity should equal Opening + Net Income + Other Changes
    const calculatedClosing = totalOpeningEquity + netIncome + totalOtherChanges;
    const difference = totalClosingEquity - calculatedClosing;

    return {
        type: ReportType.EQUITY_STATEMENT,
        title: 'Equity Statement',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
        grandTotal: difference, // Should be 0 if balanced
    };
}
