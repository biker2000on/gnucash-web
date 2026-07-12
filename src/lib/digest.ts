/**
 * Monthly Financial Digest
 *
 * Assembles a structured, month-scoped summary of a book's finances by pulling
 * each section from the existing services and detection engines:
 *  - net worth end value + month-over-month change (FinancialSummaryService)
 *  - income / expenses / savings rate for the month (FinancialSummaryService)
 *  - top expense categories with a MoM delta each (FinancialSummaryService)
 *  - new / changed / stopped subscriptions (recurring-detection)
 *  - upcoming bills in the next ~30 days (forecast/scheduled)
 *  - budget over/under per category when a budget exists (budgets)
 *
 * The DB-bound assembly (`generateDigest`) is thin: it loads section inputs and
 * feeds them to the pure transforms below, which are exported for unit testing.
 */

import prisma from '@/lib/prisma';
import { pickCurrentBudget } from '@/lib/budget-select';
import { getBaseCurrency } from '@/lib/currency';
import { getBookAccountGuids } from '@/lib/book-scope';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import { detectRecurringCharges, type RecurringSeries, type Cadence } from '@/lib/recurring-detection';
import { loadForecastData } from '@/lib/forecast-data';
import type { ForecastEvent } from '@/lib/forecast';
import { formatCurrency } from '@/lib/format';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface DigestMoM {
    /** current - prior */
    delta: number;
    /** MoM percent change (0 when prior is 0) */
    percent: number;
}

export interface DigestNetWorth {
    /** Net worth at the end of the digest month */
    end: number;
    /** Change vs the end of the prior month */
    change: number;
    changePercent: number;
}

export interface DigestCashFlow {
    income: number;
    expenses: number;
    savingsRate: number;
}

export interface DigestCategory {
    name: string;
    /** Spend in the digest month */
    amount: number;
    /** Spend in the prior month */
    priorAmount: number;
    /** amount - priorAmount */
    delta: number;
    /** MoM percent change */
    percent: number;
}

export type SubscriptionDirection = 'up' | 'down';

export interface DigestSubscription {
    label: string;
    accountName: string;
    cadence: Cadence;
    currentAmount: number;
    previousAmount: number;
    changePercent: number;
    /** Only set for changed subscriptions */
    direction?: SubscriptionDirection;
    lastSeen: string;
    nextExpected: string;
}

export interface DigestSubscriptions {
    new: DigestSubscription[];
    changed: DigestSubscription[];
    stopped: DigestSubscription[];
}

export interface DigestBill {
    /** YYYY-MM-DD */
    date: string;
    description: string;
    accountName: string;
    /** Negative = money leaving the account */
    amount: number;
}

export type BudgetStatusLevel = 'over' | 'under' | 'on_track';

export interface DigestBudgetRow {
    accountGuid: string;
    accountName: string;
    budgeted: number;
    actual: number;
    /** budgeted - actual (positive = under budget) */
    variance: number;
    status: BudgetStatusLevel;
}

export interface DigestBudget {
    budgetName: string;
    /** Period index within the budget that the month maps to, or null when unmapped */
    periodNum: number | null;
    rows: DigestBudgetRow[];
    totalBudgeted: number;
    totalActual: number;
    /** True when the month falls outside the budget's configured periods */
    outOfRange: boolean;
}

export interface MonthlyDigest {
    /** YYYY-MM */
    month: string;
    /** e.g. "July 2026" */
    monthLabel: string;
    generatedAt: string;
    currency: string;
    netWorth: DigestNetWorth;
    cashFlow: DigestCashFlow;
    topCategories: DigestCategory[];
    subscriptions: DigestSubscriptions;
    upcomingBills: DigestBill[];
    budget: DigestBudget | null;
    /**
     * Optional AI-written 3-5 sentence narrative. Present only when an AI
     * provider is configured AND the call succeeded — strictly best-effort.
     */
    narrative?: string;
}

export interface GenerateDigestOptions {
    /** Target month as YYYY-MM. Defaults to the current calendar month (UTC). */
    month?: string;
    /**
     * When set, an AI narrative is attempted using this user's AI config
     * (falls back to env config). Failures never block digest generation.
     */
    aiUserId?: number;
}

/** Amount lookup accepting either a Map or a plain record. */
type AmountLookup = Map<string, number> | Record<string, number>;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

function getAmount(lookup: AmountLookup, key: string): number {
    if (lookup instanceof Map) return lookup.get(key) ?? 0;
    return lookup[key] ?? 0;
}

function amountKeys(lookup: AmountLookup): string[] {
    return lookup instanceof Map ? [...lookup.keys()] : Object.keys(lookup);
}

function isoDateUTC(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Pure transforms (exported for tests)                                */
/* ------------------------------------------------------------------ */

/**
 * Month-over-month delta and percentage. Percent is 0 when the prior value is
 * 0 (no meaningful base to divide by); magnitude of the base is used so the
 * sign always reflects the direction of `delta`.
 */
export function momDelta(current: number, prior: number): DigestMoM {
    const delta = current - prior;
    const percent = prior !== 0 ? (delta / Math.abs(prior)) * 100 : 0;
    return { delta: round2(delta), percent: round2(percent) };
}

export interface MonthBounds {
    month: string;
    label: string;
    monthStart: Date;
    monthEnd: Date;
    priorMonthStart: Date;
    priorMonthEnd: Date;
    /** YYYY-MM-DD of the first day of the month */
    monthKeyStart: string;
    /** YYYY-MM-DD of the last day of the month */
    monthKeyEnd: string;
    year: number;
    /** 1-12 */
    monthNumber: number;
}

/** Validate and normalize a YYYY-MM string; defaults to the current UTC month. */
export function normalizeMonth(month?: string): string {
    if (!month) {
        const now = new Date();
        return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error(`Invalid month "${month}" (expected YYYY-MM)`);
    }
    return month;
}

/**
 * Compute the UTC date boundaries for a month and its prior month. All dates
 * are UTC so they align with how the services filter transaction post_date.
 */
export function monthBounds(month: string): MonthBounds {
    const normalized = normalizeMonth(month);
    const [year, monthNumber] = normalized.split('-').map(n => parseInt(n, 10));

    const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999));
    const priorMonthStart = new Date(Date.UTC(year, monthNumber - 2, 1, 0, 0, 0, 0));
    const priorMonthEnd = new Date(Date.UTC(year, monthNumber - 1, 0, 23, 59, 59, 999));

    const label = new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(monthStart);

    return {
        month: normalized,
        label,
        monthStart,
        monthEnd,
        priorMonthStart,
        priorMonthEnd,
        monthKeyStart: isoDateUTC(monthStart),
        monthKeyEnd: isoDateUTC(new Date(Date.UTC(year, monthNumber, 0))),
        year,
        monthNumber,
    };
}

/**
 * Rank the top expense categories for the current month and attach a MoM
 * delta for each. Categories are sorted by current-month spend, descending.
 */
export function rankTopCategories(
    current: AmountLookup,
    prior: AmountLookup,
    limit = 5
): DigestCategory[] {
    const rows: DigestCategory[] = amountKeys(current)
        .map(name => {
            const amount = getAmount(current, name);
            const priorAmount = getAmount(prior, name);
            const { delta, percent } = momDelta(amount, priorAmount);
            return {
                name,
                amount: round2(amount),
                priorAmount: round2(priorAmount),
                delta,
                percent,
            };
        })
        .filter(r => r.amount > 0);

    rows.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    return rows.slice(0, Math.max(0, limit));
}

export interface SubscriptionClassifyOptions {
    /** YYYY-MM-DD first day of the digest month */
    monthStart: string;
    /** YYYY-MM-DD last day of the digest month */
    monthEnd: string;
    /** Minimum absolute price-change percent to count as "changed" (default 5) */
    changeThresholdPct?: number;
}

function toDigestSubscription(
    s: RecurringSeries,
    direction?: SubscriptionDirection
): DigestSubscription {
    return {
        label: s.merchantLabel,
        accountName: s.accountName,
        cadence: s.cadence,
        currentAmount: round2(s.currentAmount),
        previousAmount: round2(s.typicalAmount),
        changePercent: round2(s.amountChangePct),
        direction,
        lastSeen: s.lastSeen,
        nextExpected: s.nextExpected,
    };
}

/**
 * Classify detected recurring series into what changed during the digest month:
 *  - new:     first charge landed within the month
 *  - changed: latest charge landed within the month and its amount moved by
 *             at least the threshold vs the typical amount (price up/down)
 *  - stopped: a renewal was expected within the month but the last charge
 *             predates the month (the charge never arrived)
 *
 * Pure: operates on absolute charge dates carried on each series, so it is
 * independent of "now".
 */
export function classifySubscriptionChanges(
    series: RecurringSeries[],
    options: SubscriptionClassifyOptions
): DigestSubscriptions {
    const { monthStart, monthEnd } = options;
    const threshold = options.changeThresholdPct ?? 5;

    const result: DigestSubscriptions = { new: [], changed: [], stopped: [] };

    for (const s of series) {
        const startedThisMonth = s.firstSeen >= monthStart && s.firstSeen <= monthEnd;
        const chargedThisMonth = s.lastSeen >= monthStart && s.lastSeen <= monthEnd;

        if (startedThisMonth) {
            result.new.push(toDigestSubscription(s));
            continue;
        }

        if (chargedThisMonth && Math.abs(s.amountChangePct) >= threshold) {
            result.changed.push(
                toDigestSubscription(s, s.amountChangePct >= 0 ? 'up' : 'down')
            );
            continue;
        }

        const expectedThisMonth = s.nextExpected >= monthStart && s.nextExpected <= monthEnd;
        if (s.lastSeen < monthStart && expectedThisMonth) {
            result.stopped.push(toDigestSubscription(s));
        }
    }

    const byAmount = (a: DigestSubscription, b: DigestSubscription) =>
        b.currentAmount - a.currentAmount || a.label.localeCompare(b.label);
    result.new.sort(byAmount);
    result.changed.sort(byAmount);
    result.stopped.sort(byAmount);

    return result;
}

/**
 * Reduce forecast events to upcoming bills — outflows only (amount < 0) —
 * sorted by date, then by size. Pure.
 */
export function summarizeUpcomingBills(events: ForecastEvent[], limit = 8): DigestBill[] {
    const bills = events
        .filter(e => e.amount < 0)
        .map(e => ({
            date: e.date,
            description: e.description,
            accountName: e.accountName,
            amount: round2(e.amount),
        }));

    bills.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
    return bills.slice(0, Math.max(0, limit));
}

export interface BudgetLine {
    accountGuid: string;
    accountName: string;
    /** Budgeted amount for the period */
    amount: number;
}

/**
 * Compare budgeted amounts against actual spend per account. A row is `over`
 * when actual exceeds budgeted (beyond the tolerance), `under` when it falls
 * short, and `on_track` within the tolerance. Sorted most-over first. Pure.
 */
export function computeBudgetStatus(
    budgeted: BudgetLine[],
    actualByAccount: AmountLookup,
    tolerance = 0.005
): DigestBudgetRow[] {
    const rows: DigestBudgetRow[] = budgeted.map(line => {
        const actual = round2(getAmount(actualByAccount, line.accountGuid));
        const budget = round2(line.amount);
        const variance = round2(budget - actual);
        let status: BudgetStatusLevel;
        if (actual > budget + tolerance) status = 'over';
        else if (actual < budget - tolerance) status = 'under';
        else status = 'on_track';
        return {
            accountGuid: line.accountGuid,
            accountName: line.accountName,
            budgeted: budget,
            actual,
            variance,
            status,
        };
    });

    rows.sort((a, b) => a.variance - b.variance || a.accountName.localeCompare(b.accountName));
    return rows;
}

/**
 * Render a short markdown summary of a digest, suitable for a notification
 * body. Pure — formatting only.
 */
export function digestToSummaryText(digest: MonthlyDigest): string {
    const fmt = (n: number) => formatCurrency(n, digest.currency);
    const signed = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n)}`;
    const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

    const lines: string[] = [];
    lines.push(`## Monthly Financial Digest — ${digest.monthLabel}`);
    lines.push('');

    if (digest.narrative) {
        lines.push(digest.narrative);
        lines.push('');
    }

    const nwArrow = digest.netWorth.change > 0 ? '▲' : digest.netWorth.change < 0 ? '▼' : '—';
    lines.push(
        `**Net worth:** ${fmt(digest.netWorth.end)} ` +
        `(${nwArrow} ${signed(digest.netWorth.change)}, ${pct(digest.netWorth.changePercent)} vs prior month)`
    );
    lines.push(
        `**Income:** ${fmt(digest.cashFlow.income)}  •  ` +
        `**Expenses:** ${fmt(digest.cashFlow.expenses)}  •  ` +
        `**Savings rate:** ${digest.cashFlow.savingsRate.toFixed(1)}%`
    );

    if (digest.topCategories.length > 0) {
        lines.push('');
        lines.push('**Top categories**');
        for (const c of digest.topCategories) {
            lines.push(`- ${c.name}: ${fmt(c.amount)} (${pct(c.percent)} MoM)`);
        }
    }

    const subs = digest.subscriptions;
    if (subs.new.length || subs.changed.length || subs.stopped.length) {
        lines.push('');
        lines.push(
            `**Subscriptions:** ${subs.new.length} new, ` +
            `${subs.changed.length} changed, ${subs.stopped.length} stopped`
        );
        for (const s of subs.changed) {
            const dir = s.direction === 'up' ? 'up' : 'down';
            lines.push(`- ${s.label} price ${dir} to ${fmt(s.currentAmount)} (${pct(s.changePercent)})`);
        }
    }

    if (digest.upcomingBills.length > 0) {
        const total = digest.upcomingBills.reduce((sum, b) => sum + b.amount, 0);
        lines.push('');
        lines.push(
            `**Upcoming bills (next 30 days):** ${digest.upcomingBills.length} ` +
            `totaling ${fmt(Math.abs(total))}`
        );
    }

    if (digest.budget && digest.budget.rows.length > 0) {
        const over = digest.budget.rows.filter(r => r.status === 'over').length;
        const under = digest.budget.rows.filter(r => r.status === 'under').length;
        lines.push('');
        lines.push(
            `**Budget (${digest.budget.budgetName}):** over on ${over}, under on ${under} ` +
            `of ${digest.budget.rows.length} categories`
        );
    }

    return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* DB-bound section loaders                                            */
/* ------------------------------------------------------------------ */

/**
 * Map a set of expense account GUIDs to their top-level category name (the
 * first segment under the root, e.g. "Food" in "Expenses:Food:Groceries")
 * using the account_hierarchy view.
 */
async function loadCategoryNames(accountGuids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (accountGuids.length === 0) return map;

    const rows = await prisma.$queryRaw<Array<{
        guid: string;
        level1: string | null;
        level2: string | null;
        name: string;
    }>>`
        SELECT guid, level1, level2, name
        FROM account_hierarchy
        WHERE guid = ANY(${accountGuids})
    `;

    for (const r of rows) {
        map.set(r.guid, r.level2 || r.level1 || r.name);
    }
    return map;
}

/** Group a per-account expense map into per-category totals. */
function categorize(
    expenseByAccount: Map<string, number>,
    categoryNames: Map<string, string>
): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const [accountGuid, amount] of expenseByAccount) {
        const name = categoryNames.get(accountGuid) || 'Other';
        totals[name] = (totals[name] || 0) + amount;
    }
    return totals;
}

/**
 * Build the budget section for the month. Approximation: the first budget in
 * the book is used, and the month is mapped to a budget period by whole-month
 * offset from the budget's recurrence period_start (i.e. monthly periods are
 * assumed). Returns null when no budget exists.
 */
async function loadBudgetSection(
    bounds: MonthBounds,
    actualByAccount: Map<string, number>
): Promise<DigestBudget | null> {
    // Pick the budget covering the digest month (falling back to the most
    // recently ended) — never alphabetical-first, which pinned old budgets.
    const candidates = await prisma.budgets.findMany({ include: { recurrences: true } });
    const monthDate = new Date(Date.UTC(bounds.year, bounds.monthNumber - 1, 15));
    const picked = pickCurrentBudget(candidates, monthDate);
    if (!picked) return null;

    const budget = await prisma.budgets.findUnique({
        where: { guid: picked.guid },
        include: {
            recurrences: true,
            amounts: {
                include: { account: { select: { name: true, account_type: true } } },
            },
        },
    });
    if (!budget) return null;

    const recurrence = budget.recurrences?.[0] ?? null;

    // Map the month to a budget period index (assumes monthly periods).
    let periodNum: number | null = null;
    let outOfRange = true;
    if (recurrence) {
        const ps = recurrence.recurrence_period_start;
        const offset =
            (bounds.year - ps.getUTCFullYear()) * 12 +
            (bounds.monthNumber - 1 - ps.getUTCMonth());
        if (offset >= 0 && offset < budget.num_periods) {
            periodNum = offset;
            outOfRange = false;
        }
    }

    const lines: BudgetLine[] = [];
    if (periodNum !== null) {
        for (const amt of budget.amounts) {
            if (amt.period_num !== periodNum) continue;
            // Only report expense-account budget lines with a non-zero budget.
            if (amt.account.account_type !== 'EXPENSE') continue;
            const budgetedValue =
                Number(amt.amount_num) / (Number(amt.amount_denom) || 1);
            if (budgetedValue <= 0) continue;
            lines.push({
                accountGuid: amt.account_guid,
                accountName: amt.account.name,
                amount: budgetedValue,
            });
        }
    }

    const rows = computeBudgetStatus(lines, actualByAccount);
    const totalBudgeted = round2(rows.reduce((s, r) => s + r.budgeted, 0));
    const totalActual = round2(rows.reduce((s, r) => s + r.actual, 0));

    return {
        budgetName: budget.name,
        periodNum,
        rows,
        totalBudgeted,
        totalActual,
        outOfRange,
    };
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

/**
 * Assemble the full monthly digest for a book. `bookGuid` is accepted for API
 * symmetry and future multi-book use; section queries are scoped to the active
 * book via `getBookAccountGuids()`.
 */
export async function generateDigest(
    bookGuid: string,
    options: GenerateDigestOptions = {}
): Promise<MonthlyDigest> {
    const bounds = monthBounds(normalizeMonth(options.month));
    const bookAccountGuids = await getBookAccountGuids();
    const baseCurrency = await getBaseCurrency();
    const currency = baseCurrency?.mnemonic ?? 'USD';

    // Net worth: change is end-of-month vs end-of-prior-month.
    const nwSummary = await FinancialSummaryService.computeNetWorthSummary(
        bookAccountGuids,
        bounds.priorMonthEnd,
        bounds.monthEnd,
        baseCurrency
    );

    // Income / expenses for the month and the prior month (for category deltas).
    const currentIE = await FinancialSummaryService.computeIncomeExpenses(
        bookAccountGuids,
        bounds.monthStart,
        bounds.monthEnd,
        baseCurrency
    );
    const priorIE = await FinancialSummaryService.computeIncomeExpenses(
        bookAccountGuids,
        bounds.priorMonthStart,
        bounds.priorMonthEnd,
        baseCurrency
    );
    const savingsRate = FinancialSummaryService.computeSavingsRate(
        currentIE.totalIncome,
        currentIE.totalExpenses
    );

    // Top categories with MoM delta.
    const categoryGuids = [
        ...new Set([
            ...currentIE.expenseByAccount.keys(),
            ...priorIE.expenseByAccount.keys(),
        ]),
    ];
    const categoryNames = await loadCategoryNames(categoryGuids);
    const topCategories = rankTopCategories(
        categorize(currentIE.expenseByAccount, categoryNames),
        categorize(priorIE.expenseByAccount, categoryNames),
        5
    );

    // Subscriptions: detect over a 24-month window; classify against the month.
    let subscriptions: DigestSubscriptions = { new: [], changed: [], stopped: [] };
    try {
        const detection = await detectRecurringCharges(bookAccountGuids, { months: 24 });
        subscriptions = classifySubscriptionChanges(detection.series, {
            monthStart: bounds.monthKeyStart,
            monthEnd: bounds.monthKeyEnd,
        });
    } catch (error) {
        console.error('Digest: subscription detection failed:', error);
    }

    // Upcoming bills in the next 30 days (from today, forecast-driven).
    let upcomingBills: DigestBill[] = [];
    try {
        const forecast = await loadForecastData({
            bookAccountGuids,
            accountGuids: null,
            horizonDays: 30,
        });
        upcomingBills = summarizeUpcomingBills(forecast.events, 8);
    } catch (error) {
        console.error('Digest: forecast load failed:', error);
    }

    // Budget status (best-effort; approximated monthly periods).
    let budget: DigestBudget | null = null;
    try {
        budget = await loadBudgetSection(bounds, currentIE.expenseByAccount);
    } catch (error) {
        console.error('Digest: budget section failed:', error);
    }

    const digest: MonthlyDigest = {
        month: bounds.month,
        monthLabel: bounds.label,
        generatedAt: new Date().toISOString(),
        currency,
        netWorth: {
            end: round2(nwSummary.end.netWorth),
            change: round2(nwSummary.change),
            changePercent: round2(nwSummary.changePercent),
        },
        cashFlow: {
            income: round2(currentIE.totalIncome),
            expenses: round2(currentIE.totalExpenses),
            savingsRate: round2(savingsRate),
        },
        topCategories,
        subscriptions,
        upcomingBills,
        budget,
    };

    // Optional AI narrative — strictly best-effort, never blocks the digest.
    if (options.aiUserId !== undefined) {
        try {
            const { getAiConfig } = await import('@/lib/ai-config');
            const { isAiConfigured } = await import('@/lib/ai-query/client');
            const { generateDigestNarrative, narrativeClientFor } = await import('@/lib/digest-narrative');

            const config = await getAiConfig(options.aiUserId);
            if (isAiConfigured(config)) {
                const result = await generateDigestNarrative(digest, narrativeClientFor(config));
                if (result) digest.narrative = result.narrative;
            }
        } catch (error) {
            console.error('Digest: narrative generation failed:', error);
        }
    }

    return digest;
}
