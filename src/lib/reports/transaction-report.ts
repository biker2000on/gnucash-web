import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, LineItem, ReportFilters } from './types';
import { buildAccountPathMap } from './utils';

/**
 * Convert GnuCash fraction to decimal number
 */
function toDecimal(num: bigint | null, denom: bigint | null): number {
    if (num === null || denom === null || denom === 0n) return 0;
    return Number(num) / Number(denom);
}

export interface TransactionReportItem {
    guid: string;
    date: string;
    description: string;
    account: string;
    amount: number;
    memo: string;
    reconciled: string;
}

export interface TransactionReportData extends Omit<ReportData, 'sections'> {
    transactions: TransactionReportItem[];
    totalDebits: number;
    totalCredits: number;
    netAmount: number;
}

/**
 * Generate Transaction Report
 */
export async function generateTransactionReport(filters: ReportFilters): Promise<TransactionReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    // Filter by account types if specified
    const accountTypeFilter = filters.accountTypes && filters.accountTypes.length > 0
        ? { in: filters.accountTypes }
        : undefined;

    // Get transactions with splits (scoped to active book if bookAccountGuids provided)
    const transactions = await prisma.transactions.findMany({
        where: {
            post_date: {
                gte: startDate,
                lte: endDate,
            },
            ...(filters.bookAccountGuids ? {
                splits: {
                    some: {
                        account_guid: { in: filters.bookAccountGuids },
                    },
                },
            } : {}),
        },
        include: {
            splits: {
                include: {
                    account: {
                        select: {
                            guid: true,
                            name: true,
                            account_type: true,
                        },
                    },
                },
            },
        },
        orderBy: {
            post_date: 'desc',
        },
    });

    // Build full account path map for display names
    const accountPaths = await buildAccountPathMap(filters.bookAccountGuids);

    // Flatten to transaction items
    const items: TransactionReportItem[] = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const tx of transactions) {
        for (const split of tx.splits) {
            // Filter by account type if specified
            if (accountTypeFilter && split.account && !accountTypeFilter.in.includes(split.account.account_type)) {
                continue;
            }

            const amount = toDecimal(split.value_num, split.value_denom);

            if (amount > 0) {
                totalDebits += amount;
            } else {
                totalCredits += Math.abs(amount);
            }

            const accountGuid = split.account?.guid || '';
            items.push({
                guid: split.guid,
                date: tx.post_date?.toISOString().split('T')[0] || '',
                description: tx.description || '',
                account: accountPaths.get(accountGuid) || split.account?.name || 'Unknown',
                amount,
                memo: split.memo || '',
                reconciled: split.reconcile_state || 'n',
            });
        }
    }

    return {
        type: ReportType.TRANSACTION_REPORT,
        title: 'Transaction Report',
        generatedAt: new Date().toISOString(),
        filters,
        transactions: items,
        totalDebits,
        totalCredits,
        netAmount: totalDebits - totalCredits,
    };
}
