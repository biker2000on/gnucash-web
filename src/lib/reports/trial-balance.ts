import prisma from '@/lib/prisma';
import { ReportType, ReportFilters, TrialBalanceData, TrialBalanceEntry } from './types';
import { buildAccountPathMap, numericToNumber, sumSplitsByAccount, ZERO_NUMERIC } from './utils';

/** Account types with debit-normal balances */
const DEBIT_NORMAL_TYPES = new Set([
    'ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'EXPENSE', 'RECEIVABLE',
]);

/** Account types with credit-normal balances */
const CREDIT_NORMAL_TYPES = new Set([
    'LIABILITY', 'CREDIT', 'EQUITY', 'INCOME', 'PAYABLE',
]);

/**
 * All account types to include (excludes only ROOT).
 *
 * TRADING accounts ARE included: GnuCash posts the currency/commodity
 * conversion legs of a multi-currency transaction to them, so omitting them
 * removes real debits and credits from the trial balance. Their normal side
 * varies, so they are placed by balance sign (see below).
 */
const ALL_ACCOUNT_TYPES = [...DEBIT_NORMAL_TYPES, ...CREDIT_NORMAL_TYPES, 'TRADING'];

/**
 * Generate Trial Balance report.
 *
 * Queries all non-ROOT accounts and computes each one's POSTED book value —
 * SUM(value_num/value_denom), the debit/credit amount actually written to the
 * ledger — up to endDate. Places each balance into the debit or credit column
 * based on the account's normal sign and the balance sign.
 *
 * VALUATION CHOICE: securities are carried at COST, not marked to market.
 * A trial balance exists to prove that posted debits equal posted credits, and
 * GnuCash guarantees the split VALUES of every transaction sum to zero. Marking
 * STOCK/MUTUAL holdings to market (quantity x latest price) while every
 * offsetting entry stays at cost injects the unrealized gain into one side
 * only, which rendered a healthy book as a red "Imbalance". The alternative —
 * marking to market and synthesizing an Unrealized Gains balancing line — would
 * report an amount that appears nowhere in the ledger, so cost basis wins here.
 * (Market values are available on the Balance Sheet and portfolio reports.)
 *
 * CAVEAT: split values are denominated in each transaction's currency. In a
 * single-currency book that is the report currency and the columns tie exactly;
 * in a multi-currency book, foreign-currency postings are summed at their
 * historical transaction currency without conversion.
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

    // Get balances for all accounts up to end date in a single GROUP BY query
    const balanceSums = await sumSplitsByAccount(
        accounts.map(a => a.guid),
        { lte: endDate }
    );

    const entries: TrialBalanceEntry[] = [];

    for (const account of accounts) {
        // Posted book value (cost), NOT quantity x market price — see the
        // valuation note in the function doc.
        const rawBalance = numericToNumber(balanceSums.get(account.guid)?.value ?? ZERO_NUMERIC);

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
        } else {
            // TRADING (and any future type) has no fixed normal side — place by
            // the sign of the posted balance.
            if (rawBalance >= 0) {
                debit = rawBalance;
            } else {
                credit = Math.abs(rawBalance);
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
