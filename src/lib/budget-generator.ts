/**
 * Auto-Budget Generation Engine
 *
 * Pure math (exported for unit tests) + a DB-bound loader used by
 * POST /api/budgets/generate:
 *
 * - `loadMonthlyActuals` buckets trailing N complete calendar months of
 *   actuals per EXPENSE (and optionally INCOME) account, book-scoped.
 * - `generateFromHistory` turns those monthly buckets into a suggested flat
 *   monthly amount per account (median by default).
 * - `applyTemplate` implements the "% of income" (50/30/20-style) and
 *   "zero-based" starting templates.
 * - `applyScenario` scales a set of amounts by a factor (lean 0.9 /
 *   stretch 1.1 / custom) with stable rounding.
 *
 * Zero-month semantics: the history window always spans exactly N months and
 * months with no activity count as 0 in the statistic. This is deliberate —
 * a bill paid 3 of the last 6 months should not be budgeted at its full
 * monthly amount, and the median (default) naturally resists both one-off
 * spikes and sporadic charges. Use `statistic: 'mean'` to smear irregular
 * spending evenly instead.
 *
 * Sign conventions (GnuCash): INCOME split quantities are stored negative
 * and are negated by the loader so "positive = earned". EXPENSE quantities
 * are already positive-spend (refunds subtract). Suggested amounts are
 * clamped at >= 0 — a net-refund account suggests $0, not a negative budget.
 */

import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { toDecimalNumber } from '@/lib/gnucash';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface MonthlyHistoryAccount {
    guid: string;
    name: string;
    /** Colon-delimited path below the book root, e.g. "Expenses:Dining" */
    fullname: string;
    /** GnuCash account type (EXPENSE or INCOME) */
    type: string;
    /**
     * Sign-corrected activity per month, oldest first. Always exactly
     * `months` entries; months without activity are 0.
     */
    monthly: number[];
}

export interface GeneratedLine {
    accountGuid: string;
    name: string;
    fullname: string;
    type: string;
    /** Suggested flat monthly budget amount (>= 0) */
    amount: number;
    /** Mean of the monthly history (informational, 2dp) */
    avgMonthly: number;
    /** The monthly history the suggestion was derived from */
    monthly: number[];
}

export type GenerateStatistic = 'median' | 'mean';

export interface GenerateOptions {
    statistic?: GenerateStatistic;
    /** Round suggestions to the nearest multiple (default $5). */
    roundTo?: number;
}

export type AllocationBucket = 'needs' | 'wants' | 'savings';

export interface PctOfIncomeContext {
    /** Estimated monthly income the percentages apply to. */
    monthlyIncome: number;
    /**
     * Allocation map, fraction of income per bucket (e.g. 50/30/20:
     * `{ needs: 0.5, wants: 0.3, savings: 0.2 }`). Buckets with no matching
     * accounts are skipped (their share stays unallocated).
     */
    allocations: Record<AllocationBucket, number>;
    /** Candidate accounts with their historical average monthly spend. */
    accounts: Array<{
        guid: string;
        name: string;
        fullname?: string;
        type: string;
        avgMonthly: number;
    }>;
    roundTo?: number;
}

export interface ZeroBasedContext {
    accounts: Array<{ guid: string; name: string; fullname?: string; type: string }>;
}

export interface LoadMonthlyActualsResult {
    /** YYYY-MM keys for the window, oldest first */
    monthKeys: string[];
    /** All candidate accounts (with or without activity), monthly buckets filled */
    accounts: MonthlyHistoryAccount[];
    /**
     * Median of total monthly income across the window (all book INCOME
     * accounts, regardless of `includeIncome`). 0 when there is no income.
     */
    monthlyIncomeEstimate: number;
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

/** Round to the nearest multiple of `roundTo` (falls back to cents when <= 0). */
export function roundToNearest(value: number, roundTo: number): number {
    if (!Number.isFinite(value)) return 0;
    if (!Number.isFinite(roundTo) || roundTo <= 0) return round2(value);
    return round2(Math.round(value / roundTo) * roundTo);
}

export function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

/* ------------------------------------------------------------------ */
/* From-history generation (pure)                                      */
/* ------------------------------------------------------------------ */

/**
 * Suggest a flat monthly amount per account from its monthly history.
 * Median by default (resists one-off spikes); zero months count as 0 (see
 * module doc). Suggestions are rounded to the nearest `roundTo` (default $5)
 * and clamped at >= 0.
 */
export function generateFromHistory(
    monthlyByAccount: MonthlyHistoryAccount[],
    options: GenerateOptions = {}
): GeneratedLine[] {
    const statistic = options.statistic ?? 'median';
    const roundTo = options.roundTo ?? 5;
    const stat = statistic === 'mean' ? mean : median;

    return monthlyByAccount.map(acc => ({
        accountGuid: acc.guid,
        name: acc.name,
        fullname: acc.fullname,
        type: acc.type,
        amount: Math.max(0, roundToNearest(stat(acc.monthly), roundTo)),
        avgMonthly: round2(mean(acc.monthly)),
        monthly: acc.monthly,
    }));
}

/* ------------------------------------------------------------------ */
/* Templates (pure)                                                    */
/* ------------------------------------------------------------------ */

const SAVINGS_PATTERN = /sav(e|ing)|invest|retire|401\s*k|403\s*b|\bira\b|roth|brokerage|pension|hsa|emergency fund/i;
const NEEDS_PATTERN = new RegExp(
    [
        'rent', 'mortgage', 'grocer', 'utilit', 'electric', 'gas\\b', 'water', 'sewer', 'trash',
        'insurance', 'medical', 'health', 'dental', 'pharmacy', 'doctor',
        'fuel', 'auto', '\\bcar\\b', 'transport', 'commut', 'parking',
        'loan', 'debt', 'interest', 'child\\s*care', 'daycare', 'tuition',
        'phone', 'internet', 'tax', 'housing', 'hoa',
    ].join('|'),
    'i'
);

/**
 * Map an account to a 50/30/20-style bucket by name keywords (checked
 * against the full path so "Expenses:Auto:Fuel" matches on any segment):
 *
 * - savings: savings/investing/retirement keywords (401k, IRA, brokerage, ...)
 * - needs: housing, groceries, utilities, insurance, medical, transport,
 *   debt service, childcare, phone/internet, taxes
 * - wants: everything else (dining, entertainment, travel, shopping, ...)
 */
export function classifyAllocationBucket(nameOrPath: string): AllocationBucket {
    if (SAVINGS_PATTERN.test(nameOrPath)) return 'savings';
    if (NEEDS_PATTERN.test(nameOrPath)) return 'needs';
    return 'wants';
}

/**
 * Apply a starting template:
 *
 * - `'zero-based'`: every account starts at 0 (allocate by hand afterwards).
 * - `'pct-of-income'`: each bucket gets `monthlyIncome * allocations[bucket]`,
 *   distributed across the bucket's accounts proportionally to their
 *   historical monthly share (negative history counts as 0). When a bucket
 *   has history totalling 0, its target is split equally across its
 *   accounts. Buckets with no accounts are skipped. Per-line rounding means
 *   bucket sums can drift from the target by up to roundTo/2 per account.
 */
export function applyTemplate(
    kind: 'pct-of-income',
    context: PctOfIncomeContext
): GeneratedLine[];
export function applyTemplate(kind: 'zero-based', context: ZeroBasedContext): GeneratedLine[];
export function applyTemplate(
    kind: 'pct-of-income' | 'zero-based',
    context: PctOfIncomeContext | ZeroBasedContext
): GeneratedLine[] {
    if (kind === 'zero-based') {
        const { accounts } = context as ZeroBasedContext;
        return accounts.map(acc => ({
            accountGuid: acc.guid,
            name: acc.name,
            fullname: acc.fullname ?? acc.name,
            type: acc.type,
            amount: 0,
            avgMonthly: 0,
            monthly: [],
        }));
    }

    const { monthlyIncome, allocations, accounts, roundTo = 5 } = context as PctOfIncomeContext;

    // Bucket the candidate accounts by keyword classification.
    const buckets = new Map<AllocationBucket, PctOfIncomeContext['accounts']>();
    for (const acc of accounts) {
        const bucket = classifyAllocationBucket(acc.fullname ?? acc.name);
        const list = buckets.get(bucket) ?? [];
        list.push(acc);
        buckets.set(bucket, list);
    }

    const lines: GeneratedLine[] = [];
    for (const [bucket, members] of buckets) {
        const pct = allocations[bucket] ?? 0;
        const target = Math.max(0, monthlyIncome * pct);
        const weights = members.map(m => Math.max(0, m.avgMonthly));
        const totalWeight = weights.reduce((s, w) => s + w, 0);

        members.forEach((acc, i) => {
            const share = totalWeight > 0 ? weights[i] / totalWeight : 1 / members.length;
            lines.push({
                accountGuid: acc.guid,
                name: acc.name,
                fullname: acc.fullname ?? acc.name,
                type: acc.type,
                amount: Math.max(0, roundToNearest(target * share, roundTo)),
                avgMonthly: round2(acc.avgMonthly),
                monthly: [],
            });
        });
    }
    return lines;
}

/* ------------------------------------------------------------------ */
/* Scenarios (pure)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Scale a list of amounts by a factor (lean 0.9 / stretch 1.1 / custom).
 * Rounds to the nearest `roundTo` (cents by default) so results are stable:
 * amounts already on the rounding grid pass through factor 1.0 unchanged.
 */
export function applyScenario(amounts: number[], factor: number, roundTo: number = 0.01): number[] {
    return amounts.map(a => roundToNearest(a * factor, roundTo));
}

/* ------------------------------------------------------------------ */
/* DB-bound loader                                                     */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** YYYY-MM keys for the N complete months preceding `now`'s month, oldest first. */
export function trailingMonthKeys(months: number, now: Date = new Date()): string[] {
    const keys: string[] = [];
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // current (partial) month index
    for (let i = months; i >= 1; i--) {
        const d = new Date(Date.UTC(y, m - i, 1));
        keys.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
    }
    return keys;
}

export interface LoadMonthlyActualsOptions {
    /** Number of complete trailing months (the partial current month is excluded). */
    months: number;
    /** Include INCOME accounts as candidates (default: EXPENSE only). */
    includeIncome?: boolean;
    /**
     * Restrict candidates to these accounts. When omitted, candidates are
     * all matching-type accounts with at least one split in the window.
     */
    accountGuids?: string[];
    /** Clock override for tests. */
    now?: Date;
}

/**
 * Load trailing monthly actuals per account, book-scoped. Candidate
 * accounts default to EXPENSE accounts with activity in the window;
 * `includeIncome` adds INCOME accounts (sign-corrected so positive =
 * earned). Also computes a monthly income estimate (median of monthly
 * income totals) for the %-of-income template.
 */
export async function loadMonthlyActuals(
    options: LoadMonthlyActualsOptions
): Promise<LoadMonthlyActualsResult> {
    const months = Math.max(1, Math.min(60, Math.floor(options.months)));
    const now = options.now ?? new Date();
    const monthKeys = trailingMonthKeys(months, now);
    const monthIndex = new Map(monthKeys.map((k, i) => [k, i]));

    const startDate = new Date(`${monthKeys[0]}-01T00:00:00.000Z`);
    const [lastY, lastM] = monthKeys[monthKeys.length - 1].split('-').map(n => parseInt(n, 10));
    const endDate = new Date(Date.UTC(lastY, lastM, 0, 23, 59, 59, 999)); // last day of last month

    const bookGuids = await getBookAccountGuids();

    // All book EXPENSE + INCOME accounts (income always loaded for the
    // income estimate, even when includeIncome is false).
    const accounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookGuids },
            account_type: { in: ['EXPENSE', 'INCOME'] },
        },
        select: { guid: true, name: true, parent_guid: true, account_type: true },
    });

    // Full paths below the book root ("Expenses:Dining"). Parents outside
    // the fetched set (root, placeholders of other types) end the chain.
    const byGuid = new Map(accounts.map(a => [a.guid, a]));
    const bookGuidSet = new Set(bookGuids);
    const fullnameOf = (guid: string): string => {
        const parts: string[] = [];
        let cur = byGuid.get(guid);
        let hops = 0;
        while (cur && hops < 32) {
            parts.unshift(cur.name);
            cur = cur.parent_guid && bookGuidSet.has(cur.parent_guid)
                ? byGuid.get(cur.parent_guid)
                : undefined;
            hops++;
        }
        return parts.join(':');
    };

    const allGuids = accounts.map(a => a.guid);
    const splits = allGuids.length === 0 ? [] : await prisma.splits.findMany({
        where: {
            account_guid: { in: allGuids },
            transaction: { post_date: { gte: startDate, lte: endDate } },
        },
        select: {
            account_guid: true,
            quantity_num: true,
            quantity_denom: true,
            transaction: { select: { post_date: true } },
        },
    });

    // Bucket sign-corrected split quantities into per-account month rows.
    const matrices = new Map<string, number[]>();
    for (const split of splits) {
        const postDate = split.transaction.post_date;
        if (!postDate) continue;
        const key = `${postDate.getUTCFullYear()}-${pad2(postDate.getUTCMonth() + 1)}`;
        const idx = monthIndex.get(key);
        if (idx === undefined) continue;
        let row = matrices.get(split.account_guid);
        if (!row) {
            row = new Array(months).fill(0);
            matrices.set(split.account_guid, row);
        }
        const raw = toDecimalNumber(split.quantity_num, split.quantity_denom);
        const type = byGuid.get(split.account_guid)?.account_type;
        row[idx] += type === 'INCOME' ? -raw : raw;
    }

    // Monthly income estimate: median of total monthly income.
    const incomeTotals = new Array(months).fill(0);
    for (const acc of accounts) {
        if (acc.account_type !== 'INCOME') continue;
        const row = matrices.get(acc.guid);
        if (!row) continue;
        for (let i = 0; i < months; i++) incomeTotals[i] += row[i];
    }
    const monthlyIncomeEstimate = Math.max(0, round2(median(incomeTotals)));

    // Candidate selection.
    const requested = options.accountGuids ? new Set(options.accountGuids) : null;
    const candidateTypes = new Set(options.includeIncome ? ['EXPENSE', 'INCOME'] : ['EXPENSE']);

    const result: MonthlyHistoryAccount[] = [];
    for (const acc of accounts) {
        if (!candidateTypes.has(acc.account_type)) continue;
        const row = matrices.get(acc.guid);
        if (requested) {
            if (!requested.has(acc.guid)) continue;
        } else if (!row || row.every(v => v === 0)) {
            continue; // default: only accounts with activity
        }
        result.push({
            guid: acc.guid,
            name: acc.name,
            fullname: fullnameOf(acc.guid),
            type: acc.account_type,
            monthly: (row ?? new Array(months).fill(0)).map(round2),
        });
    }
    result.sort((a, b) => a.fullname.localeCompare(b.fullname));

    return { monthKeys, accounts: result, monthlyIncomeEstimate };
}
