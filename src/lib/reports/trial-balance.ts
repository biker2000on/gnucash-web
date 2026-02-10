import prisma from '@/lib/prisma';
import { ReportType, ReportFilters, TrialBalanceData, TrialBalanceEntry } from './types';
import { toDecimal, buildAccountPathMap } from './utils';

/** Account types with debit-normal balances */
const DEBIT_NORMAL_TYPES = new Set([
    'ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'EXPENSE', 'RECEIVABLE',
]);

/** Account types with credit-normal balances */
const CREDIT_NORMAL_TYPES = new Set([
    'LIABILITY', 'CREDIT', 'EQUITY', 'INCOME', 'PAYABLE',
]);

/** All account types to include (excludes ROOT and TRADING) */
const ALL_ACCOUNT_TYPES = [...DEBIT_NORMAL_TYPES, ...CREDIT_NORMAL_TYPES];

/**
 * Generate Trial Balance report.
 *
 * Queries all non-ROOT, non-TRADING accounts and computes their balance
 * (sum of quantity_num/quantity_denom for all splits up to endDate).
 * Places each balance into the appropriate debit or credit column based
 * on the account's normal sign and the raw balance sign.
 */
export async function generateTrialBalance(filters: ReportFilters): Promise<TrialBalanceData> {
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Get all non-ROOT, non-TRADING accounts
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: {
                in: ALL_ACCOUNT_TYPES,
            },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
        },
    });

    // Build full account path map
    const pathMap = await buildAccountPathMap(filters.bookAccountGuids);

    // Get balances for each account up to end date
    const entries: TrialBalanceEntry[] = [];

    for (const account of accounts) {
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

        const rawBalance = splits.reduce((sum, split) => {
            return sum + toDecimal(split.quantity_num, split.quantity_denom);
        }, 0);

        // Skip zero-balance accounts unless showZeroBalances is true
        if (Math.abs(rawBalance) < 0.005 && !filters.showZeroBalances) {
            continue;
        }

        // Determine debit/credit placement based on account type and balance sign
        let debit = 0;
        let credit = 0;

        if (DEBIT_NORMAL_TYPES.has(account.account_type)) {
            // Debit-normal: positive raw balance -> debit, negative -> credit
            if (rawBalance >= 0) {
                debit = rawBalance;
            } else {
                credit = Math.abs(rawBalance);
            }
        } else if (CREDIT_NORMAL_TYPES.has(account.account_type)) {
            // Credit-normal: negative raw balance -> credit (abs), positive -> debit
            if (rawBalance <= 0) {
                credit = Math.abs(rawBalance);
            } else {
                debit = rawBalance;
            }
        }

        entries.push({
            guid: account.guid,
            accountPath: pathMap.get(account.guid) || account.name,
            accountType: account.account_type,
            debit: Math.round(debit * 100) / 100,
            credit: Math.round(credit * 100) / 100,
        });
    }

    // Sort alphabetically by full account path
    entries.sort((a, b) => a.accountPath.localeCompare(b.accountPath));

    const totalDebits = Math.round(entries.reduce((sum, e) => sum + e.debit, 0) * 100) / 100;
    const totalCredits = Math.round(entries.reduce((sum, e) => sum + e.credit, 0) * 100) / 100;

    return {
        type: ReportType.TRIAL_BALANCE,
        title: 'Trial Balance',
        generatedAt: new Date().toISOString(),
        filters,
        entries,
        totalDebits,
        totalCredits,
    };
}
