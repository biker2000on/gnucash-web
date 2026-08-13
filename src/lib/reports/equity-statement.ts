import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, ReportFilters, LineItem } from './types';
import { buildHierarchy, numericToNumber, resolveRootGuid, sumSplitsByAccount, ZERO_NUMERIC } from './utils';

/**
 * Generate Equity Statement report
 * Shows changes in equity over a period:
 * - Opening Equity (balance before startDate)
 * - Net Income (income - expense for period)
 * - Other Equity Changes (direct equity transactions during period)
 * - Closing Equity (balance at endDate)
 */
export async function generateEquityStatement(filters: ReportFilters): Promise<ReportData> {
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
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

    // One grouped pass over equity splits computes opening (< startDate),
    // period (startDate..endDate) and closing (<= endDate) sums per account
    // via FILTER clauses. The outer WHERE is the union of all three windows.
    const equityGuids = equityAccounts.map(a => a.guid);
    const equityRows = equityGuids.length > 0
        ? await prisma.$queryRaw<Array<{
            account_guid: string;
            opening_sum: number;
            period_sum: number;
            closing_sum: number;
        }>>`
            SELECT s.account_guid,
                   COALESCE(SUM(s.quantity_num::float8 / NULLIF(s.quantity_denom, 0)::float8)
                       FILTER (WHERE t.post_date < ${startDate}), 0)::float8 AS opening_sum,
                   COALESCE(SUM(s.quantity_num::float8 / NULLIF(s.quantity_denom, 0)::float8)
                       FILTER (WHERE t.post_date >= ${startDate} AND t.post_date <= ${endDate}), 0)::float8 AS period_sum,
                   COALESCE(SUM(s.quantity_num::float8 / NULLIF(s.quantity_denom, 0)::float8)
                       FILTER (WHERE t.post_date <= ${endDate}), 0)::float8 AS closing_sum
            FROM splits s
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE s.account_guid = ANY(${equityGuids}::text[])
              AND (t.post_date < ${startDate} OR t.post_date <= ${endDate})
            GROUP BY s.account_guid
        `
        : [];
    const equitySumsByGuid = new Map(equityRows.map(r => [r.account_guid, r]));

    // Opening equity (balance before startDate)
    const openingEquityBalances = equityAccounts.map(account => ({
        ...account,
        // Negate for display (positive = increase in equity)
        balance: -(equitySumsByGuid.get(account.guid)?.opening_sum ?? 0),
    }));

    // Period income and expense activity in one grouped query
    const periodSums = await sumSplitsByAccount(
        [...incomeAccounts, ...expenseAccounts].map(a => a.guid),
        { gte: startDate, lte: endDate }
    );

    // Period income (negated for display; income is stored as negative/credits)
    const periodIncomeBalances = incomeAccounts.map(account => ({
        ...account,
        balance: -numericToNumber(periodSums.get(account.guid)?.quantity ?? ZERO_NUMERIC),
    }));

    // Period expenses
    const periodExpenseBalances = expenseAccounts.map(account => ({
        ...account,
        balance: numericToNumber(periodSums.get(account.guid)?.quantity ?? ZERO_NUMERIC),
    }));

    // Other equity changes (direct equity transactions during period)
    const otherEquityChangesBalances = equityAccounts.map(account => ({
        ...account,
        balance: -(equitySumsByGuid.get(account.guid)?.period_sum ?? 0), // Negate for display
    }));

    // Closing equity (balance at endDate)
    const closingEquityBalances = equityAccounts.map(account => ({
        ...account,
        balance: -(equitySumsByGuid.get(account.guid)?.closing_sum ?? 0), // Negate for display
    }));

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

    // GnuCash does not close income/expense into equity accounts, so equity
    // splits alone omit retained earnings. Include the current period's net
    // income as a retained-earnings line so closing equity satisfies the
    // identity: Closing = Opening + Net Income + Other Changes.
    const closingItemsWithRetained: LineItem[] = [
        ...closingItems,
        {
            guid: 'retained-earnings-current-period',
            name: 'Retained Earnings (Current Period)',
            amount: netIncome,
            depth: 0,
        },
    ];
    const totalClosingEquity = closingItems.reduce((sum, item) => sum + item.amount, 0) + netIncome;

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
            items: closingItemsWithRetained,
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
