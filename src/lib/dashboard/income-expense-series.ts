/**
 * Pure assembly of the dashboard income/expense monthly series.
 *
 * The route used to pull every split in the window and reduce them in JS. The
 * summation now happens in PostgreSQL `numeric` (see
 * `sumSplitsByAccountAndMonth`), which hands back one row per (month, account);
 * everything that is *not* summation — currency conversion, the
 * income/expense/tax classification, and filling in empty months — stays here,
 * where it is testable without a database.
 */

import type { MonthlyAccountSum } from '@/lib/reports/utils';

export interface MonthlySeriesPoint {
    month: string;
    income: number;
    expenses: number;
    taxes: number;
    netProfit: number;
}

export interface MonthlySeriesOptions {
    /** Accounts whose splits are income (stored negative in GnuCash). */
    incomeGuids: ReadonlySet<string>;
    /** Accounts whose splits are expenses (stored positive). */
    expenseGuids: ReadonlySet<string>;
    /** Subset of `expenseGuids` whose account path names a tax account. */
    taxExpenseGuids: ReadonlySet<string>;
    /**
     * Account guid -> multiplier into the base currency. Absent means 1, which
     * is both the base-currency case and the no-rate-found fallback the route
     * has always used.
     */
    ratesByAccount: ReadonlyMap<string, number>;
    /** Window bounds; every month they span appears, zero-filled if empty. */
    startDate: Date;
    endDate: Date;
}

function monthKey(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

export function buildMonthlySeries(
    rows: readonly MonthlyAccountSum[],
    options: MonthlySeriesOptions,
): MonthlySeriesPoint[] {
    const { incomeGuids, expenseGuids, taxExpenseGuids, ratesByAccount, startDate, endDate } = options;

    const monthlyData = new Map<string, { income: number; expenses: number; taxes: number }>();

    for (const row of rows) {
        const isIncome = incomeGuids.has(row.accountGuid);
        const isExpense = !isIncome && expenseGuids.has(row.accountGuid);
        if (!isIncome && !isExpense) continue;

        const entry = monthlyData.get(row.month) || { income: 0, expenses: 0, taxes: 0 };
        const value = row.quantity * (ratesByAccount.get(row.accountGuid) ?? 1);

        if (isIncome) {
            // Income splits are negative in GnuCash; negate to get positive income.
            entry.income += -value;
        } else {
            entry.expenses += value;
            if (taxExpenseGuids.has(row.accountGuid)) {
                entry.taxes += value;
            }
        }

        monthlyData.set(row.month, entry);
    }

    const monthly: MonthlySeriesPoint[] = [];
    const current = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));

    while (current <= endMonth) {
        const key = monthKey(current);
        const data = monthlyData.get(key) || { income: 0, expenses: 0, taxes: 0 };

        monthly.push({
            month: key,
            income: round2(data.income),
            expenses: round2(data.expenses),
            taxes: round2(data.taxes),
            netProfit: round2(data.income - data.expenses),
        });

        current.setUTCMonth(current.getUTCMonth() + 1);
    }

    return monthly;
}
