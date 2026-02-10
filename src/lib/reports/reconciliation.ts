import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, ReportFilters, LineItem } from './types';
import { toDecimal, buildAccountPathMap } from './utils';

/**
 * Generate Reconciliation Report
 * Shows reconciled, cleared, and uncleared transactions for selected accounts
 */
export async function generateReconciliation(
    filters: ReportFilters,
    accountGuids?: string[]
): Promise<ReportData> {
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : null;
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Build account path map for display names
    const accountPathMap = await buildAccountPathMap(filters.bookAccountGuids);

    // Build WHERE clause for splits
    const whereClause: any = {
        transaction: {
            post_date: {
                ...(startDate && { gte: startDate }),
                lte: endDate,
            },
        },
    };

    // Apply account filtering
    if (accountGuids && accountGuids.length > 0) {
        whereClause.account_guid = { in: accountGuids };
    } else if (filters.bookAccountGuids && filters.bookAccountGuids.length > 0) {
        whereClause.account_guid = { in: filters.bookAccountGuids };
    }

    // Fetch all splits with transaction details
    const splits = await prisma.splits.findMany({
        where: whereClause,
        include: {
            transaction: {
                select: {
                    post_date: true,
                    description: true,
                },
            },
        },
        orderBy: {
            transaction: {
                post_date: 'asc',
            },
        },
    });

    // Separate splits by reconcile state
    const reconciledSplits: typeof splits = [];
    const clearedSplits: typeof splits = [];
    const unclearedSplits: typeof splits = [];

    let reconciledBalance = 0;
    let registerBalance = 0;

    for (const split of splits) {
        const amount = toDecimal(split.value_num, split.value_denom);
        registerBalance += amount;

        if (split.reconcile_state === 'y') {
            reconciledSplits.push(split);
            reconciledBalance += amount;
        } else if (split.reconcile_state === 'c') {
            clearedSplits.push(split);
        } else {
            // 'n' or any other state treated as uncleared
            unclearedSplits.push(split);
        }
    }

    // Helper to build line items from splits
    const buildLineItems = (splitList: typeof splits): LineItem[] => {
        return splitList.map(split => {
            const amount = toDecimal(split.value_num, split.value_denom);
            const date = split.transaction.post_date?.toISOString().split('T')[0] || 'Unknown';
            const description = split.transaction.description || '(No description)';
            const accountName = accountPathMap.get(split.account_guid) || split.account_guid;

            return {
                guid: split.guid,
                name: `${date} - ${description} (${accountName})`,
                amount,
            };
        });
    };

    // Build cleared and uncleared line items
    const clearedItems = buildLineItems(clearedSplits);
    const unclearedItems = buildLineItems(unclearedSplits);

    // Calculate totals for cleared and uncleared
    const clearedTotal = clearedItems.reduce((sum, item) => sum + item.amount, 0);
    const unclearedTotal = unclearedItems.reduce((sum, item) => sum + item.amount, 0);

    // Build sections
    const sections: ReportSection[] = [
        {
            title: 'Reconciled Balance',
            items: [
                {
                    guid: 'reconciled-total',
                    name: 'Total Reconciled',
                    amount: reconciledBalance,
                    isTotal: true,
                },
            ],
            total: reconciledBalance,
        },
        {
            title: 'Cleared Transactions',
            items: clearedItems,
            total: clearedTotal,
        },
        {
            title: 'Uncleared Transactions',
            items: unclearedItems,
            total: unclearedTotal,
        },
        {
            title: 'Register Balance',
            items: [
                {
                    guid: 'register-total',
                    name: 'Total Register Balance',
                    amount: registerBalance,
                    isTotal: true,
                },
            ],
            total: registerBalance,
        },
    ];

    return {
        type: ReportType.RECONCILIATION,
        title: 'Reconciliation Report',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
        grandTotal: registerBalance,
    };
}
