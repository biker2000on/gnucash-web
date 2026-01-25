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
 * Generate Balance Sheet report
 */
export async function generateBalanceSheet(filters: ReportFilters): Promise<ReportData> {
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Find the Root Account GUID
    const rootAccount = await prisma.accounts.findFirst({
        where: {
            account_type: 'ROOT',
            name: { startsWith: 'Root' }
        },
        select: { guid: true }
    });
    const rootGuid = rootAccount?.guid || null;

    // Get all asset, liability, and equity accounts with their balances
    const accounts = await prisma.accounts.findMany({
        where: {
            account_type: {
                in: ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'LIABILITY', 'CREDIT', 'EQUITY'],
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

    // Get balances for each account up to end date
    const accountBalances = await Promise.all(
        accounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: {
                            lte: endDate,
                        },
                    },
                },
                select: {
                    value_num: true,
                    value_denom: true,
                },
            });

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.value_num, split.value_denom);
            }, 0);

            return {
                ...account,
                balance,
            };
        })
    );

    // Separate by account type category
    const assetTypes = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL'];
    const liabilityTypes = ['LIABILITY', 'CREDIT'];
    const equityTypes = ['EQUITY'];

    const assetAccounts = accountBalances.filter(a => assetTypes.includes(a.account_type));
    const liabilityAccounts = accountBalances.filter(a => liabilityTypes.includes(a.account_type));
    const equityAccounts = accountBalances.filter(a => equityTypes.includes(a.account_type));

    // Build hierarchies
    const assetItems = buildHierarchy(assetAccounts, rootGuid);
    const liabilityItems = buildHierarchy(liabilityAccounts, rootGuid);
    const equityItems = buildHierarchy(equityAccounts, rootGuid);

    // Calculate totals
    const totalAssets = assetItems.reduce((sum, item) => sum + item.amount, 0);
    const totalLiabilities = liabilityItems.reduce((sum, item) => sum + Math.abs(item.amount), 0);
    const totalEquity = equityItems.reduce((sum, item) => sum + Math.abs(item.amount), 0);

    const sections: ReportSection[] = [
        {
            title: 'Assets',
            items: assetItems,
            total: totalAssets,
        },
        {
            title: 'Liabilities',
            items: liabilityItems,
            total: totalLiabilities,
        },
        {
            title: 'Equity',
            items: equityItems,
            total: totalEquity,
        },
    ];

    return {
        type: ReportType.BALANCE_SHEET,
        title: 'Balance Sheet',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
        grandTotal: totalAssets - totalLiabilities - totalEquity, // Should be 0 if balanced
    };
}
