import prisma from '@/lib/prisma';
import { ReportType, ReportFilters, GeneralLedgerData, LedgerAccount, LedgerEntry } from './types';
import { buildAccountPathMap, toDecimal } from './utils';

/** Credit-normal account types where balance = credits - debits */
const CREDIT_NORMAL_TYPES = new Set(['LIABILITY', 'CREDIT', 'EQUITY', 'INCOME', 'PAYABLE']);

/**
 * Generate General Ledger Report
 *
 * Organizes transactions by account, showing opening balance, individual
 * entries with running balance, and closing balance for each account.
 */
export async function generateGeneralLedger(filters: ReportFilters): Promise<GeneralLedgerData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    // Build account type filter
    const accountTypeFilter = filters.accountTypes && filters.accountTypes.length > 0
        ? filters.accountTypes
        : undefined;

    // Get all non-ROOT, non-hidden accounts in scope
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: {
                notIn: ['ROOT'],
                ...(accountTypeFilter ? { in: accountTypeFilter } : {}),
            },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
        },
    });

    if (accounts.length === 0) {
        return {
            type: ReportType.GENERAL_LEDGER,
            title: 'General Ledger',
            generatedAt: new Date().toISOString(),
            filters,
            accounts: [],
            totalDebits: 0,
            totalCredits: 0,
        };
    }

    const accountGuids = accounts.map(a => a.guid);
    const accountMap = new Map(accounts.map(a => [a.guid, a]));

    // Build full account path map for display
    const accountPaths = await buildAccountPathMap(filters.bookAccountGuids);

    // Batch query: opening balances (all splits before startDate)
    const openingSplits = await prisma.splits.findMany({
        where: {
            account_guid: { in: accountGuids },
            transaction: {
                post_date: { lt: startDate },
            },
        },
        select: {
            account_guid: true,
            value_num: true,
            value_denom: true,
        },
    });

    // Sum opening balances by account
    const openingBalances = new Map<string, number>();
    for (const split of openingSplits) {
        const current = openingBalances.get(split.account_guid) || 0;
        openingBalances.set(split.account_guid, current + toDecimal(split.value_num, split.value_denom));
    }

    // Batch query: period splits with transaction details
    const periodSplits = await prisma.splits.findMany({
        where: {
            account_guid: { in: accountGuids },
            transaction: {
                post_date: {
                    gte: startDate,
                    lte: endDate,
                },
            },
        },
        include: {
            transaction: {
                select: {
                    description: true,
                    post_date: true,
                    num: true,
                },
            },
        },
        orderBy: {
            transaction: {
                post_date: 'asc',
            },
        },
    });

    // Group period splits by account
    const splitsByAccount = new Map<string, typeof periodSplits>();
    for (const split of periodSplits) {
        const existing = splitsByAccount.get(split.account_guid);
        if (existing) {
            existing.push(split);
        } else {
            splitsByAccount.set(split.account_guid, [split]);
        }
    }

    // Build ledger accounts
    const ledgerAccounts: LedgerAccount[] = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const account of accounts) {
        const openingBalance = openingBalances.get(account.guid) || 0;
        const splits = splitsByAccount.get(account.guid) || [];
        const isCreditNormal = CREDIT_NORMAL_TYPES.has(account.account_type);

        // Skip accounts with no activity and zero opening balance (unless showZeroBalances)
        if (splits.length === 0 && Math.abs(openingBalance) < 0.005 && !filters.showZeroBalances) {
            continue;
        }

        const entries: LedgerEntry[] = [];
        let runningBalance = openingBalance;

        for (const split of splits) {
            const value = toDecimal(split.value_num, split.value_denom);
            const debit = value > 0 ? Math.round(value * 100) / 100 : 0;
            const credit = value < 0 ? Math.round(Math.abs(value) * 100) / 100 : 0;

            // Running balance depends on account normal balance side
            if (isCreditNormal) {
                runningBalance += (credit - debit);
            } else {
                runningBalance += (debit - credit);
            }

            totalDebits += debit;
            totalCredits += credit;

            entries.push({
                date: split.transaction.post_date
                    ? split.transaction.post_date.toISOString().split('T')[0]
                    : '',
                description: split.transaction.description || '(no description)',
                debit,
                credit,
                runningBalance: Math.round(runningBalance * 100) / 100,
                memo: split.memo || '',
            });
        }

        const closingBalance = Math.round(runningBalance * 100) / 100;

        ledgerAccounts.push({
            guid: account.guid,
            accountPath: accountPaths.get(account.guid) || account.name,
            accountType: account.account_type,
            openingBalance: Math.round(openingBalance * 100) / 100,
            entries,
            closingBalance,
        });
    }

    // Sort accounts by path
    ledgerAccounts.sort((a, b) => a.accountPath.localeCompare(b.accountPath));

    return {
        type: ReportType.GENERAL_LEDGER,
        title: 'General Ledger',
        generatedAt: new Date().toISOString(),
        filters,
        accounts: ledgerAccounts,
        totalDebits: Math.round(totalDebits * 100) / 100,
        totalCredits: Math.round(totalCredits * 100) / 100,
    };
}
