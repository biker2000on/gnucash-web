/**
 * Dividend Income Tracking & Calendar
 *
 * Pure aggregators (unit-tested) plus a book-scoped DB loader.
 *
 * How dividends are represented in GnuCash (as seen in this book's data):
 * a dividend transaction pairs an INCOME split (account_type INCOME, whose
 * account name/path contains "Dividend") — stored as a negative value/credit —
 * with either
 *   (a) a STOCK/MUTUAL split receiving reinvested shares (DRIP), whose
 *       commodity identifies the paying security, or
 *   (b) a cash deposit into a BANK/ASSET/CASH account (dividend paid in cash),
 *       in which case the paying security is resolved from the transaction
 *       description (ticker token) or falls back to the income account name.
 * TRADING splits are GnuCash bookkeeping entries and are ignored.
 *
 * All amounts are returned as positive dollars (income is negated on load).
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type DividendCadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/** A single dividend payment resolved to its paying security. */
export interface DividendPayment {
    /** Post date of the dividend transaction */
    date: Date;
    /** Dividend amount in book currency, positive dollars */
    amount: number;
    /** Resolved security ticker/symbol, or income-account label as fallback */
    ticker: string;
    /** Commodity GUID when the security could be resolved, else null */
    commodityGuid: string | null;
    /** GUID of the dividend INCOME account */
    incomeAccountGuid: string;
    /** Full path (or name) of the dividend INCOME account */
    incomeAccountName: string;
    /** Investment account that received the dividend (DRIP or cash), if known */
    investmentAccountGuid: string | null;
    investmentAccountName: string | null;
    /** Original transaction description */
    description: string;
}

/** Current holdings valuation for a security, used to compute yields. */
export interface SecurityValuation {
    commodityGuid: string;
    ticker: string;
    costBasis: number;
    marketValue: number;
}

/** Per-security dividend rollup with yields (when valuation is available). */
export interface PerSecurityDividend {
    ticker: string;
    commodityGuid: string | null;
    /** Trailing-12-month dividend income */
    ttmIncome: number;
    /** All-time dividend income within the loaded window */
    totalIncome: number;
    /** Income for the selected calendar year (only set in per-year views) */
    yearIncome?: number;
    paymentCount: number;
    /** ISO date (YYYY-MM-DD) of the most recent payment */
    lastPaymentDate: string | null;
    lastPaymentAmount: number | null;
    /** Trailing-12mo dividends / cost basis * 100, or null when unknown */
    yieldOnCost: number | null;
    /** Trailing-12mo dividends / current market value * 100, or null */
    currentYield: number | null;
    costBasis: number | null;
    marketValue: number | null;
}

/** One month bucket in the income time series. */
export interface MonthlyDividend {
    /** Bucket key, "YYYY-MM" */
    month: string;
    amount: number;
}

/** A single projected future dividend payment. */
export interface ProjectedPayment {
    /** ISO date (YYYY-MM-DD) of the expected payment */
    date: string;
    ticker: string;
    commodityGuid: string | null;
    estimatedAmount: number;
    cadence: DividendCadence;
}

/** Per-security projection outcome (projected, or why it was skipped). */
export interface SecurityProjection {
    ticker: string;
    commodityGuid: string | null;
    projected: boolean;
    cadence: DividendCadence | null;
    /** Reason a security was not projected (irregular / one-off / too few) */
    reason?: string;
}

export interface ForwardCalendar {
    calendar: ProjectedPayment[];
    projections: SecurityProjection[];
}

/** Full report payload assembled by {@link summarizeDividends}. */
export interface DividendSummary {
    /** Trailing-12-month total across all securities */
    ttmTotal: number;
    /** Total for the selected calendar year, when a year is requested */
    yearTotal: number | null;
    year: number | null;
    /** Projected total over the next 12 months */
    projectedNext12mo: number;
    /** Sum of current market value across securities that paid dividends */
    portfolioValue: number;
    /** ttmTotal / portfolioValue * 100, or null when value unknown */
    portfolioYield: number | null;
    perYear: Array<{ year: number; amount: number }>;
    perSecurity: PerSecurityDividend[];
    monthly: MonthlyDividend[];
    forwardCalendar: ForwardCalendar;
    paymentCount: number;
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** Start of the trailing-12-month window (exclusive lower bound). */
export function ttmWindowStart(asOf: Date): Date {
    const start = new Date(asOf.getTime());
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return start;
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

/** Sum dividend income for a single calendar (UTC) year. */
export function totalDividendsForYear(payments: DividendPayment[], year: number): number {
    return payments.reduce(
        (sum, p) => (p.date.getUTCFullYear() === year ? sum + p.amount : sum),
        0,
    );
}

/**
 * Sum dividend income over the trailing 12 months ending at `asOf`
 * (window is (asOf - 1yr, asOf]).
 */
export function trailingTwelveMonthTotal(payments: DividendPayment[], asOf: Date): number {
    const start = ttmWindowStart(asOf).getTime();
    const end = asOf.getTime();
    return payments.reduce((sum, p) => {
        const t = p.date.getTime();
        return t > start && t <= end ? sum + p.amount : sum;
    }, 0);
}

/** Dividend income grouped by calendar year, ascending. */
export function perYearTotals(payments: DividendPayment[]): Array<{ year: number; amount: number }> {
    const byYear = new Map<number, number>();
    for (const p of payments) {
        const y = p.date.getUTCFullYear();
        byYear.set(y, (byYear.get(y) ?? 0) + p.amount);
    }
    return [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([year, amount]) => ({ year, amount }));
}

/* ------------------------------------------------------------------ */
/* Yields                                                              */
/* ------------------------------------------------------------------ */

/** Yield-on-cost: trailing-12mo dividends / cost basis, as a percent. */
export function computeYieldOnCost(ttmIncome: number, costBasis: number): number | null {
    if (!(costBasis > 0)) return null;
    return (ttmIncome / costBasis) * 100;
}

/** Current yield: trailing-12mo dividends / current market value, as a percent. */
export function computeCurrentYield(ttmIncome: number, marketValue: number): number | null {
    if (!(marketValue > 0)) return null;
    return (ttmIncome / marketValue) * 100;
}

/* ------------------------------------------------------------------ */
/* Per-security rollup                                                 */
/* ------------------------------------------------------------------ */

/** Stable grouping key: prefer commodity GUID, fall back to ticker string. */
function securityKey(p: { commodityGuid: string | null; ticker: string }): string {
    return p.commodityGuid ? `c:${p.commodityGuid}` : `t:${p.ticker}`;
}

/**
 * Roll dividends up per security with trailing-12mo, all-time, optional
 * year totals, and yields when a valuation lookup is supplied.
 *
 * @param valuations optional map keyed by commodity GUID (and ticker) giving
 *                   cost basis and current market value for yield math.
 */
export function perSecurityDividends(
    payments: DividendPayment[],
    options: {
        asOf: Date;
        year?: number | null;
        valuations?: Map<string, SecurityValuation>;
    },
): PerSecurityDividend[] {
    const { asOf, year, valuations } = options;
    const ttmStart = ttmWindowStart(asOf).getTime();
    const asOfMs = asOf.getTime();

    const groups = new Map<string, DividendPayment[]>();
    for (const p of payments) {
        const key = securityKey(p);
        const arr = groups.get(key);
        if (arr) arr.push(p);
        else groups.set(key, [p]);
    }

    const result: PerSecurityDividend[] = [];
    for (const [, group] of groups) {
        const first = group[0];
        let ttmIncome = 0;
        let totalIncome = 0;
        let yearIncome = 0;
        let last: DividendPayment | null = null;
        for (const p of group) {
            totalIncome += p.amount;
            const t = p.date.getTime();
            if (t > ttmStart && t <= asOfMs) ttmIncome += p.amount;
            if (year != null && p.date.getUTCFullYear() === year) yearIncome += p.amount;
            if (!last || p.date.getTime() > last.date.getTime()) last = p;
        }

        const valuation = valuations
            ? valuations.get(securityKey(first)) ?? null
            : null;
        const costBasis = valuation ? valuation.costBasis : null;
        const marketValue = valuation ? valuation.marketValue : null;

        result.push({
            ticker: first.ticker,
            commodityGuid: first.commodityGuid,
            ttmIncome,
            totalIncome,
            yearIncome: year != null ? yearIncome : undefined,
            paymentCount: group.length,
            lastPaymentDate: last ? isoDate(last.date) : null,
            lastPaymentAmount: last ? last.amount : null,
            yieldOnCost: costBasis != null ? computeYieldOnCost(ttmIncome, costBasis) : null,
            currentYield: marketValue != null ? computeCurrentYield(ttmIncome, marketValue) : null,
            costBasis,
            marketValue,
        });
    }

    // Sort by trailing-12mo income desc, then all-time desc.
    result.sort((a, b) => b.ttmIncome - a.ttmIncome || b.totalIncome - a.totalIncome);
    return result;
}

/* ------------------------------------------------------------------ */
/* Monthly time series                                                 */
/* ------------------------------------------------------------------ */

/**
 * Bucket dividend income by month into a continuous "YYYY-MM" series ending at
 * `asOf`. Empty months are filled with 0 so charts have no gaps.
 */
export function monthlyDividendSeries(
    payments: DividendPayment[],
    options: { asOf: Date; months: number },
): MonthlyDividend[] {
    const { asOf, months } = options;
    const buckets = new Map<string, number>();

    // Seed a continuous run of month keys, oldest -> newest.
    const cursor = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
    const keys: string[] = [];
    for (let i = 0; i < months; i++) {
        keys.unshift(monthKey(cursor));
        cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
    for (const k of keys) buckets.set(k, 0);

    const earliest = keys[0];
    for (const p of payments) {
        const k = monthKey(p.date);
        // Only include payments within the seeded window.
        if (k < earliest || k > keys[keys.length - 1]) continue;
        buckets.set(k, (buckets.get(k) ?? 0) + p.amount);
    }

    return keys.map(month => ({ month, amount: buckets.get(month) ?? 0 }));
}

/* ------------------------------------------------------------------ */
/* Forward projection (cadence-based calendar)                         */
/* ------------------------------------------------------------------ */

interface CadenceBand {
    cadence: DividendCadence;
    minDays: number;
    maxDays: number;
    /** Max allowed median absolute deviation of intervals (days) */
    madLimitDays: number;
}

const CADENCE_BANDS: CadenceBand[] = [
    { cadence: 'monthly', minDays: 24, maxDays: 38, madLimitDays: 6 },
    { cadence: 'quarterly', minDays: 78, maxDays: 104, madLimitDays: 14 },
    { cadence: 'semiannual', minDays: 160, maxDays: 205, madLimitDays: 25 },
    { cadence: 'annual', minDays: 330, maxDays: 400, madLimitDays: 45 },
];

/** Expected number of payments per year for each cadence. */
const PAYMENTS_PER_YEAR: Record<DividendCadence, number> = {
    monthly: 12,
    quarterly: 4,
    semiannual: 2,
    annual: 1,
};

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

interface Occurrence {
    date: Date;
    amount: number;
}

/** Merge same-day payments for one security into single occurrences. */
function mergeOccurrences(payments: DividendPayment[]): Occurrence[] {
    const byDay = new Map<string, Occurrence>();
    for (const p of payments) {
        const key = isoDate(p.date);
        const existing = byDay.get(key);
        if (existing) existing.amount += p.amount;
        else byDay.set(key, { date: new Date(p.date.getTime()), amount: p.amount });
    }
    return [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Detect a security's payment cadence from its occurrence dates.
 * Returns null when there are too few payments or the interval is irregular.
 */
export function detectSecurityCadence(payments: DividendPayment[], minPayments = 3): {
    cadence: DividendCadence;
    medianIntervalDays: number;
} | null {
    const occ = mergeOccurrences(payments);
    if (occ.length < minPayments) return null;

    const intervals: number[] = [];
    for (let i = 1; i < occ.length; i++) {
        intervals.push(Math.round((occ[i].date.getTime() - occ[i - 1].date.getTime()) / DAY_MS));
    }
    const med = median(intervals);
    const band = classifyCadence(med);
    if (!band) return null;

    const mad = median(intervals.map(i => Math.abs(i - med)));
    if (mad > band.madLimitDays) return null;

    return { cadence: band.cadence, medianIntervalDays: med };
}

/**
 * Project each security's next ~12 months of expected dividends by
 * extrapolating its observed cadence and most-recent amount. Securities with
 * too few payments or irregular/one-off history are flagged "not projected".
 */
export function projectForwardCalendar(
    payments: DividendPayment[],
    options: { asOf: Date; months?: number; minPayments?: number },
): ForwardCalendar {
    const { asOf } = options;
    const months = options.months ?? 12;
    const minPayments = options.minPayments ?? 3;
    const horizonEnd = new Date(asOf.getTime());
    horizonEnd.setUTCMonth(horizonEnd.getUTCMonth() + months);

    const groups = new Map<string, DividendPayment[]>();
    for (const p of payments) {
        const key = securityKey(p);
        const arr = groups.get(key);
        if (arr) arr.push(p);
        else groups.set(key, [p]);
    }

    const calendar: ProjectedPayment[] = [];
    const projections: SecurityProjection[] = [];
    const ttmStart = asOf.getTime() - 365 * DAY_MS;

    for (const [, group] of groups) {
        const first = group[0];
        const occ = mergeOccurrences(group);
        const detected = detectSecurityCadence(group, minPayments);

        if (!detected) {
            projections.push({
                ticker: first.ticker,
                commodityGuid: first.commodityGuid,
                projected: false,
                cadence: null,
                reason: occ.length < minPayments
                    ? 'too few payments'
                    : 'irregular cadence',
            });
            continue;
        }

        const last = occ[occ.length - 1];
        const intervalMs = detected.medianIntervalDays * DAY_MS;

        // A security that stopped paying is not projected — extrapolating one
        // that last paid years ago would invent income that never arrives. The
        // window is generous (books often lag on recording recent dividends /
        // DRIP), so it excludes the clearly-stale (e.g. last paid years back)
        // without dropping an active holding whose latest quarter isn't entered
        // yet: max(2 cadence intervals, 400 days).
        const activeWindowMs = Math.max(2 * intervalMs, 400 * DAY_MS);
        if (last.date.getTime() < asOf.getTime() - activeWindowMs) {
            projections.push({
                ticker: first.ticker,
                commodityGuid: first.commodityGuid,
                projected: false,
                cadence: detected.cadence,
                reason: 'no recent payments',
            });
            continue;
        }

        // Anchor the forward estimate to trailing-12-month income rather than the
        // single most-recent payment, which for growing DRIP positions (or a
        // lumpy year-end distribution) overshoots badly. Distribute that trailing
        // income across the expected number of payments per year.
        const ttmTotal = occ
            .filter(o => o.date.getTime() > ttmStart && o.date.getTime() <= asOf.getTime())
            .reduce((sum, o) => sum + o.amount, 0);
        if (ttmTotal <= 0) {
            projections.push({
                ticker: first.ticker,
                commodityGuid: first.commodityGuid,
                projected: false,
                cadence: detected.cadence,
                reason: 'no recent payments',
            });
            continue;
        }
        const paymentsPerYear = PAYMENTS_PER_YEAR[detected.cadence];
        const estimatedAmount = ttmTotal / paymentsPerYear;

        // Walk forward from the last observed payment until the horizon.
        let nextMs = last.date.getTime() + intervalMs;
        const guardStart = asOf.getTime() - intervalMs; // don't emit stale past dates
        while (nextMs <= horizonEnd.getTime()) {
            if (nextMs > guardStart && nextMs > asOf.getTime()) {
                calendar.push({
                    date: isoDate(new Date(nextMs)),
                    ticker: first.ticker,
                    commodityGuid: first.commodityGuid,
                    estimatedAmount,
                    cadence: detected.cadence,
                });
            }
            nextMs += intervalMs;
        }

        projections.push({
            ticker: first.ticker,
            commodityGuid: first.commodityGuid,
            projected: true,
            cadence: detected.cadence,
        });
    }

    calendar.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
    projections.sort((a, b) => a.ticker.localeCompare(b.ticker));
    return { calendar, projections };
}

/* ------------------------------------------------------------------ */
/* Full summary assembler (pure)                                       */
/* ------------------------------------------------------------------ */

/**
 * Assemble the complete dividend report payload from loaded payments and an
 * optional per-security valuation map. Pure — no DB access — so it is fully
 * unit-testable.
 */
export function summarizeDividends(
    payments: DividendPayment[],
    options: {
        asOf: Date;
        year?: number | null;
        valuations?: Map<string, SecurityValuation>;
        monthlyMonths?: number;
        projectionMonths?: number;
    },
): DividendSummary {
    const { asOf, valuations } = options;
    const year = options.year ?? null;
    const monthlyMonths = options.monthlyMonths ?? 24;
    const projectionMonths = options.projectionMonths ?? 12;

    const perSecurity = perSecurityDividends(payments, { asOf, year, valuations });
    const forwardCalendar = projectForwardCalendar(payments, { asOf, months: projectionMonths });
    const projectedNext12mo = forwardCalendar.calendar.reduce((s, p) => s + p.estimatedAmount, 0);

    const ttmTotal = trailingTwelveMonthTotal(payments, asOf);
    const yearTotal = year != null ? totalDividendsForYear(payments, year) : null;

    // Portfolio value/yield across securities that actually paid dividends.
    let portfolioValue = 0;
    let hasValue = false;
    for (const s of perSecurity) {
        if (s.marketValue != null && s.marketValue > 0) {
            portfolioValue += s.marketValue;
            hasValue = true;
        }
    }
    const portfolioYield = hasValue && portfolioValue > 0 ? (ttmTotal / portfolioValue) * 100 : null;

    return {
        ttmTotal,
        yearTotal,
        year,
        projectedNext12mo,
        portfolioValue: hasValue ? portfolioValue : 0,
        portfolioYield,
        perYear: perYearTotals(payments),
        perSecurity,
        monthly: monthlyDividendSeries(payments, { asOf, months: monthlyMonths }),
        forwardCalendar,
        paymentCount: payments.length,
    };
}

/* ------------------------------------------------------------------ */
/* DB loader                                                           */
/* ------------------------------------------------------------------ */

/** Account-name substrings (lowercased) that mark an income account as dividends. */
export const DIVIDEND_ACCOUNT_KEYWORDS = ['dividend', 'distribution'];

interface DividendIncomeRow {
    tx_guid: string;
    value_num: bigint;
    value_denom: bigint;
    income_account_guid: string;
    income_account_name: string;
    income_account_fullname: string | null;
    post_date: Date;
    description: string | null;
}

interface SecuritySplitRow {
    tx_guid: string;
    account_guid: string;
    account_name: string;
    account_fullname: string | null;
    commodity_guid: string | null;
    mnemonic: string | null;
    quantity_num: bigint;
    quantity_denom: bigint;
}

interface CommodityRow {
    guid: string;
    mnemonic: string;
}

/**
 * Load dividend income payments for the active book, resolved to their paying
 * security where the transaction structure allows.
 */
export async function loadDividendPayments(
    bookAccountGuids: string[],
    keywords: string[] = DIVIDEND_ACCOUNT_KEYWORDS,
): Promise<DividendPayment[]> {
    if (bookAccountGuids.length === 0) return [];

    const likePatterns = keywords.map(k => `%${k.toLowerCase()}%`);

    // 1. All splits hitting dividend INCOME accounts, book-scoped.
    const incomeRows = await prisma.$queryRaw<DividendIncomeRow[]>`
        SELECT
            s.tx_guid,
            s.value_num, s.value_denom,
            s.account_guid AS income_account_guid,
            a.name         AS income_account_name,
            ah.fullname    AS income_account_fullname,
            t.post_date,
            t.description
        FROM splits s
        JOIN accounts a ON a.guid = s.account_guid AND a.account_type = 'INCOME'
        LEFT JOIN account_hierarchy ah ON ah.guid = s.account_guid
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${bookAccountGuids})
          AND t.post_date IS NOT NULL
          AND (
            lower(a.name) LIKE ANY(${likePatterns})
            OR lower(coalesce(ah.fullname, '')) LIKE ANY(${likePatterns})
          )
        ORDER BY t.post_date ASC
    `;

    if (incomeRows.length === 0) return [];

    const txGuids = [...new Set(incomeRows.map(r => r.tx_guid))];

    // 2. STOCK/MUTUAL counterpart splits for those transactions (the DRIP share
    //    receiver identifies the paying security).
    const securityRows = await prisma.$queryRaw<SecuritySplitRow[]>`
        SELECT
            s.tx_guid,
            s.account_guid,
            a.name      AS account_name,
            ah.fullname AS account_fullname,
            a.commodity_guid,
            c.mnemonic,
            s.quantity_num, s.quantity_denom
        FROM splits s
        JOIN accounts a ON a.guid = s.account_guid AND a.account_type IN ('STOCK', 'MUTUAL')
        LEFT JOIN commodities c ON c.guid = a.commodity_guid
        LEFT JOIN account_hierarchy ah ON ah.guid = s.account_guid
        WHERE s.tx_guid = ANY(${txGuids})
    `;

    // Map tx_guid -> best security split (largest positive quantity received).
    const securityByTx = new Map<string, SecuritySplitRow>();
    for (const row of securityRows) {
        const qty = toDecimalNumber(row.quantity_num, row.quantity_denom);
        if (qty <= 0) continue; // shares received into the holding
        const existing = securityByTx.get(row.tx_guid);
        if (!existing || qty > toDecimalNumber(existing.quantity_num, existing.quantity_denom)) {
            securityByTx.set(row.tx_guid, row);
        }
    }

    // 3. Known non-currency commodity tickers, for resolving cash dividends by
    //    description (e.g. "VTI Dividend Brokerage" -> VTI).
    const commodityRows = await prisma.$queryRaw<CommodityRow[]>`
        SELECT DISTINCT c.guid, c.mnemonic
        FROM commodities c
        JOIN accounts a ON a.commodity_guid = c.guid
        WHERE c.namespace <> 'CURRENCY'
          AND a.guid = ANY(${bookAccountGuids})
    `;
    const tickerToCommodity = new Map<string, string>();
    for (const c of commodityRows) {
        if (c.mnemonic) tickerToCommodity.set(c.mnemonic.toUpperCase(), c.guid);
    }

    const payments: DividendPayment[] = [];
    for (const row of incomeRows) {
        // Income is stored as a negative value (credit); dividend amount is its
        // magnitude. Negating preserves sign for the rare correcting entry.
        const amount = -toDecimalNumber(row.value_num, row.value_denom);
        const incomeAccountName = row.income_account_fullname ?? row.income_account_name;
        const description = row.description ?? '';

        const security = securityByTx.get(row.tx_guid);
        let ticker: string;
        let commodityGuid: string | null;
        let investmentAccountGuid: string | null = null;
        let investmentAccountName: string | null = null;

        if (security && security.mnemonic) {
            // (a) DRIP: security identified by the reinvested holding.
            ticker = security.mnemonic;
            commodityGuid = security.commodity_guid;
            investmentAccountGuid = security.account_guid;
            investmentAccountName = security.account_fullname ?? security.account_name;
        } else {
            // (b) Cash dividend: resolve a ticker from the description.
            const resolved = resolveTickerFromDescription(description, tickerToCommodity);
            if (resolved) {
                ticker = resolved.ticker;
                commodityGuid = resolved.commodityGuid;
            } else {
                // Fall back to the income account leaf name.
                ticker = leafName(incomeAccountName);
                commodityGuid = null;
            }
        }

        payments.push({
            date: row.post_date,
            amount,
            ticker,
            commodityGuid,
            incomeAccountGuid: row.income_account_guid,
            incomeAccountName,
            investmentAccountGuid,
            investmentAccountName,
            description,
        });
    }

    return payments;
}

/** Scan a description for an uppercase ticker token matching a known commodity. */
function resolveTickerFromDescription(
    description: string,
    tickerToCommodity: Map<string, string>,
): { ticker: string; commodityGuid: string } | null {
    const tokens = description.toUpperCase().match(/[A-Z]{1,6}/g);
    if (!tokens) return null;
    for (const token of tokens) {
        const guid = tickerToCommodity.get(token);
        if (guid) return { ticker: token, commodityGuid: guid };
    }
    return null;
}

/** Last colon-delimited segment of an account path. */
function leafName(path: string): string {
    const parts = path.split(':');
    return parts[parts.length - 1] || path;
}
