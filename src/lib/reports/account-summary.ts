import prisma from '@/lib/prisma';
import { getLatestPrice } from '@/lib/commodities';
import { ReportType, ReportData, ReportSection, LineItem, ReportFilters } from './types';

/**
 * Convert GnuCash fraction to decimal number
 */
function toDecimal(num: bigint | null, denom: bigint | null): number {
    if (num === null || denom === null || denom === 0n) return 0;
    return Number(num) / Number(denom);
}

interface AccountWithBalances {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
    commodity_guid: string | null;
    closingBalance: number;
    openingBalance: number;
}

/**
 * Build hierarchical line items from flat account list
 */
function buildHierarchy(accounts: AccountWithBalances[], parentGuid: string | null = null, depth = 0): LineItem[] {
    const children = accounts.filter(a => a.parent_guid === parentGuid);

    return children.map(account => {
        const childItems = buildHierarchy(accounts, account.guid, depth + 1);
        const childrenClosingTotal = childItems.reduce((sum, item) => sum + item.amount, 0);
        const childrenOpeningTotal = childItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0);

        return {
            guid: account.guid,
            name: account.name,
            amount: account.closingBalance + childrenClosingTotal,
            previousAmount: account.openingBalance + childrenOpeningTotal,
            children: childItems.length > 0 ? childItems : undefined,
            depth,
        };
    });
}

/**
 * Generate Account Summary report
 */
export async function generateAccountSummary(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    const investmentTypes = ['STOCK', 'MUTUAL'];

    // Find the Root Account GUID
    const rootAccount = await prisma.accounts.findFirst({
        where: {
            account_type: 'ROOT',
            name: { startsWith: 'Root' }
        },
        select: { guid: true }
    });
    const rootGuid = rootAccount?.guid || null;

    // Get all non-hidden accounts
    const accounts = await prisma.accounts.findMany({
        where: {
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
    const accountBalances: AccountWithBalances[] = await Promise.all(
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
                openingBalance,
                closingBalance,
            };
        })
    );

    // Categorize top-level account types
    const assetTypes = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL'];
    const liabilityTypes = ['LIABILITY', 'CREDIT'];
    const incomeTypes = ['INCOME'];
    const expenseTypes = ['EXPENSE'];
    const equityTypes = ['EQUITY'];

    function getTopLevelCategory(type: string): string | null {
        if (assetTypes.includes(type)) return 'Assets';
        if (liabilityTypes.includes(type)) return 'Liabilities';
        if (incomeTypes.includes(type)) return 'Income';
        if (expenseTypes.includes(type)) return 'Expenses';
        if (equityTypes.includes(type)) return 'Equity';
        return null;
    }

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
