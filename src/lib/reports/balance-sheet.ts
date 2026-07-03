import prisma from '@/lib/prisma';
import { buildAccountValuationContext } from '@/lib/account-valuation';
import { ReportType, ReportData, ReportSection, ReportFilters } from './types';
import { toDecimal, buildHierarchy, resolveRootGuid } from './utils';

/**
 * Generate Balance Sheet report
 */
export async function generateBalanceSheet(filters: ReportFilters): Promise<ReportData> {
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Determine root GUID from book scoping or fallback
    const rootGuid = await resolveRootGuid(filters.bookAccountGuids);

    // Get all asset, liability, and equity accounts with their balances
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: {
                in: ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE', 'LIABILITY', 'CREDIT', 'PAYABLE', 'EQUITY'],
            },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
            commodity_guid: true,
            commodity: {
                select: {
                    namespace: true,
                },
            },
        },
    });

    const valuation = await buildAccountValuationContext(
        accounts.map(account => ({
            accountType: account.account_type,
            commodityGuid: account.commodity_guid,
            commodityNamespace: account.commodity?.namespace,
        })),
        endDate
    );

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
                    quantity_num: true,
                    quantity_denom: true,
                },
            });

            const quantity = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            const balance = quantity * valuation.getMultiplier({
                accountType: account.account_type,
                commodityGuid: account.commodity_guid,
                commodityNamespace: account.commodity?.namespace,
            });

            return {
                ...account,
                balance,
            };
        })
    );

    // Separate by account type category (RECEIVABLE is an asset, PAYABLE a liability)
    const assetTypes = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE'];
    const liabilityTypes = ['LIABILITY', 'CREDIT', 'PAYABLE'];
    const equityTypes = ['EQUITY'];

    const assetAccounts = accountBalances.filter(a => assetTypes.includes(a.account_type));
    const liabilityAccounts = accountBalances.filter(a => liabilityTypes.includes(a.account_type));
    const equityAccounts = accountBalances.filter(a => equityTypes.includes(a.account_type));

    // Build hierarchies
    const assetItems = buildHierarchy(assetAccounts, rootGuid);
    const liabilityItems = buildHierarchy(liabilityAccounts, rootGuid);
    const equityItems = buildHierarchy(equityAccounts, rootGuid);

    // Calculate totals. Liabilities and equity are credit-normal: their raw
    // GnuCash balances are negative when normal, so negate the signed sum to
    // display a positive total. Using the signed sum (instead of Math.abs per
    // item) means a contra balance — e.g. an overpaid credit card carrying a
    // debit balance — correctly reduces the section total rather than adding to it.
    const totalAssets = assetItems.reduce((sum, item) => sum + item.amount, 0);
    const totalLiabilities = -liabilityItems.reduce((sum, item) => sum + item.amount, 0);
    const totalEquity = -equityItems.reduce((sum, item) => sum + item.amount, 0);

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
