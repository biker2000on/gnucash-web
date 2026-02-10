import prisma from '@/lib/prisma';
import { getLatestPrice } from '@/lib/commodities';
import { ReportType, ReportData, ReportSection, ReportFilters } from './types';
import { toDecimal, buildHierarchy, resolveRootGuid, AccountWithBalance } from './utils';

/**
 * Generate Account Summary report
 */
export async function generateAccountSummary(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    const investmentTypes = ['STOCK', 'MUTUAL'];

    // Determine root GUID from book scoping or fallback
    const rootGuid = await resolveRootGuid(filters.bookAccountGuids);

    // Get all non-hidden accounts
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
            commodity_guid: true,
        },
    });

    // Get balances for each account
    const accountBalances: AccountWithBalance[] = await Promise.all(
        accounts.map(async (account) => {
            const isInvestment = investmentTypes.includes(account.account_type) && account.commodity_guid;

            // Get opening balance (before start date)
            const openingSplits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: { lt: startDate },
                    },
                },
                select: {
                    quantity_num: true,
                    quantity_denom: true,
                },
            });

            let openingBalance = openingSplits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            // Get closing balance (up to end date)
            const closingSplits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: { lte: endDate },
                    },
                },
                select: {
                    quantity_num: true,
                    quantity_denom: true,
                },
            });

            let closingBalance = closingSplits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            // For investment accounts, convert share quantities to market value
            if (isInvestment) {
                const price = await getLatestPrice(account.commodity_guid!, undefined, endDate);
                const priceValue = price?.value || 0;
                openingBalance *= priceValue;
                closingBalance *= priceValue;
            }

            return {
                ...account,
                balance: closingBalance,
                previousBalance: openingBalance,
            };
        })
    );

    // Categorize top-level account types
    const assetTypes = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL'];
    const liabilityTypes = ['LIABILITY', 'CREDIT'];
    const incomeTypes = ['INCOME'];
    const expenseTypes = ['EXPENSE'];
    const equityTypes = ['EQUITY'];

    // Build sections by top-level category with hierarchy
    const categoryConfigs = [
        { title: 'Assets', types: assetTypes },
        { title: 'Liabilities', types: liabilityTypes },
        { title: 'Income', types: incomeTypes },
        { title: 'Expenses', types: expenseTypes },
        { title: 'Equity', types: equityTypes },
    ];

    const sections: ReportSection[] = [];

    for (const config of categoryConfigs) {
        const categoryAccounts = accountBalances.filter(a => config.types.includes(a.account_type));
        if (categoryAccounts.length === 0) continue;

        const items = buildHierarchy(categoryAccounts, rootGuid);
        if (items.length === 0) continue;

        const total = items.reduce((sum, item) => sum + item.amount, 0);
        const previousTotal = items.reduce((sum, item) => sum + (item.previousAmount || 0), 0);

        sections.push({
            title: config.title,
            items,
            total,
            previousTotal,
        });
    }

    return {
        type: ReportType.ACCOUNT_SUMMARY,
        title: 'Account Summary',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
    };
}
