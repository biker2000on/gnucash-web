import prisma from '@/lib/prisma';
import { buildAccountValuationContext } from '@/lib/account-valuation';
import { ReportType, ReportData, ReportSection, ReportFilters } from './types';
import { buildHierarchy, resolveRootGuid, AccountWithBalance } from './utils';

/**
 * Generate Account Summary report
 */
export async function generateAccountSummary(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

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

    // Opening (before startDate) and closing (up to endDate) balances for all
    // accounts in one GROUP BY pass using FILTER clauses. The outer WHERE is
    // the union of both windows so opening splits are never lost even if
    // startDate > endDate.
    const accountGuids = accounts.map(a => a.guid);
    const balanceRows = accountGuids.length > 0
        ? await prisma.$queryRaw<Array<{
            account_guid: string;
            opening_sum: number;
            closing_sum: number;
        }>>`
            SELECT s.account_guid,
                   COALESCE(SUM(s.quantity_num::float8 / NULLIF(s.quantity_denom, 0)::float8)
                       FILTER (WHERE t.post_date < ${startDate}), 0)::float8 AS opening_sum,
                   COALESCE(SUM(s.quantity_num::float8 / NULLIF(s.quantity_denom, 0)::float8)
                       FILTER (WHERE t.post_date <= ${endDate}), 0)::float8 AS closing_sum
            FROM splits s
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE s.account_guid = ANY(${accountGuids}::text[])
              AND (t.post_date < ${startDate} OR t.post_date <= ${endDate})
            GROUP BY s.account_guid
        `
        : [];
    const balancesByGuid = new Map(balanceRows.map(r => [r.account_guid, r]));

    const accountBalances: AccountWithBalance[] = accounts.map(account => {
        const sums = balancesByGuid.get(account.guid);
        const openingBalance = sums?.opening_sum ?? 0;
        const closingBalance = sums?.closing_sum ?? 0;

        const reportCurrencyMultiplier = valuation.getMultiplier({
            accountType: account.account_type,
            commodityGuid: account.commodity_guid,
            commodityNamespace: account.commodity?.namespace,
        });

        return {
            ...account,
            balance: closingBalance * reportCurrencyMultiplier,
            previousBalance: openingBalance * reportCurrencyMultiplier,
        };
    });

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
