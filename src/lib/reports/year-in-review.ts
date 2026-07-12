/**
 * Year in Review — the annual sibling of the monthly digest.
 *
 * Assembles a "wrapped"-style set of self-contained stat cards for one
 * calendar year. Every card is nullable: when its underlying data is empty
 * the card is omitted so the page can skip it. The card builders are PURE
 * (exported for unit tests); DB access lives in generateYearInReview.
 *
 * Cards:
 *  - netWorth        start → end arc + attribution summary (net-worth-attribution)
 *  - cashFlow        income earned, spending, savings rate
 *  - topCategories   top 5 spending categories with YoY deltas
 *  - biggestExpense  largest single expense split of the year
 *  - dividends       dividend income with YoY delta and top payers
 *  - holdings        best / worst performing holding (simple return)
 *  - realizedGains   realized short/long-term gains + taxes paid (tax mappings)
 *  - subscriptions   recurring charges added / dropped during the year
 *  - busiestMerchant most-visited merchant (normalized description)
 *  - budgetStreak    months under budget + longest streak
 */

import prisma from '@/lib/prisma';
import { pickCurrentBudget } from '@/lib/budget-select';
import { toDecimalNumber } from '@/lib/gnucash';
import { getBaseCurrency } from '@/lib/currency';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import {
    generateNetWorthAttribution,
    type MarketDrillRow,
    type NetWorthAttributionData,
} from '@/lib/reports/net-worth-attribution';
import {
    loadDividendPayments,
    totalDividendsForYear,
    perSecurityDividends,
} from '@/lib/dividends';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { summarizeTaxPayments } from '@/lib/tax/payments';
import {
    loadSpendingTransactions,
    detectRecurringSeries,
    normalizeMerchant,
    type RecurringSeries,
    type SpendingTransaction,
    type Cadence,
} from '@/lib/recurring-detection';

/* ------------------------------------------------------------------ */
/* Card types                                                          */
/* ------------------------------------------------------------------ */

export interface YirNetWorthCard {
    start: number;
    end: number;
    change: number;
    /** 0 when the starting base is 0 */
    changePercent: number;
    savings: number;
    marketGains: number;
    debtPaydown: number;
    other: number;
}

export interface YirCashFlowCard {
    income: number;
    expenses: number;
    net: number;
    savingsRate: number;
}

export interface YirCategoryRow {
    name: string;
    amount: number;
    priorAmount: number;
    delta: number;
    /** YoY percent change; 0 when prior is 0 */
    percent: number;
}

export interface YirBiggestExpenseCard {
    /** YYYY-MM-DD */
    date: string;
    description: string;
    accountName: string;
    amount: number;
}

export interface YirDividendCard {
    total: number;
    priorTotal: number;
    delta: number;
    paymentCount: number;
    topPayers: Array<{ ticker: string; amount: number }>;
}

export interface YirHoldingPerf {
    accountGuid: string;
    name: string;
    gain: number;
    /** Simple return: gain / (startValue + positive net invested), percent */
    returnPct: number;
    startValue: number;
    endValue: number;
    netInvested: number;
}

export interface YirHoldingsCard {
    best: YirHoldingPerf;
    /** Omitted when only one holding is eligible */
    worst: YirHoldingPerf | null;
}

export interface YirTaxesPaid {
    federalWithholding: number;
    federalEstimated: number;
    stateWithholding: number;
    stateEstimated: number;
    totalPaid: number;
}

export interface YirRealizedGainsCard {
    shortTerm: number;
    longTerm: number;
    total: number;
    /** Null when no tax mappings exist in the book */
    taxes: YirTaxesPaid | null;
}

export interface YirSubscriptionItem {
    label: string;
    accountName: string;
    cadence: Cadence;
    amount: number;
    monthlyEquivalent: number;
    /** firstSeen for added, lastSeen for dropped (YYYY-MM-DD) */
    date: string;
}

export interface YirSubscriptionsCard {
    added: YirSubscriptionItem[];
    dropped: YirSubscriptionItem[];
}

export interface YirMerchantCard {
    merchant: string;
    visits: number;
    total: number;
    averageAmount: number;
}

export interface YirBudgetMonth {
    /** YYYY-MM */
    month: string;
    budgeted: number;
    actual: number;
    under: boolean;
}

export interface YirBudgetStreakCard {
    budgetName: string;
    monthsEvaluated: number;
    monthsUnderBudget: number;
    longestStreak: number;
    monthly: YirBudgetMonth[];
}

export interface YearInReviewData {
    year: number;
    generatedAt: string;
    currency: string;
    cards: {
        netWorth: YirNetWorthCard | null;
        cashFlow: YirCashFlowCard | null;
        topCategories: YirCategoryRow[] | null;
        biggestExpense: YirBiggestExpenseCard | null;
        dividends: YirDividendCard | null;
        holdings: YirHoldingsCard | null;
        realizedGains: YirRealizedGainsCard | null;
        subscriptions: YirSubscriptionsCard | null;
        busiestMerchant: YirMerchantCard | null;
        budgetStreak: YirBudgetStreakCard | null;
    };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Pure card builders (exported for tests)                             */
/* ------------------------------------------------------------------ */

/** Net-worth card straight from an attribution result. Null when the book is flat. */
export function buildNetWorthCard(
    attribution: Pick<
        NetWorthAttributionData,
        'startNetWorth' | 'endNetWorth' | 'totalChange' | 'components'
    >
): YirNetWorthCard | null {
    const { startNetWorth, endNetWorth, totalChange, components } = attribution;
    if (
        Math.abs(startNetWorth) < 0.005 &&
        Math.abs(endNetWorth) < 0.005 &&
        Math.abs(totalChange) < 0.005
    ) {
        return null;
    }
    return {
        start: startNetWorth,
        end: endNetWorth,
        change: totalChange,
        changePercent:
            startNetWorth !== 0 ? round2((totalChange / Math.abs(startNetWorth)) * 100) : 0,
        savings: components.savings,
        marketGains: components.marketGains,
        debtPaydown: components.debtPaydown,
        other: components.other,
    };
}

/** Cash-flow card. Null when the year had neither income nor expenses. */
export function buildCashFlowCard(
    totalIncome: number,
    totalExpenses: number
): YirCashFlowCard | null {
    if (Math.abs(totalIncome) < 0.005 && Math.abs(totalExpenses) < 0.005) return null;
    return {
        income: round2(totalIncome),
        expenses: round2(totalExpenses),
        net: round2(totalIncome - totalExpenses),
        savingsRate: round2(FinancialSummaryService.computeSavingsRate(totalIncome, totalExpenses)),
    };
}

/**
 * Rank the top spending categories with a YoY delta each.
 * Null when there was no spending.
 */
export function buildTopCategories(
    current: Record<string, number>,
    prior: Record<string, number>,
    limit = 5
): YirCategoryRow[] | null {
    const rows: YirCategoryRow[] = Object.keys(current)
        .map(name => {
            const amount = current[name] ?? 0;
            const priorAmount = prior[name] ?? 0;
            const delta = amount - priorAmount;
            return {
                name,
                amount: round2(amount),
                priorAmount: round2(priorAmount),
                delta: round2(delta),
                percent: priorAmount !== 0 ? round2((delta / Math.abs(priorAmount)) * 100) : 0,
            };
        })
        .filter(r => r.amount > 0);

    rows.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    const top = rows.slice(0, Math.max(0, limit));
    return top.length > 0 ? top : null;
}

/**
 * Best/worst performing holding by simple return over the year, from the
 * attribution market drill-down. A holding is eligible when it has a
 * meaningful invested base (startValue + positive net invested). Null when
 * nothing is eligible; `worst` is null when only one holding qualifies.
 */
export function buildHoldingsCard(marketRows: MarketDrillRow[]): YirHoldingsCard | null {
    const MIN_BASE = 1; // ignore dust positions

    const perf: YirHoldingPerf[] = [];
    for (const row of marketRows) {
        const base = row.startValue + Math.max(0, row.netInvested);
        if (base < MIN_BASE) continue;
        perf.push({
            accountGuid: row.accountGuid,
            name: row.name,
            gain: row.gain,
            returnPct: round2((row.gain / base) * 100),
            startValue: row.startValue,
            endValue: row.endValue,
            netInvested: row.netInvested,
        });
    }
    if (perf.length === 0) return null;

    perf.sort((a, b) => b.returnPct - a.returnPct || a.name.localeCompare(b.name));
    return {
        best: perf[0],
        worst: perf.length > 1 ? perf[perf.length - 1] : null,
    };
}

/** Dividend card. Null when neither this year nor last year paid anything. */
export function buildDividendCard(
    total: number,
    priorTotal: number,
    paymentCount: number,
    topPayers: Array<{ ticker: string; amount: number }>
): YirDividendCard | null {
    if (Math.abs(total) < 0.005 && Math.abs(priorTotal) < 0.005) return null;
    return {
        total: round2(total),
        priorTotal: round2(priorTotal),
        delta: round2(total - priorTotal),
        paymentCount,
        topPayers: topPayers
            .filter(p => p.amount > 0)
            .slice(0, 5)
            .map(p => ({ ticker: p.ticker, amount: round2(p.amount) })),
    };
}

function toSubscriptionItem(s: RecurringSeries, date: string): YirSubscriptionItem {
    return {
        label: s.merchantLabel,
        accountName: s.accountName,
        cadence: s.cadence,
        amount: round2(s.currentAmount),
        monthlyEquivalent: round2(s.monthlyEquivalent),
        date,
    };
}

/**
 * Classify recurring series into subscriptions added / dropped during the
 * year. Added: first charge landed within the year. Dropped: the series is
 * stopped (no charge since ~2 expected renewals) and its next expected
 * charge fell within the year. Null when both lists are empty.
 */
export function classifyYearSubscriptions(
    series: RecurringSeries[],
    year: number
): YirSubscriptionsCard | null {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const added: YirSubscriptionItem[] = [];
    const dropped: YirSubscriptionItem[] = [];

    for (const s of series) {
        if (s.firstSeen >= yearStart && s.firstSeen <= yearEnd) {
            added.push(toSubscriptionItem(s, s.firstSeen));
        }
        if (s.status === 'stopped' && s.nextExpected >= yearStart && s.nextExpected <= yearEnd) {
            dropped.push(toSubscriptionItem(s, s.lastSeen));
        }
    }

    const byMonthly = (a: YirSubscriptionItem, b: YirSubscriptionItem) =>
        b.monthlyEquivalent - a.monthlyEquivalent || a.label.localeCompare(b.label);
    added.sort(byMonthly);
    dropped.sort(byMonthly);

    if (added.length === 0 && dropped.length === 0) return null;
    return { added, dropped };
}

/**
 * Busiest merchant of the year by number of expense transactions, using the
 * same description normalization as recurring detection. Ties break on
 * total spend. Null when no merchant was visited at least `minVisits` times.
 */
export function pickBusiestMerchant(
    transactions: SpendingTransaction[],
    year: number,
    minVisits = 3
): YirMerchantCard | null {
    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd = Date.UTC(year + 1, 0, 1);

    const groups = new Map<string, { label: string; visits: number; total: number }>();
    for (const tx of transactions) {
        const t = tx.date.getTime();
        if (t < yearStart || t >= yearEnd) continue;
        const key = normalizeMerchant(tx.description);
        if (!key) continue;
        const g = groups.get(key);
        if (g) {
            g.visits += 1;
            g.total += tx.amount;
        } else {
            groups.set(key, { label: tx.description.trim() || key, visits: 1, total: tx.amount });
        }
    }

    let best: { label: string; visits: number; total: number } | null = null;
    for (const g of groups.values()) {
        if (!best || g.visits > best.visits || (g.visits === best.visits && g.total > best.total)) {
            best = g;
        }
    }
    if (!best || best.visits < minVisits) return null;

    return {
        merchant: best.label,
        visits: best.visits,
        total: round2(best.total),
        averageAmount: round2(best.total / best.visits),
    };
}

/**
 * Months-under-budget streak from monthly budget vs actual rows. A month is
 * "under" when actual <= budgeted. Null when no months could be evaluated.
 */
export function buildBudgetStreak(
    budgetName: string,
    months: Array<{ month: string; budgeted: number; actual: number }>
): YirBudgetStreakCard | null {
    const evaluated = months.filter(m => m.budgeted > 0);
    if (evaluated.length === 0) return null;

    const monthly: YirBudgetMonth[] = evaluated.map(m => ({
        month: m.month,
        budgeted: round2(m.budgeted),
        actual: round2(m.actual),
        under: m.actual <= m.budgeted + 0.005,
    }));

    let monthsUnder = 0;
    let longest = 0;
    let run = 0;
    for (const m of monthly) {
        if (m.under) {
            monthsUnder += 1;
            run += 1;
            longest = Math.max(longest, run);
        } else {
            run = 0;
        }
    }

    return {
        budgetName,
        monthsEvaluated: monthly.length,
        monthsUnderBudget: monthsUnder,
        longestStreak: longest,
        monthly,
    };
}

/* ------------------------------------------------------------------ */
/* DB-bound section loaders                                            */
/* ------------------------------------------------------------------ */

/**
 * Map expense account GUIDs to their top-level category name under the root
 * (mirrors the digest's categorization, via the account_hierarchy view).
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

function categorize(
    expenseByAccount: Map<string, number>,
    categoryNames: Map<string, string>
): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const [guid, amount] of expenseByAccount) {
        const name = categoryNames.get(guid) || 'Other';
        totals[name] = (totals[name] || 0) + amount;
    }
    return totals;
}

interface BiggestExpenseRow {
    post_date: Date;
    description: string | null;
    account_name: string;
    value_num: bigint;
    value_denom: bigint;
}

async function loadBiggestExpense(
    bookAccountGuids: string[],
    yearStart: Date,
    yearEnd: Date
): Promise<YirBiggestExpenseCard | null> {
    const rows = await prisma.$queryRaw<BiggestExpenseRow[]>`
        SELECT
            t.post_date,
            t.description,
            COALESCE(ah.fullname, a.name) AS account_name,
            s.value_num, s.value_denom
        FROM splits s
        JOIN accounts a ON a.guid = s.account_guid AND a.account_type = 'EXPENSE'
        JOIN transactions t ON t.guid = s.tx_guid
        LEFT JOIN account_hierarchy ah ON ah.guid = s.account_guid
        WHERE s.account_guid = ANY(${bookAccountGuids})
          AND t.post_date >= ${yearStart}
          AND t.post_date <= ${yearEnd}
          AND s.value_num > 0
        ORDER BY s.value_num::numeric / NULLIF(s.value_denom, 0) DESC
        LIMIT 1
    `;
    if (rows.length === 0) return null;

    const r = rows[0];
    const amount = toDecimalNumber(r.value_num, r.value_denom);
    if (amount < 0.005) return null;

    return {
        date: isoDate(r.post_date),
        description: r.description ?? '',
        accountName: r.account_name,
        amount: round2(amount),
    };
}

interface MonthlyActualRow {
    account_guid: string;
    month_num: number;
    total: unknown;
}

/**
 * Budget-streak section: maps each month of the year onto a period of the
 * first budget (whole-month offset from the budget's period start, matching
 * the digest's approximation), sums budgeted expense lines per month, and
 * compares against actual spend in the budgeted accounts. Months after
 * `now` are not evaluated.
 */
async function loadBudgetStreak(
    bookAccountGuids: string[],
    year: number,
    now: Date
): Promise<YirBudgetStreakCard | null> {
    // Prefer the budget covering the review year (mid-year reference), not
    // the alphabetically-first budget.
    const candidates = await prisma.budgets.findMany({ include: { recurrences: true } });
    const picked = pickCurrentBudget(candidates, new Date(Date.UTC(year, 6, 1)));
    if (!picked) return null;

    const budget = await prisma.budgets.findUnique({
        where: { guid: picked.guid },
        include: {
            recurrences: true,
            amounts: {
                include: { account: { select: { account_type: true } } },
            },
        },
    });
    if (!budget) return null;

    const recurrence = budget.recurrences?.[0] ?? null;
    if (!recurrence) return null;

    const bookGuidSet = new Set(bookAccountGuids);
    const ps = recurrence.recurrence_period_start;

    // Budgeted expense totals + account set per month of the year
    const budgetedByMonth = new Map<number, number>(); // 1-12 -> budgeted total
    const budgetedAccounts = new Set<string>();

    for (let monthNum = 1; monthNum <= 12; monthNum++) {
        const offset =
            (year - ps.getUTCFullYear()) * 12 + (monthNum - 1 - ps.getUTCMonth());
        if (offset < 0 || offset >= budget.num_periods) continue;

        let total = 0;
        for (const amt of budget.amounts) {
            if (amt.period_num !== offset) continue;
            if (amt.account.account_type !== 'EXPENSE') continue;
            if (!bookGuidSet.has(amt.account_guid)) continue;
            const value = Number(amt.amount_num) / (Number(amt.amount_denom) || 1);
            if (value <= 0) continue;
            total += value;
            budgetedAccounts.add(amt.account_guid);
        }
        if (total > 0) budgetedByMonth.set(monthNum, total);
    }

    if (budgetedByMonth.size === 0 || budgetedAccounts.size === 0) return null;

    // Actual spend per budgeted account per month
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    const accountList = [...budgetedAccounts];

    const actualRows = await prisma.$queryRaw<MonthlyActualRow[]>`
        SELECT
            s.account_guid,
            EXTRACT(MONTH FROM t.post_date)::int AS month_num,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)) AS total
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${accountList})
          AND t.post_date >= ${yearStart}
          AND t.post_date <= ${yearEnd}
        GROUP BY s.account_guid, EXTRACT(MONTH FROM t.post_date)
    `;

    const actualByMonth = new Map<number, number>();
    for (const row of actualRows) {
        const n = parseFloat(String(row.total ?? 0));
        if (!Number.isFinite(n)) continue;
        actualByMonth.set(row.month_num, (actualByMonth.get(row.month_num) ?? 0) + n);
    }

    const months: Array<{ month: string; budgeted: number; actual: number }> = [];
    for (let monthNum = 1; monthNum <= 12; monthNum++) {
        const budgeted = budgetedByMonth.get(monthNum);
        if (!budgeted) continue;
        // Only evaluate months that have fully elapsed
        const monthEnd = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));
        if (monthEnd > now) continue;
        months.push({
            month: `${year}-${String(monthNum).padStart(2, '0')}`,
            budgeted,
            actual: actualByMonth.get(monthNum) ?? 0,
        });
    }

    return buildBudgetStreak(budget.name, months);
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export async function generateYearInReview(
    bookAccountGuids: string[],
    year: number
): Promise<YearInReviewData> {
    const now = new Date();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    const priorStart = new Date(Date.UTC(year - 1, 0, 1));
    const priorEnd = new Date(Date.UTC(year - 1, 11, 31, 23, 59, 59, 999));

    const baseCurrency = await getBaseCurrency();
    const currency = baseCurrency?.mnemonic ?? 'USD';

    /* --- Net worth arc + attribution + holdings --- */
    let netWorth: YirNetWorthCard | null = null;
    let holdings: YirHoldingsCard | null = null;
    try {
        const attribution = await generateNetWorthAttribution({
            bookAccountGuids,
            startDate: `${year}-01-01`,
            endDate: `${year}-12-31`,
        });
        netWorth = buildNetWorthCard(attribution);
        holdings = buildHoldingsCard(attribution.drilldown.market);
    } catch (error) {
        console.error('Year in review: attribution failed:', error);
    }

    /* --- Cash flow + top categories (with prior year for YoY) --- */
    let cashFlow: YirCashFlowCard | null = null;
    let topCategories: YirCategoryRow[] | null = null;
    try {
        const currentIE = await FinancialSummaryService.computeIncomeExpenses(
            bookAccountGuids, yearStart, yearEnd, baseCurrency
        );
        const priorIE = await FinancialSummaryService.computeIncomeExpenses(
            bookAccountGuids, priorStart, priorEnd, baseCurrency
        );
        cashFlow = buildCashFlowCard(currentIE.totalIncome, currentIE.totalExpenses);

        const categoryGuids = [
            ...new Set([
                ...currentIE.expenseByAccount.keys(),
                ...priorIE.expenseByAccount.keys(),
            ]),
        ];
        const categoryNames = await loadCategoryNames(categoryGuids);
        topCategories = buildTopCategories(
            categorize(currentIE.expenseByAccount, categoryNames),
            categorize(priorIE.expenseByAccount, categoryNames),
            5
        );
    } catch (error) {
        console.error('Year in review: cash flow failed:', error);
    }

    /* --- Biggest single expense --- */
    let biggestExpense: YirBiggestExpenseCard | null = null;
    try {
        biggestExpense = await loadBiggestExpense(bookAccountGuids, yearStart, yearEnd);
    } catch (error) {
        console.error('Year in review: biggest expense failed:', error);
    }

    /* --- Dividend income --- */
    let dividends: YirDividendCard | null = null;
    try {
        const payments = await loadDividendPayments(bookAccountGuids);
        const total = totalDividendsForYear(payments, year);
        const priorTotal = totalDividendsForYear(payments, year - 1);
        const paymentCount = payments.filter(p => p.date.getUTCFullYear() === year).length;
        const perSecurity = perSecurityDividends(payments, { asOf: yearEnd, year });
        const topPayers = perSecurity
            .map(s => ({ ticker: s.ticker, amount: s.yearIncome ?? 0 }))
            .sort((a, b) => b.amount - a.amount);
        dividends = buildDividendCard(total, priorTotal, paymentCount, topPayers);
    } catch (error) {
        console.error('Year in review: dividends failed:', error);
    }

    /* --- Realized gains + taxes paid --- */
    let realizedGains: YirRealizedGainsCard | null = null;
    try {
        const bookData = await aggregateBookTaxData(bookAccountGuids, year, null);
        const shortTerm = round2(bookData.realizedGains.shortTerm);
        const longTerm = round2(bookData.realizedGains.longTerm);
        const taxesSummary = bookData.mappedAccountCount > 0
            ? summarizeTaxPayments(bookData, 1)
            : null;
        const taxes: YirTaxesPaid | null =
            taxesSummary && taxesSummary.totalPaid !== 0
                ? {
                    federalWithholding: taxesSummary.withholding,
                    federalEstimated: taxesSummary.estimatedPayments,
                    stateWithholding: taxesSummary.stateWithholding,
                    stateEstimated: taxesSummary.stateEstimatedPayments,
                    totalPaid: taxesSummary.totalPaid,
                }
                : null;
        if (shortTerm !== 0 || longTerm !== 0 || taxes) {
            realizedGains = {
                shortTerm,
                longTerm,
                total: round2(shortTerm + longTerm),
                taxes,
            };
        }
    } catch (error) {
        console.error('Year in review: realized gains failed:', error);
    }

    /* --- Subscriptions added/dropped + busiest merchant --- */
    let subscriptions: YirSubscriptionsCard | null = null;
    let busiestMerchant: YirMerchantCard | null = null;
    try {
        // Window: from ≥12 months before the year starts through now, so
        // "added this year" is not confused by a truncated history.
        const monthsBack = Math.max(
            (now.getUTCFullYear() - year) * 12 + now.getUTCMonth() + 1 + 12,
            24
        );
        const spending = await loadSpendingTransactions(bookAccountGuids, monthsBack);
        const detection = detectRecurringSeries(spending, { now });
        subscriptions = classifyYearSubscriptions(detection.series, year);
        busiestMerchant = pickBusiestMerchant(spending, year);
    } catch (error) {
        console.error('Year in review: subscriptions failed:', error);
    }

    /* --- Budget streak --- */
    let budgetStreak: YirBudgetStreakCard | null = null;
    try {
        budgetStreak = await loadBudgetStreak(bookAccountGuids, year, now);
    } catch (error) {
        console.error('Year in review: budget streak failed:', error);
    }

    return {
        year,
        generatedAt: now.toISOString(),
        currency,
        cards: {
            netWorth,
            cashFlow,
            topCategories,
            biggestExpense,
            dividends,
            holdings,
            realizedGains,
            subscriptions,
            busiestMerchant,
            budgetStreak,
        },
    };
}
