import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { ReportType, ReportData, ReportSection, ReportFilters } from './types';
import { toDecimal, buildHierarchy, resolveRootGuid, AccountWithBalance } from './utils';
import { allocatePaymentsToAccounts, PaymentLotSplit, PostingSplit } from './cash-basis';

/**
 * Get account balances for a date range
 */
async function getAccountBalances(
    accounts: { guid: string; name: string; account_type: string; parent_guid: string | null }[],
    startDate: Date,
    endDate: Date
): Promise<AccountWithBalance[]> {
    return Promise.all(
        accounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
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

            const balance = splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);

            return {
                ...account,
                balance,
            };
        })
    );
}

/**
 * CASH-BASIS account balances for a date range.
 *
 * 1. Sums income/expense splits EXCLUDING transactions that also touch a
 *    RECEIVABLE or PAYABLE account (invoice/bill posting transactions —
 *    those are accrual entries).
 * 2. Recognizes invoice/bill PAYMENTS instead: payment transactions carry an
 *    AR/AP split assigned into the paid invoice's lot (splits.lot_guid =
 *    invoices.post_lot, tx != invoices.post_txn). Each payment is allocated
 *    to the invoice's income/expense (and tax) accounts pro-rata by the
 *    posting transaction's line splits — see src/lib/reports/cash-basis.ts.
 *
 * Caveat: payment allocation uses split VALUES (transaction currency) while
 * direct sums use quantities; these coincide for same-currency books.
 */
async function getCashBasisAccountBalances(
    accounts: { guid: string; name: string; account_type: string; parent_guid: string | null }[],
    startDate: Date,
    endDate: Date,
    bookAccountGuids?: string[]
): Promise<AccountWithBalance[]> {
    const accountGuids = accounts.map((a) => a.guid);
    if (accountGuids.length === 0) return [];

    // Step 1: direct activity, excluding AR/AP-touching transactions.
    const directRows = await prisma.$queryRaw<{ account_guid: string; balance: number }[]>`
        SELECT s.account_guid,
               COALESCE(SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric), 0)::float8 AS balance
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${accountGuids}::text[])
          AND t.post_date >= ${startDate} AND t.post_date <= ${endDate}
          AND NOT EXISTS (
              SELECT 1
              FROM splits s2
              JOIN accounts a2 ON a2.guid = s2.account_guid
              WHERE s2.tx_guid = s.tx_guid
                AND a2.account_type IN ('RECEIVABLE', 'PAYABLE')
          )
        GROUP BY s.account_guid
    `;
    const balanceByGuid = new Map(directRows.map((r) => [r.account_guid, r.balance]));

    // Step 2a: payment splits assigned into invoice lots within the period.
    // AR/AP accounts are scoped to the book when book scoping is active.
    const paymentRows = await prisma.$queryRaw<
        { post_txn: string; value_num: bigint; value_denom: bigint }[]
    >`
        SELECT i.post_txn, s.value_num, s.value_denom
        FROM splits s
        JOIN accounts a ON a.guid = s.account_guid
        JOIN transactions t ON t.guid = s.tx_guid
        JOIN invoices i ON i.post_lot = s.lot_guid
        WHERE s.lot_guid IS NOT NULL
          AND a.account_type IN ('RECEIVABLE', 'PAYABLE')
          ${bookAccountGuids
              ? Prisma.sql`AND a.guid = ANY(${bookAccountGuids}::text[])`
              : Prisma.empty}
          AND i.post_txn IS NOT NULL
          AND s.tx_guid <> i.post_txn
          AND t.post_date >= ${startDate} AND t.post_date <= ${endDate}
    `;

    let recognized = new Map<string, number>();
    if (paymentRows.length > 0) {
        const postTxnGuids = Array.from(new Set(paymentRows.map((r) => r.post_txn)));

        // Step 2b: line splits of the paid invoices' posting transactions.
        // The AR/AP split is the one carrying a lot (posting txns have exactly
        // one lot-carrying split: the invoice's post_lot split).
        const postingRows = await prisma.$queryRaw<
            { tx_guid: string; account_guid: string; value_num: bigint; value_denom: bigint; is_post: boolean }[]
        >`
            SELECT s.tx_guid, s.account_guid, s.value_num, s.value_denom,
                   (s.lot_guid IS NOT NULL) AS is_post
            FROM splits s
            WHERE s.tx_guid = ANY(${postTxnGuids}::text[])
        `;

        const payments: PaymentLotSplit[] = paymentRows.map((r) => ({
            postTxnGuid: r.post_txn,
            value: toDecimal(r.value_num, r.value_denom),
        }));
        const postingSplits: PostingSplit[] = postingRows.map((r) => ({
            txGuid: r.tx_guid,
            accountGuid: r.account_guid,
            value: toDecimal(r.value_num, r.value_denom),
            isPostSplit: r.is_post,
        }));
        recognized = allocatePaymentsToAccounts(payments, postingSplits);
    }

    return accounts.map((account) => ({
        ...account,
        balance: (balanceByGuid.get(account.guid) ?? 0) + (recognized.get(account.guid) ?? 0),
    }));
}

/**
 * Generate Income Statement (Profit & Loss) report
 */
export async function generateIncomeStatement(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    // Determine root GUID from book scoping or fallback
    const rootGuid = await resolveRootGuid(filters.bookAccountGuids);

    // Get all income and expense accounts
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: {
                in: ['INCOME', 'EXPENSE'],
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

    const basis = filters.basis === 'cash' ? 'cash' : 'accrual';
    const loadBalances = (start: Date, end: Date) =>
        basis === 'cash'
            ? getCashBasisAccountBalances(accounts, start, end, filters.bookAccountGuids)
            : getAccountBalances(accounts, start, end);

    // Get balances for current period
    const accountBalances = await loadBalances(startDate, endDate);

    // Get balances for previous period if comparison is enabled
    let previousAccountBalances: AccountWithBalance[] = [];
    if (filters.compareToPrevious) {
        const periodLength = endDate.getTime() - startDate.getTime();
        const previousStartDate = new Date(startDate.getTime() - periodLength);
        const previousEndDate = new Date(startDate.getTime() - 1);
        previousAccountBalances = await loadBalances(previousStartDate, previousEndDate);

        // Merge previous balances
        accountBalances.forEach(account => {
            const prev = previousAccountBalances.find(p => p.guid === account.guid);
            if (prev) {
                account.previousBalance = prev.balance;
            }
        });
    }

    // Separate income and expenses
    const incomeAccounts = accountBalances.filter(a => a.account_type === 'INCOME');
    const expenseAccounts = accountBalances.filter(a => a.account_type === 'EXPENSE');

    // Build hierarchies - income is typically negative in GnuCash, so we negate it
    const incomeItems = buildHierarchy(incomeAccounts, rootGuid).map(item => ({
        ...item,
        amount: -item.amount, // Negate income to show as positive
        previousAmount: item.previousAmount !== undefined ? -item.previousAmount : undefined,
    }));
    const expenseItems = buildHierarchy(expenseAccounts, rootGuid);

    // Calculate totals
    const totalIncome = incomeItems.reduce((sum, item) => sum + item.amount, 0);
    const totalExpenses = expenseItems.reduce((sum, item) => sum + item.amount, 0);
    const netIncome = totalIncome - totalExpenses;

    const previousTotalIncome = filters.compareToPrevious
        ? incomeItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0)
        : undefined;
    const previousTotalExpenses = filters.compareToPrevious
        ? expenseItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0)
        : undefined;

    const sections: ReportSection[] = [
        {
            title: 'Income',
            items: incomeItems,
            total: totalIncome,
            previousTotal: previousTotalIncome,
        },
        {
            title: 'Expenses',
            items: expenseItems,
            total: totalExpenses,
            previousTotal: previousTotalExpenses,
        },
    ];

    return {
        type: ReportType.INCOME_STATEMENT,
        title: 'Income Statement',
        generatedAt: new Date().toISOString(),
        filters: { ...filters, basis },
        sections,
        grandTotal: netIncome,
        previousGrandTotal: previousTotalIncome !== undefined && previousTotalExpenses !== undefined
            ? previousTotalIncome - previousTotalExpenses
            : undefined,
    };
}
