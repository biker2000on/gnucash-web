/**
 * Data Health — "is my book clean?"
 *
 * A set of book-scoped, READ-ONLY integrity checks over the GnuCash ledger plus
 * an aggregate runner that produces an overall health score.
 *
 * Design:
 *   - The SQL lives in per-check loader functions (`load*`).
 *   - The scoring, threshold, and balance-detection logic is kept PURE so it can
 *     be unit-tested without a database (see `data-health.test.ts`).
 *
 * None of these functions mutate the ledger.
 */

import prisma from './prisma';
import { toDecimalNumber } from './gnucash';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type Severity = 'ok' | 'info' | 'warning' | 'error';

export interface HealthCheckItem {
    /** GUID of the offending account / transaction / commodity. */
    guid: string;
    /** Human-readable label (account name, tx description, ticker). */
    name: string;
    /** Optional secondary detail (date, imbalance, share count). */
    detail?: string;
    /** Optional monetary amount for right-aligned display. */
    amount?: number;
    /** Currency mnemonic for `amount`. */
    currency?: string;
    /** Link to the offending account / transaction. */
    href?: string;
}

export interface HealthCheck {
    id: string;
    label: string;
    description: string;
    severity: Severity;
    /** Total number of offending rows (may exceed `items.length`). */
    count: number;
    /** Offending rows, capped at `ITEM_CAP`. */
    items: HealthCheckItem[];
    /** True when `count` exceeds the number of returned `items`. */
    truncated: boolean;
}

export interface DataHealthOptions {
    /** Prices older than this many days are "stale". Default 7. */
    staleDays?: number;
    /** Unreconciled splits older than this many days age into the report. Default 90. */
    unreconciledDays?: number;
    /** Clock injection for deterministic tests. Defaults to `new Date()`. */
    asOf?: Date;
    /** Per-check item cap. Default `ITEM_CAP` (100). */
    itemCap?: number;
}

export interface DataHealthReport {
    generatedAt: string;
    /** Overall health score, 0–100. A clean book scores 100. */
    score: number;
    /** Qualitative label derived from `score`. */
    grade: string;
    params: { staleDays: number; unreconciledDays: number };
    checks: HealthCheck[];
}

/** Maximum offending rows returned per check. */
export const ITEM_CAP = 100;

/** Reconcile applies to balance-sheet accounts, not income/expense. */
const RECONCILABLE_TYPES = ['BANK', 'CASH', 'CREDIT', 'ASSET', 'LIABILITY'];

/* ------------------------------------------------------------------ */
/* Pure logic — scoring, thresholds, balance detection                  */
/* ------------------------------------------------------------------ */

/** Score penalty weight per severity. `ok` never contributes. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
    error: 10,
    warning: 5,
    info: 1,
    ok: 0,
};

/**
 * Compute an overall 0–100 health score from a set of checks.
 *
 * Pure and deterministic. Each failing check subtracts
 * `weight(severity) * (1 + log10(count))`, so severity dominates while
 * larger counts add a bounded, diminishing penalty. A clean book (every
 * check `count === 0`) scores exactly 100.
 */
export function computeHealthScore(
    checks: ReadonlyArray<{ severity: Severity; count: number }>,
): number {
    let penalty = 0;
    for (const check of checks) {
        if (check.count <= 0) continue;
        const weight = SEVERITY_WEIGHT[check.severity] ?? 0;
        penalty += weight * (1 + Math.log10(check.count));
    }
    return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

/** Map a numeric score to a qualitative grade for the hero display. */
export function scoreGrade(score: number): string {
    if (score >= 95) return 'Excellent';
    if (score >= 85) return 'Good';
    if (score >= 70) return 'Fair';
    if (score >= 50) return 'Needs attention';
    return 'Poor';
}

/** Whole days between two dates (a - b), floored. */
export function daysBetween(a: Date, b: Date): number {
    return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * True when `date` is strictly more than `days` old relative to `asOf`.
 * A null/undefined date returns false (absence is handled by the
 * "missing" check, not the "stale" check).
 */
export function isOlderThan(
    date: Date | string | null | undefined,
    days: number,
    asOf: Date = new Date(),
): boolean {
    if (!date) return false;
    return daysBetween(asOf, new Date(date)) > days;
}

/** The cutoff date `days` before `asOf` (UTC). Used to push aging into SQL. */
export function cutoffDate(days: number, asOf: Date = new Date()): Date {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
}

export interface RawSplitForBalance {
    txGuid: string;
    /** Currency/commodity the split's `value` is denominated in. */
    currency: string;
    valueNum: number | bigint | string;
    valueDenom: number | bigint | string;
}

export interface TxImbalance {
    txGuid: string;
    imbalances: Array<{ currency: string; sum: number }>;
}

/**
 * Detect transactions whose splits do not sum to zero.
 *
 * Pure. Splits are grouped by transaction and then by currency; a transaction
 * is balanced only when EVERY currency subtotal is zero (within `tolerance`).
 * This is the multi-currency-safe rule: a transaction that moves money across
 * two currencies is balanced as long as each currency leg nets to zero, which
 * is exactly how GnuCash records value legs in the transaction's currency.
 */
export function detectUnbalancedTransactions(
    splits: ReadonlyArray<RawSplitForBalance>,
    tolerance = 1e-4,
): TxImbalance[] {
    const byTx = new Map<string, Map<string, number>>();

    for (const split of splits) {
        let currencies = byTx.get(split.txGuid);
        if (!currencies) {
            currencies = new Map<string, number>();
            byTx.set(split.txGuid, currencies);
        }
        const prev = currencies.get(split.currency) ?? 0;
        currencies.set(split.currency, prev + toDecimalNumber(split.valueNum, split.valueDenom));
    }

    const result: TxImbalance[] = [];
    for (const [txGuid, currencies] of byTx) {
        const imbalances: Array<{ currency: string; sum: number }> = [];
        for (const [currency, sum] of currencies) {
            if (Math.abs(sum) > tolerance) {
                imbalances.push({ currency, sum });
            }
        }
        if (imbalances.length > 0) {
            result.push({ txGuid, imbalances });
        }
    }
    return result;
}

/* ------------------------------------------------------------------ */
/* Per-check SQL loaders                                                 */
/* ------------------------------------------------------------------ */

/**
 * (a) Unbalanced transactions — value legs that don't net to zero per currency.
 *
 * The per-(tx, currency) grouping is done in SQL so the balance rule is the
 * multi-currency-safe one: any single currency leg that fails to net to zero
 * flags the transaction. All splits of a book transaction are summed (even
 * legs in accounts outside the book) so cross-boundary transactions aren't
 * falsely flagged.
 */
async function loadUnbalancedTransactions(
    guids: string[],
    itemCap: number,
): Promise<HealthCheck> {
    const rows = await prisma.$queryRaw<
        {
            guid: string;
            description: string | null;
            post_date: Date | null;
            mnemonic: string;
            val_sum: number;
            account_guid: string;
        }[]
    >`
        WITH book_txs AS (
            SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY(${guids}::text[])
        )
        SELECT
            t.guid,
            t.description,
            t.post_date,
            c.mnemonic,
            MIN(s.account_guid) AS account_guid,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS val_sum
        FROM book_txs bt
        JOIN transactions t ON t.guid = bt.tx_guid
        JOIN splits s ON s.tx_guid = t.guid
        JOIN commodities c ON c.guid = t.currency_guid
        GROUP BY t.guid, t.description, t.post_date, c.mnemonic
        HAVING ABS(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)) > 0.0001
        ORDER BY t.post_date DESC NULLS LAST
        LIMIT ${itemCap}
    `;

    const countRows = await prisma.$queryRaw<{ n: number }[]>`
        WITH book_txs AS (
            SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY(${guids}::text[])
        )
        SELECT COUNT(*)::int AS n FROM (
            SELECT t.guid
            FROM book_txs bt
            JOIN transactions t ON t.guid = bt.tx_guid
            JOIN splits s ON s.tx_guid = t.guid
            GROUP BY t.guid, t.currency_guid
            HAVING ABS(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)) > 0.0001
        ) q
    `;
    const count = countRows[0]?.n ?? 0;

    const items: HealthCheckItem[] = rows.map((r) => ({
        guid: r.guid,
        name: r.description || '(no description)',
        detail: `${r.post_date ? r.post_date.toISOString().slice(0, 10) + ' · ' : ''}off by ${r.val_sum.toFixed(2)} ${r.mnemonic}`,
        amount: r.val_sum,
        currency: r.mnemonic,
        href: `/accounts/${r.account_guid}`,
    }));

    return {
        id: 'unbalanced-transactions',
        label: 'Unbalanced transactions',
        description: 'Transactions whose splits do not sum to zero within a single currency.',
        severity: count > 0 ? 'error' : 'ok',
        count,
        items,
        truncated: count > items.length,
    };
}

/**
 * (b) Structural issues — transactions with fewer than two splits, and splits
 * that reference a missing account. Both leave the ledger internally broken.
 */
async function loadStructuralIssues(
    guids: string[],
    itemCap: number,
): Promise<HealthCheck> {
    const degenerateRows = await prisma.$queryRaw<
        {
            guid: string;
            description: string | null;
            post_date: Date | null;
            cnt: number;
            account_guid: string | null;
        }[]
    >`
        WITH book_txs AS (
            SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY(${guids}::text[])
        )
        SELECT
            t.guid,
            t.description,
            t.post_date,
            COUNT(s.guid)::int AS cnt,
            MIN(s.account_guid) AS account_guid
        FROM book_txs bt
        JOIN transactions t ON t.guid = bt.tx_guid
        LEFT JOIN splits s ON s.tx_guid = t.guid
        GROUP BY t.guid, t.description, t.post_date
        HAVING COUNT(s.guid) < 2
        ORDER BY t.post_date DESC NULLS LAST
        LIMIT ${itemCap}
    `;

    // Splits whose account no longer exists. These cannot be book-scoped by
    // account (the account is gone), so they are reported globally; such rows
    // are rare and always corruption worth surfacing.
    const orphanRows = await prisma.$queryRaw<{ guid: string; tx_guid: string; account_guid: string }[]>`
        SELECT s.guid, s.tx_guid, s.account_guid
        FROM splits s
        LEFT JOIN accounts a ON a.guid = s.account_guid
        WHERE a.guid IS NULL
        LIMIT ${itemCap}
    `;

    const degenerateCountRows = await prisma.$queryRaw<{ n: number }[]>`
        WITH book_txs AS (
            SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY(${guids}::text[])
        )
        SELECT COUNT(*)::int AS n FROM (
            SELECT t.guid
            FROM book_txs bt
            JOIN transactions t ON t.guid = bt.tx_guid
            LEFT JOIN splits s ON s.tx_guid = t.guid
            GROUP BY t.guid
            HAVING COUNT(s.guid) < 2
        ) q
    `;
    const orphanCountRows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM splits s
        LEFT JOIN accounts a ON a.guid = s.account_guid
        WHERE a.guid IS NULL
    `;

    const count = (degenerateCountRows[0]?.n ?? 0) + (orphanCountRows[0]?.n ?? 0);

    const items: HealthCheckItem[] = [
        ...degenerateRows.map((r) => ({
            guid: r.guid,
            name: r.description || '(no description)',
            detail: `${r.post_date ? r.post_date.toISOString().slice(0, 10) + ' · ' : ''}${r.cnt} split${r.cnt === 1 ? '' : 's'} (needs 2+)`,
            href: r.account_guid ? `/accounts/${r.account_guid}` : '/ledger',
        })),
        ...orphanRows.map((r) => ({
            guid: r.guid,
            name: 'Orphaned split',
            detail: `missing account ${r.account_guid.slice(0, 8)}… (tx ${r.tx_guid.slice(0, 8)}…)`,
            href: '/ledger',
        })),
    ].slice(0, itemCap);

    return {
        id: 'structural-issues',
        label: 'Structural issues',
        description: 'Transactions with fewer than two splits, or splits pointing at a missing account.',
        severity: count > 0 ? 'error' : 'ok',
        count,
        items,
        truncated: count > items.length,
    };
}

interface HeldCommodityRow {
    commodity_guid: string;
    mnemonic: string;
    fullname: string | null;
    namespace: string;
    quote_flag: number;
    shares: number;
}

/**
 * (c)(d)(e) Price checks. One pass gathers the book's held non-currency
 * commodities plus any commodity flagged for quotes, then classifies each into
 * stale / missing / quote-flag-stale using the pure threshold helpers.
 */
async function loadPriceChecks(
    guids: string[],
    staleDays: number,
    asOf: Date,
): Promise<HealthCheck[]> {
    // Held commodities: non-currency commodities on book accounts with a
    // non-zero share balance.
    const held = await prisma.$queryRaw<HeldCommodityRow[]>`
        SELECT
            a.commodity_guid,
            c.mnemonic,
            c.fullname,
            c.namespace,
            c.quote_flag,
            SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS shares
        FROM accounts a
        JOIN commodities c ON c.guid = a.commodity_guid
        LEFT JOIN splits s ON s.account_guid = a.guid
        WHERE a.guid = ANY(${guids}::text[])
          AND c.namespace <> 'CURRENCY'
        GROUP BY a.commodity_guid, c.mnemonic, c.fullname, c.namespace, c.quote_flag
        HAVING ABS(COALESCE(SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric), 0)) > 0.0001
    `;

    // Commodities flagged for online quotes (regardless of current holdings).
    const quoteFlagged = await prisma.$queryRaw<HeldCommodityRow[]>`
        SELECT
            c.guid AS commodity_guid,
            c.mnemonic,
            c.fullname,
            c.namespace,
            c.quote_flag,
            0::float8 AS shares
        FROM commodities c
        WHERE c.quote_flag = 1 AND c.namespace <> 'CURRENCY'
    `;

    // Merge, de-duplicated by commodity guid.
    const byGuid = new Map<string, HeldCommodityRow>();
    for (const row of held) byGuid.set(row.commodity_guid, row);
    for (const row of quoteFlagged) {
        if (!byGuid.has(row.commodity_guid)) byGuid.set(row.commodity_guid, row);
    }
    const commodities = [...byGuid.values()];

    // Latest price date per commodity (implied $0 prices excluded).
    const priceDates = new Map<string, Date>();
    if (commodities.length > 0) {
        const priceRows = await prisma.$queryRaw<{ commodity_guid: string; date: Date }[]>`
            SELECT DISTINCT ON (commodity_guid) commodity_guid, date
            FROM prices
            WHERE commodity_guid = ANY(${[...byGuid.keys()]}::text[])
              AND value_num > 0
            ORDER BY commodity_guid, date DESC
        `;
        for (const row of priceRows) priceDates.set(row.commodity_guid, row.date);
    }

    const staleItems: HealthCheckItem[] = [];
    const missingItems: HealthCheckItem[] = [];
    const quoteItems: HealthCheckItem[] = [];

    for (const c of commodities) {
        const latest = priceDates.get(c.commodity_guid);
        const isHeld = Math.abs(c.shares) > 0.0001;
        const label = c.mnemonic + (c.fullname ? ` — ${c.fullname}` : '');

        if (!latest) {
            // Only flag missing prices for commodities actually held; a
            // quote-flagged but unheld commodity with no price is a quote issue.
            if (isHeld) {
                missingItems.push({
                    guid: c.commodity_guid,
                    name: label,
                    detail: `${c.shares.toFixed(4)} shares · no price on record`,
                    href: '/settings/commodities',
                });
            } else if (c.quote_flag === 1) {
                quoteItems.push({
                    guid: c.commodity_guid,
                    name: label,
                    detail: 'flagged for quotes · no price on record',
                    href: '/settings/commodities',
                });
            }
            continue;
        }

        if (isHeld && isOlderThan(latest, staleDays, asOf)) {
            staleItems.push({
                guid: c.commodity_guid,
                name: label,
                detail: `latest price ${latest.toISOString().slice(0, 10)} (${daysBetween(asOf, latest)}d old)`,
                href: '/settings/commodities',
            });
        }

        if (c.quote_flag === 1 && isOlderThan(latest, staleDays, asOf)) {
            quoteItems.push({
                guid: c.commodity_guid,
                name: label,
                detail: `flagged for quotes · latest ${latest.toISOString().slice(0, 10)} (${daysBetween(asOf, latest)}d old)`,
                href: '/settings/commodities',
            });
        }
    }

    const stale: HealthCheck = {
        id: 'stale-prices',
        label: 'Stale prices',
        description: `Held securities whose most recent price is more than ${staleDays} days old.`,
        severity: staleItems.length > 0 ? 'warning' : 'ok',
        count: staleItems.length,
        items: staleItems.slice(0, ITEM_CAP),
        truncated: staleItems.length > ITEM_CAP,
    };

    const missing: HealthCheck = {
        id: 'missing-prices',
        label: 'Missing prices',
        description: 'Held securities with no price on record — they cannot be valued.',
        severity: missingItems.length > 0 ? 'warning' : 'ok',
        count: missingItems.length,
        items: missingItems.slice(0, ITEM_CAP),
        truncated: missingItems.length > ITEM_CAP,
    };

    const quote: HealthCheck = {
        id: 'quote-flag-stale',
        label: 'Quote-flagged, not updated',
        description: `Commodities marked for online quotes with no quote in the last ${staleDays} days.`,
        severity: quoteItems.length > 0 ? 'info' : 'ok',
        count: quoteItems.length,
        items: quoteItems.slice(0, ITEM_CAP),
        truncated: quoteItems.length > ITEM_CAP,
    };

    return [stale, missing, quote];
}

/**
 * (f) Unreconciled aging — splits in balance-sheet accounts that are still
 * unreconciled and older than `unreconciledDays`. Aggregated per account.
 */
async function loadUnreconciledAging(
    guids: string[],
    unreconciledDays: number,
    asOf: Date,
    itemCap: number,
): Promise<HealthCheck> {
    const cutoff = cutoffDate(unreconciledDays, asOf);

    const rows = await prisma.$queryRaw<
        {
            guid: string;
            name: string;
            account_type: string;
            cnt: number;
            total: number;
            oldest: Date | null;
        }[]
    >`
        SELECT
            a.guid,
            a.name,
            a.account_type,
            COUNT(s.guid)::int AS cnt,
            SUM(ABS(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric))::float8 AS total,
            MIN(t.post_date) AS oldest
        FROM accounts a
        JOIN splits s ON s.account_guid = a.guid
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE a.guid = ANY(${guids}::text[])
          AND a.account_type = ANY(${RECONCILABLE_TYPES}::text[])
          AND s.reconcile_state <> 'y'
          AND t.post_date < ${cutoff}
        GROUP BY a.guid, a.name, a.account_type
        HAVING COUNT(s.guid) > 0
        ORDER BY COUNT(s.guid) DESC
        LIMIT ${itemCap}
    `;

    // `count` here is the number of affected accounts (what the score weighs),
    // while each item reports the underlying split count.
    const countRows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
            SELECT a.guid
            FROM accounts a
            JOIN splits s ON s.account_guid = a.guid
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE a.guid = ANY(${guids}::text[])
              AND a.account_type = ANY(${RECONCILABLE_TYPES}::text[])
              AND s.reconcile_state <> 'y'
              AND t.post_date < ${cutoff}
            GROUP BY a.guid
        ) q
    `;
    const count = countRows[0]?.n ?? 0;

    const items: HealthCheckItem[] = rows.map((r) => ({
        guid: r.guid,
        name: r.name,
        detail: `${r.cnt} unreconciled split${r.cnt === 1 ? '' : 's'}${r.oldest ? `, since ${r.oldest.toISOString().slice(0, 10)}` : ''}`,
        amount: r.total,
        href: `/accounts/${r.guid}`,
    }));

    return {
        id: 'unreconciled-aging',
        label: 'Unreconciled aging',
        description: `Balance-sheet accounts with unreconciled splits older than ${unreconciledDays} days.`,
        severity: count > 0 ? 'info' : 'ok',
        count,
        items,
        truncated: count > items.length,
    };
}

/* ------------------------------------------------------------------ */
/* Aggregate runner                                                     */
/* ------------------------------------------------------------------ */

/**
 * Run every data-health check against the given book account GUIDs and produce
 * an aggregate report with an overall score.
 *
 * `bookAccountGuids` is the set of account GUIDs under the active book's root
 * (from `getBookAccountGuids()`), matching the book-scope convention used by
 * the reports API. All queries are read-only.
 */
export async function runDataHealth(
    bookAccountGuids: string[],
    opts: DataHealthOptions = {},
): Promise<DataHealthReport> {
    const staleDays = opts.staleDays ?? 7;
    const unreconciledDays = opts.unreconciledDays ?? 90;
    const asOf = opts.asOf ?? new Date();
    const itemCap = opts.itemCap ?? ITEM_CAP;

    const [unbalanced, structural, priceChecks, unreconciled] = await Promise.all([
        loadUnbalancedTransactions(bookAccountGuids, itemCap),
        loadStructuralIssues(bookAccountGuids, itemCap),
        loadPriceChecks(bookAccountGuids, staleDays, asOf),
        loadUnreconciledAging(bookAccountGuids, unreconciledDays, asOf, itemCap),
    ]);

    const [stale, missing, quote] = priceChecks;

    // Order: hard integrity errors first, then valuation, then hygiene.
    const checks: HealthCheck[] = [
        unbalanced,
        structural,
        missing,
        stale,
        quote,
        unreconciled,
    ];

    const score = computeHealthScore(checks);

    return {
        generatedAt: asOf.toISOString(),
        score,
        grade: scoreGrade(score),
        params: { staleDays, unreconciledDays },
        checks,
    };
}
