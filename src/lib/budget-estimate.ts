/**
 * Estimate-from-history engine for the budget editor.
 *
 * Three methods, all rolled up over the account's whole subtree (parent
 * accounts rarely hold splits directly — see budget-actuals):
 *
 * - `average`:  trailing-N-month mean, scaled to the budget's period length.
 *   Every period gets the same flat amount.
 * - `median`:   trailing-N-month median (resists one-off spikes), scaled the
 *   same way. Flat across periods.
 * - `seasonal`: each budget period gets the actual activity from the SAME
 *   calendar range one year earlier — right for seasonal spend (utilities,
 *   holidays) where a flat average misleads.
 *
 * Sign convention: everything here stays in RAW GnuCash sign (income
 * negative). `periodAmounts` are ready to store as budget amounts verbatim —
 * no sign correction on the client. Display goes through
 * `applyBalanceReversal` like every other budget cell.
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import {
    computePeriodRanges,
    shiftDateKeyOneYearBack,
    type BudgetRecurrence,
} from '@/lib/budget-actuals';
import { mean, median, trailingMonthKeys } from '@/lib/budget-generator';

export type EstimateMethod = 'average' | 'median' | 'seasonal';

export const ESTIMATE_METHODS: EstimateMethod[] = ['average', 'median', 'seasonal'];

export interface BudgetEstimateResult {
    method: EstimateMethod;
    /** Lookback window (complete months) used by average/median. */
    months: number;
    numPeriods: number;
    /** Raw GnuCash-signed amount per period (index = period_num), store-ready. */
    periodAmounts: number[];
    /** Sum of periodAmounts (raw sign). */
    total: number;
    /** Splits considered in the history window. */
    transactionCount: number;
}

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

const AVG_DAYS_PER_MONTH = 30.44;

/**
 * How many months one budget period spans, for scaling a monthly statistic.
 * Week/day recurrences are approximated via average month length.
 */
export function monthsPerPeriod(periodType: string, mult: number): number {
    const type = (periodType || 'month').toLowerCase();
    const m = Math.max(1, mult || 1);
    if (type === 'year' || type === 'end of year') return 12 * m;
    if (type === 'week') return (7 * m) / AVG_DAYS_PER_MONTH;
    if (type === 'day') return m / AVG_DAYS_PER_MONTH;
    return m; // month, end of month, unknown
}

/** Sum dated amounts into per-range buckets (inclusive YYYY-MM-DD ranges). */
export function bucketByRanges(
    items: Array<{ dateKey: string; amount: number }>,
    ranges: Array<{ start: string; end: string }>
): number[] {
    const sums = new Array(ranges.length).fill(0);
    for (const item of items) {
        const idx = ranges.findIndex(r => item.dateKey >= r.start && item.dateKey <= r.end);
        if (idx >= 0) sums[idx] += item.amount;
    }
    return sums.map(round2);
}

/** The account plus every descendant, via one recursive walk. */
async function loadSubtreeGuids(accountGuid: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ guid: string }>>`
        WITH RECURSIVE subtree AS (
            SELECT guid FROM accounts WHERE guid = ${accountGuid}
            UNION ALL
            SELECT a.guid FROM accounts a JOIN subtree s ON a.parent_guid = s.guid
        )
        SELECT guid FROM subtree
    `;
    return rows.map(r => r.guid);
}

interface DatedAmount {
    dateKey: string;
    amount: number;
}

async function loadDatedAmounts(
    accountGuids: string[],
    startKey: string,
    endKey: string
): Promise<DatedAmount[]> {
    if (accountGuids.length === 0) return [];
    const splits = await prisma.splits.findMany({
        where: {
            account_guid: { in: accountGuids },
            transaction: {
                post_date: {
                    gte: new Date(`${startKey}T00:00:00.000Z`),
                    lte: new Date(`${endKey}T23:59:59.999Z`),
                },
            },
        },
        select: {
            quantity_num: true,
            quantity_denom: true,
            transaction: { select: { post_date: true } },
        },
    });
    const out: DatedAmount[] = [];
    for (const s of splits) {
        const d = s.transaction.post_date;
        if (!d) continue;
        out.push({
            dateKey: d.toISOString().slice(0, 10),
            amount: toDecimalNumber(s.quantity_num, s.quantity_denom),
        });
    }
    return out;
}

/**
 * Compute a per-period estimate for one budgeted account (subtree rollup).
 * Returns null when the budget does not exist.
 */
export async function computeBudgetEstimate(
    budgetGuid: string,
    accountGuid: string,
    method: EstimateMethod,
    months: number = 12
): Promise<BudgetEstimateResult | null> {
    const budget = await prisma.budgets.findUnique({
        where: { guid: budgetGuid },
        include: { recurrences: true },
    });
    if (!budget) return null;

    const todayKey = new Date().toISOString().slice(0, 10);
    const rec = budget.recurrences?.[0] ?? null;
    const recurrence: BudgetRecurrence = rec
        ? {
            periodType: rec.recurrence_period_type,
            mult: rec.recurrence_mult,
            periodStart: rec.recurrence_period_start.toISOString().slice(0, 10),
        }
        : { periodType: 'month', mult: 1, periodStart: `${todayKey.slice(0, 4)}-01-01` };

    const ranges = computePeriodRanges(recurrence, budget.num_periods);
    const guids = await loadSubtreeGuids(accountGuid);

    if (method === 'seasonal') {
        // Same calendar range as each period, shifted one year back.
        const priorRanges = ranges.map(r => ({
            start: shiftDateKeyOneYearBack(r.start),
            end: shiftDateKeyOneYearBack(r.end),
        }));
        const items = await loadDatedAmounts(
            guids,
            priorRanges[0].start,
            priorRanges[priorRanges.length - 1].end
        );
        const periodAmounts = bucketByRanges(items, priorRanges);
        return {
            method,
            months: 12,
            numPeriods: budget.num_periods,
            periodAmounts,
            total: round2(periodAmounts.reduce((s, v) => s + v, 0)),
            transactionCount: items.length,
        };
    }

    // average / median: monthly sums over the trailing complete months, then
    // a flat per-period amount scaled to the period length.
    const window = Math.max(1, Math.min(60, Math.floor(months)));
    const monthKeys = trailingMonthKeys(window);
    const monthRanges = monthKeys.map(key => {
        const [y, m] = key.split('-').map(n => parseInt(n, 10));
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return { start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, '0')}` };
    });
    const items = await loadDatedAmounts(
        guids,
        monthRanges[0].start,
        monthRanges[monthRanges.length - 1].end
    );
    const monthlySums = bucketByRanges(items, monthRanges);
    const stat = method === 'median' ? median(monthlySums) : mean(monthlySums);
    const perPeriod = round2(stat * monthsPerPeriod(recurrence.periodType, recurrence.mult));
    const periodAmounts = new Array(budget.num_periods).fill(perPeriod);

    return {
        method,
        months: window,
        numPeriods: budget.num_periods,
        periodAmounts,
        total: round2(perPeriod * budget.num_periods),
        transactionCount: items.length,
    };
}

/** Runtime guard for the API's method query param. */
export function parseEstimateMethod(raw: string | null): EstimateMethod {
    return ESTIMATE_METHODS.includes(raw as EstimateMethod)
        ? (raw as EstimateMethod)
        : 'average';
}
