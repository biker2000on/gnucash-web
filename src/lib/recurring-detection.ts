/**
 * Recurring-Charge / Subscription Detection
 *
 * Pure detection core (exported for tests) + a DB loader that pulls real
 * spending (splits hitting EXPENSE accounts whose counterpart is an
 * asset/liability account) scoped to the active book.
 *
 * Pipeline:
 *   1. Load spending transactions (date, description, amount, expense account)
 *   2. Normalize descriptions into merchant keys (strip digits, refs, noise)
 *   3. Group by merchant key; for groups with >= minOccurrences compute the
 *      median interval and classify a cadence (weekly / monthly / quarterly /
 *      annual) with an interval-consistency check (median absolute deviation)
 *   4. Report each detected series with amounts, status, and next expected date
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';
export type SeriesStatus = 'active' | 'new' | 'stopped';

/** A single real-spending transaction hitting an expense account. */
export interface SpendingTransaction {
    /** Post date of the transaction */
    date: Date;
    /** Raw transaction description */
    description: string;
    /** Expense amount in book currency (positive = money spent) */
    amount: number;
    /** GUID of the expense account */
    accountGuid: string;
    /** Display name (full path when available) of the expense account */
    accountName: string;
}

export interface RecurringSeries {
    /** Normalized merchant key used for grouping */
    merchantKey: string;
    /** Most common original description in the group */
    merchantLabel: string;
    cadence: Cadence;
    /** Median gap between charges, in days */
    medianIntervalDays: number;
    /** Number of charge occurrences (same-day charges merged) */
    occurrences: number;
    /** Amount of the most recent charge */
    currentAmount: number;
    /** Median amount of the charges before the most recent one */
    typicalAmount: number;
    /** (current - typical) / typical * 100 */
    amountChangePct: number;
    /** ISO date (YYYY-MM-DD) of the first charge */
    firstSeen: string;
    /** ISO date (YYYY-MM-DD) of the most recent charge */
    lastSeen: string;
    /** ISO date (YYYY-MM-DD) of the next expected charge (lastSeen + median interval) */
    nextExpected: string;
    status: SeriesStatus;
    /** Current amount normalized to a per-month cost */
    monthlyEquivalent: number;
    /** Expense account most frequently hit by this series */
    accountGuid: string;
    accountName: string;
}

export interface RecurringTotals {
    /** Series not marked stopped (includes 'new') */
    activeCount: number;
    /** Sum of monthlyEquivalent across non-stopped series */
    activeMonthlyTotal: number;
    /** activeMonthlyTotal * 12 */
    activeAnnualTotal: number;
    /** Non-stopped series whose amountChangePct > 5% */
    priceIncreaseCount: number;
    /** All detected series including stopped */
    totalSeries: number;
}

export interface RecurringDetectionResult {
    series: RecurringSeries[];
    totals: RecurringTotals;
}

export interface DetectOptions {
    /** Minimum number of occurrences before a series is considered (default 3) */
    minOccurrences?: number;
    /** "Current time" used for status classification (default: now) */
    now?: Date;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalize a transaction description into a merchant key.
 *
 * - lowercases
 * - converts punctuation/separators to spaces
 * - drops any token containing a digit (store numbers, dates, phone numbers,
 *   reference codes like "2H4KL9012" or "#12345")
 * - collapses whitespace
 *
 * Returns '' when nothing meaningful remains (caller should skip those).
 */
export function normalizeMerchant(description: string): string {
    return description
        .toLowerCase()
        // Separators and punctuation become spaces ("paypal *spotify" -> "paypal spotify")
        .replace(/[^a-z0-9&]+/g, ' ')
        .split(' ')
        .filter(token => token.length > 0 && !/\d/.test(token))
        .join(' ')
        .trim();
}

/* ------------------------------------------------------------------ */
/* Detection core (pure)                                                */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

interface CadenceBand {
    cadence: Cadence;
    minDays: number;
    maxDays: number;
    /** Max allowed median absolute deviation of intervals (days) */
    madLimitDays: number;
    /** Charges per month at this cadence */
    perMonth: number;
}

const CADENCE_BANDS: CadenceBand[] = [
    { cadence: 'weekly', minDays: 5, maxDays: 9, madLimitDays: 2, perMonth: 365.25 / 7 / 12 },
    { cadence: 'monthly', minDays: 28, maxDays: 32, madLimitDays: 4, perMonth: 1 },
    { cadence: 'quarterly', minDays: 85, maxDays: 97, madLimitDays: 10, perMonth: 1 / 3 },
    { cadence: 'annual', minDays: 350, maxDays: 380, madLimitDays: 20, perMonth: 1 / 12 },
];

/** How many median intervals past nextExpected before a series is 'stopped'. */
const STOPPED_GRACE_MULTIPLIER = 1.5;
/** A series whose first charge is within this window is 'new'. */
const NEW_SERIES_WINDOW_DAYS = 90;

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classifyCadence(medianIntervalDays: number): CadenceBand | null {
    return CADENCE_BANDS.find(
        b => medianIntervalDays >= b.minDays && medianIntervalDays <= b.maxDays,
    ) ?? null;
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function mostCommon<T>(values: T[]): T {
    const counts = new Map<T, number>();
    let best = values[0];
    let bestCount = 0;
    for (const v of values) {
        const c = (counts.get(v) ?? 0) + 1;
        counts.set(v, c);
        if (c > bestCount) {
            best = v;
            bestCount = c;
        }
    }
    return best;
}

/** One merged charge occurrence (same-day charges for a merchant are combined). */
interface Occurrence {
    date: Date;
    amount: number;
}

/**
 * Detect recurring charge series from a list of spending transactions.
 * Pure function — exported for unit tests.
 */
export function detectRecurringSeries(
    transactions: SpendingTransaction[],
    options: DetectOptions = {},
): RecurringDetectionResult {
    const minOccurrences = Math.max(2, options.minOccurrences ?? 3);
    const now = options.now ?? new Date();

    // Group by normalized merchant key
    const groups = new Map<string, SpendingTransaction[]>();
    for (const tx of transactions) {
        if (!(tx.amount > 0)) continue; // skip refunds / zero rows
        const key = normalizeMerchant(tx.description);
        if (!key) continue;
        const arr = groups.get(key);
        if (arr) arr.push(tx);
        else groups.set(key, [tx]);
    }

    const series: RecurringSeries[] = [];

    for (const [merchantKey, txs] of groups) {
        // Merge same-day charges into single occurrences (split transactions,
        // multi-line charges) so intervals of 0 days don't poison the stats.
        const byDay = new Map<string, Occurrence>();
        for (const tx of txs) {
            const dayKey = isoDate(tx.date);
            const existing = byDay.get(dayKey);
            if (existing) existing.amount += tx.amount;
            else byDay.set(dayKey, { date: tx.date, amount: tx.amount });
        }
        const occurrences = [...byDay.values()].sort(
            (a, b) => a.date.getTime() - b.date.getTime(),
        );
        if (occurrences.length < minOccurrences) continue;

        // Intervals between consecutive occurrences
        const intervals: number[] = [];
        for (let i = 1; i < occurrences.length; i++) {
            intervals.push(
                Math.round((occurrences[i].date.getTime() - occurrences[i - 1].date.getTime()) / DAY_MS),
            );
        }

        const medianInterval = median(intervals);
        const band = classifyCadence(medianInterval);
        if (!band) continue;

        // Interval consistency: median absolute deviation must be small
        // relative to the cadence, or this is just irregular spending.
        const mad = median(intervals.map(i => Math.abs(i - medianInterval)));
        if (mad > band.madLimitDays) continue;

        const first = occurrences[0];
        const last = occurrences[occurrences.length - 1];

        const currentAmount = last.amount;
        const previousAmounts = occurrences.slice(0, -1).map(o => o.amount);
        const typicalAmount = median(previousAmounts);
        const amountChangePct =
            typicalAmount > 0 ? ((currentAmount - typicalAmount) / typicalAmount) * 100 : 0;

        const nextExpectedMs = last.date.getTime() + medianInterval * DAY_MS;
        const stoppedAfterMs = nextExpectedMs + STOPPED_GRACE_MULTIPLIER * medianInterval * DAY_MS;
        const isStopped = now.getTime() > stoppedAfterMs;
        const isNew = now.getTime() - first.date.getTime() <= NEW_SERIES_WINDOW_DAYS * DAY_MS;
        const status: SeriesStatus = isStopped ? 'stopped' : isNew ? 'new' : 'active';

        const accountGuid = mostCommon(txs.map(t => t.accountGuid));
        const accountName =
            txs.find(t => t.accountGuid === accountGuid)?.accountName ?? '';

        series.push({
            merchantKey,
            merchantLabel: mostCommon(txs.map(t => t.description)),
            cadence: band.cadence,
            medianIntervalDays: medianInterval,
            occurrences: occurrences.length,
            currentAmount,
            typicalAmount,
            amountChangePct,
            firstSeen: isoDate(first.date),
            lastSeen: isoDate(last.date),
            nextExpected: isoDate(new Date(nextExpectedMs)),
            status,
            monthlyEquivalent: currentAmount * band.perMonth,
            accountGuid,
            accountName,
        });
    }

    // Most expensive first
    series.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);

    const active = series.filter(s => s.status !== 'stopped');
    const activeMonthlyTotal = active.reduce((sum, s) => sum + s.monthlyEquivalent, 0);

    return {
        series,
        totals: {
            activeCount: active.length,
            activeMonthlyTotal,
            activeAnnualTotal: activeMonthlyTotal * 12,
            priceIncreaseCount: active.filter(s => s.amountChangePct > 5).length,
            totalSeries: series.length,
        },
    };
}

/* ------------------------------------------------------------------ */
/* DB loader                                                            */
/* ------------------------------------------------------------------ */

interface SpendingRow {
    post_date: Date;
    description: string | null;
    value_num: bigint;
    value_denom: bigint;
    account_guid: string;
    account_name: string;
    account_fullname: string | null;
}

/**
 * Load real spending for the last `months` months: splits hitting EXPENSE
 * accounts where at least one counterpart split in the same transaction hits
 * an asset/liability-style account (bank, cash, credit card, loan, ...).
 * This excludes pure expense-to-expense recategorizations and equity moves.
 */
export async function loadSpendingTransactions(
    bookAccountGuids: string[],
    months: number,
): Promise<SpendingTransaction[]> {
    if (bookAccountGuids.length === 0) return [];

    const startDate = new Date();
    startDate.setUTCMonth(startDate.getUTCMonth() - months);

    const rows = await prisma.$queryRaw<SpendingRow[]>`
        SELECT
            t.post_date,
            t.description,
            s.value_num, s.value_denom,
            s.account_guid,
            a.name AS account_name,
            ah.fullname AS account_fullname
        FROM splits s
        JOIN accounts a ON a.guid = s.account_guid AND a.account_type = 'EXPENSE'
        JOIN transactions t ON t.guid = s.tx_guid
        LEFT JOIN account_hierarchy ah ON ah.guid = s.account_guid
        WHERE s.account_guid = ANY(${bookAccountGuids})
          AND t.post_date >= ${startDate}
          AND s.value_num > 0
          AND EXISTS (
              SELECT 1
              FROM splits s2
              JOIN accounts a2 ON a2.guid = s2.account_guid
              WHERE s2.tx_guid = t.guid
                AND s2.guid != s.guid
                AND a2.account_type IN ('BANK', 'CASH', 'CREDIT', 'LIABILITY', 'ASSET', 'PAYABLE')
          )
        ORDER BY t.post_date ASC
    `;

    return rows.map(row => ({
        date: row.post_date,
        description: row.description ?? '',
        amount: toDecimalNumber(row.value_num, row.value_denom),
        accountGuid: row.account_guid,
        accountName: row.account_fullname ?? row.account_name,
    }));
}

/**
 * Convenience: load spending for the active book and run detection.
 */
export async function detectRecurringCharges(
    bookAccountGuids: string[],
    options: { months?: number; minOccurrences?: number } = {},
): Promise<RecurringDetectionResult> {
    const months = options.months ?? 24;
    const transactions = await loadSpendingTransactions(bookAccountGuids, months);
    return detectRecurringSeries(transactions, {
        minOccurrences: options.minOccurrences ?? 3,
    });
}
