import prisma from '@/lib/prisma';
import { ReportType, ReportFilters, GeneralJournalData, JournalEntry, JournalSplit } from './types';
import { buildAccountPathMap, toDecimal } from './utils';

/**
 * Generate General Journal report.
 * Fetches all transactions in the date range with all their splits,
 * grouped by transaction and ordered chronologically.
 */
export async function generateGeneralJournal(filters: ReportFilters): Promise<GeneralJournalData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    // Get transactions with splits, scoped to book if bookAccountGuids provided
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
            post_date: 'asc',
        },
    });

    // Build full account path map for display names
    const accountPaths = await buildAccountPathMap(filters.bookAccountGuids);

    let totalDebits = 0;
    let totalCredits = 0;

    const entries: JournalEntry[] = transactions.map(tx => {
        const splits: JournalSplit[] = tx.splits.map(split => {
            const value = toDecimal(split.value_num, split.value_denom);
            const debit = value > 0 ? value : 0;
            const credit = value < 0 ? Math.abs(value) : 0;

            totalDebits += debit;
            totalCredits += credit;

            const accountGuid = split.account?.guid || '';

            return {
                accountPath: accountPaths.get(accountGuid) || split.account?.name || 'Unknown',
                debit,
                credit,
                memo: split.memo || '',
            };
        });

        return {
            transactionGuid: tx.guid,
            date: tx.post_date?.toISOString().split('T')[0] || '',
            description: tx.description || '',
            num: tx.num || '',
            splits,
        };
    });

    return {
        type: ReportType.GENERAL_JOURNAL,
        title: 'General Journal',
        generatedAt: new Date().toISOString(),
        filters,
        entries,
        totalDebits: Math.round(totalDebits * 100) / 100,
        totalCredits: Math.round(totalCredits * 100) / 100,
        entryCount: entries.length,
    };
}
