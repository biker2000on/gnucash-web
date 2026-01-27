import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, LineItem, ReportFilters } from './types';

/**
 * Convert GnuCash fraction to decimal number
 */
function toDecimal(num: bigint | null, denom: bigint | null): number {
    if (num === null || denom === null || denom === 0n) return 0;
    return Number(num) / Number(denom);
}

/**
 * Generate Account Summary report
 */
export async function generateAccountSummary(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    // Filter by account types if specified
    const accountTypeFilter = filters.accountTypes && filters.accountTypes.length > 0
        ? { in: filters.accountTypes }
        : undefined;

    // Get all non-hidden accounts
    const accounts = await prisma.accounts.findMany({
        where: {
            hidden: 0,
            account_type: accountTypeFilter,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
        },
        orderBy: [
            { account_type: 'asc' },
            { name: 'asc' },
        ],
    });

    // Get balances and activity for each account
    const accountSummaries = await Promise.all(
        accounts.map(async (account) => {
            // Get opening balance (before start date)
            const openingSplits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: {
                            lt: startDate,
                        },
                    },
                },
                select: {
                    quantity_num: true,
                    quantity_denom: true,
                },
            });

            const openingBalance = openingSplits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            // Get activity during period
            const periodSplits = await prisma.splits.findMany({
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

            const debits = periodSplits
                .filter(s => toDecimal(s.quantity_num, s.quantity_denom) > 0)
                .reduce((sum, s) => sum + toDecimal(s.quantity_num, s.quantity_denom), 0);

            const credits = periodSplits
                .filter(s => toDecimal(s.quantity_num, s.quantity_denom) < 0)
                .reduce((sum, s) => sum + Math.abs(toDecimal(s.quantity_num, s.quantity_denom)), 0);

            const netChange = debits - credits;
            const closingBalance = openingBalance + netChange;

            return {
                ...account,
                openingBalance,
                debits,
                credits,
                netChange,
                closingBalance,
                transactionCount: periodSplits.length,
            };
        })
    );

    // Filter out zero balances if not requested
    const filteredSummaries = filters.showZeroBalances
        ? accountSummaries
        : accountSummaries.filter(a =>
            a.openingBalance !== 0 ||
            a.closingBalance !== 0 ||
            a.transactionCount > 0
        );

    // Group by account type
    const groupedByType = filteredSummaries.reduce((acc, account) => {
        if (!acc[account.account_type]) {
            acc[account.account_type] = [];
        }
        acc[account.account_type].push(account);
        return acc;
    }, {} as Record<string, typeof filteredSummaries>);

    // Build sections
    const sections: ReportSection[] = Object.entries(groupedByType).map(([type, accounts]) => ({
        title: type.charAt(0) + type.slice(1).toLowerCase(),
        items: accounts.map(a => ({
            guid: a.guid,
            name: a.name,
            amount: a.closingBalance,
            previousAmount: a.openingBalance,
        })),
        total: accounts.reduce((sum, a) => sum + a.closingBalance, 0),
        previousTotal: accounts.reduce((sum, a) => sum + a.openingBalance, 0),
    }));

    return {
        type: ReportType.ACCOUNT_SUMMARY,
        title: 'Account Summary',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
    };
}
