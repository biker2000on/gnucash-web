/**
 * Spending Anomaly & Fraud Alerts
 *
 * Pure anomaly detectors + a book-scoped DB loader and a scan-and-notify
 * function that pushes alerts through the shared notifications system.
 *
 * Detectors (all pure, unit-tested):
 *   (a) duplicate_charge   — same merchant + amount within N days
 *   (b) first_time_merchant — a merchant appearing for the first time recently
 *   (c) amount_outlier      — a charge far outside a merchant's history
 *   (d) category_spike      — a category's spend spikes above its trailing average
 *
 * Merchant grouping reuses `normalizeMerchant` from recurring-detection so store
 * numbers, reference codes, and digits don't split a merchant into many keys.
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import { normalizeMerchant } from '@/lib/recurring-detection';
import { formatCurrency } from '@/lib/format';
import { createNotification, type NotificationSeverity } from '@/lib/notifications';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type AnomalyType =
    | 'duplicate_charge'
    | 'first_time_merchant'
    | 'amount_outlier'
    | 'category_spike';

/** Anomaly severity, mapped to notification severity in `scanForAnomalies`. */
export type AnomalySeverity = 'low' | 'medium' | 'high';

/** A single expense-side transaction fed to the detectors. */
export interface AnomalyTransaction {
    /** Post date of the transaction */
    date: Date;
    /** Normalized merchant key (see normalizeMerchant); '' when none */
    normalizedMerchant: string;
    /** Raw transaction description, for display */
    originalDescription: string;
    /** Expense amount in book currency (positive = money spent) */
    amount: number;
    /** GUID of the expense account (used as the category key) */
    accountGuid: string;
    /** Display name (full path when available) of the expense account */
    accountName: string;
    /** GnuCash transaction GUID, when known (used for related refs) */
    txGuid?: string;
}

export interface Anomaly {
    type: AnomalyType;
    severity: AnomalySeverity;
    /** Merchant label (a/b/c) or category/account name (d) */
    label: string;
    /** The anomalous amount (charge amount, or the period spend for spikes) */
    amount: number;
    /** ISO date (YYYY-MM-DD) most relevant to the anomaly */
    date: string;
    /** Human-readable explanation sentence */
    context: string;
    /** Normalized merchant key, when merchant-based */
    merchantKey?: string;
    /** Expense account, when known */
    accountGuid?: string;
    accountName?: string;
    /** Related GnuCash transaction GUIDs (for drill-down) */
    relatedRefs: string[];
    /** Stable dedupe key: hash of type + label + date + amount */
    dedupeKey: string;
}

export interface AnomalyOptions {
    /** "Current time" used for windowing (default: now) */
    now?: Date;
    /** Duplicate charge window in days (default 3) */
    duplicateWindowDays?: number;
    /** A merchant is "first-time" if it first appears within this many days (default 30) */
    firstTimeWindowDays?: number;
    /** Minimum prior charges before outlier detection runs (default 4) */
    outlierMinSamples?: number;
    /** Charge must exceed mean + this·stddev (default 3) */
    outlierStdDevMult?: number;
    /** Charge must also exceed this × the prior max (default 1.5) */
    outlierMaxMult?: number;
    /** Category spike period length in days (default 30) */
    spikePeriodDays?: number;
    /** Current period must exceed trailing average by this fraction (default 0.5 = 50%) */
    spikeThresholdPct?: number;
    /** Current period must also exceed trailing average by at least this many dollars (default 200) */
    spikeMinDollars?: number;
    /** Minimum prior periods with data before a spike can fire (default 2) */
    spikeMinPriorPeriods?: number;
}

/* ------------------------------------------------------------------ */
/* Small stats helpers                                                  */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
    return d.toISOString().slice(0, 7); // YYYY-MM
}

function cents(amount: number): number {
    return Math.round(amount * 100);
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], avg = mean(values)): number {
    if (values.length < 2) return 0;
    const variance =
        values.reduce((s, v) => s + (v - avg) * (v - avg), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

/**
 * Stable 32-bit FNV-1a hash of the dedupe components, rendered base36.
 * Pure and deterministic — same inputs always produce the same key so
 * repeated scans don't re-alert on the same anomaly.
 */
export function anomalyDedupeKey(
    type: AnomalyType,
    label: string,
    dateKey: string,
    amount: number,
): string {
    const input = `${type}|${label}|${dateKey}|${cents(amount)}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        // 32-bit FNV prime multiply, kept in unsigned range
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/* ------------------------------------------------------------------ */
/* Detectors (pure)                                                     */
/* ------------------------------------------------------------------ */

function groupByMerchant(
    transactions: AnomalyTransaction[],
): Map<string, AnomalyTransaction[]> {
    const groups = new Map<string, AnomalyTransaction[]>();
    for (const tx of transactions) {
        if (!(tx.amount > 0)) continue; // skip refunds / zero rows
        const key = tx.normalizedMerchant;
        if (!key) continue;
        const arr = groups.get(key);
        if (arr) arr.push(tx);
        else groups.set(key, [tx]);
    }
    for (const arr of groups.values()) {
        arr.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    return groups;
}

/** (a) Same merchant + amount charged again within the window. */
function detectDuplicates(
    groups: Map<string, AnomalyTransaction[]>,
    windowDays: number,
): Anomaly[] {
    const out: Anomaly[] = [];
    for (const [merchantKey, txs] of groups) {
        for (let i = 1; i < txs.length; i++) {
            const curr = txs[i];
            // Find the nearest earlier charge with the same amount inside the window.
            for (let j = i - 1; j >= 0; j--) {
                const prev = txs[j];
                const gapDays = (curr.date.getTime() - prev.date.getTime()) / DAY_MS;
                if (gapDays > windowDays) break; // list is sorted; nothing earlier qualifies
                if (cents(prev.amount) !== cents(curr.amount)) continue;

                const label = curr.originalDescription || merchantKey;
                const gap = Math.round(gapDays);
                out.push({
                    type: 'duplicate_charge',
                    severity: curr.amount >= 100 ? 'high' : 'medium',
                    label,
                    amount: curr.amount,
                    date: isoDate(curr.date),
                    context: gap === 0
                        ? `Possible duplicate: ${formatCurrency(curr.amount)} at ${label} charged twice on ${isoDate(curr.date)}.`
                        : `Possible duplicate: ${formatCurrency(curr.amount)} at ${label} also charged ${gap} day${gap === 1 ? '' : 's'} earlier on ${isoDate(prev.date)}.`,
                    merchantKey,
                    accountGuid: curr.accountGuid,
                    accountName: curr.accountName,
                    relatedRefs: [prev.txGuid, curr.txGuid].filter((g): g is string => !!g),
                    dedupeKey: anomalyDedupeKey('duplicate_charge', merchantKey, isoDate(curr.date), curr.amount),
                });
                break; // one duplicate flag per charge
            }
        }
    }
    return out;
}

/** (b) A merchant whose first-ever appearance is within the recent window. */
function detectFirstTimeMerchants(
    groups: Map<string, AnomalyTransaction[]>,
    now: Date,
    windowDays: number,
): Anomaly[] {
    const out: Anomaly[] = [];
    const cutoff = now.getTime() - windowDays * DAY_MS;
    for (const [merchantKey, txs] of groups) {
        const first = txs[0];
        // "New" only if the earliest charge we have is inside the recent window.
        if (first.date.getTime() < cutoff) continue;
        const label = first.originalDescription || merchantKey;
        out.push({
            type: 'first_time_merchant',
            severity: first.amount >= 200 ? 'medium' : 'low',
            label,
            amount: first.amount,
            date: isoDate(first.date),
            context: `First-time merchant: ${label} — first charge of ${formatCurrency(first.amount)} on ${isoDate(first.date)}.`,
            merchantKey,
            accountGuid: first.accountGuid,
            accountName: first.accountName,
            relatedRefs: first.txGuid ? [first.txGuid] : [],
            dedupeKey: anomalyDedupeKey('first_time_merchant', merchantKey, isoDate(first.date), first.amount),
        });
    }
    return out;
}

/** (c) A charge far above a merchant's historical distribution. */
function detectAmountOutliers(
    groups: Map<string, AnomalyTransaction[]>,
    minSamples: number,
    stdMult: number,
    maxMult: number,
): Anomaly[] {
    const out: Anomaly[] = [];
    for (const [merchantKey, txs] of groups) {
        // Walk chronologically; each charge is judged against everything before it.
        for (let i = 0; i < txs.length; i++) {
            const priors = txs.slice(0, i).map(t => t.amount);
            if (priors.length < minSamples) continue;

            const avg = mean(priors);
            const sd = stdDev(priors, avg);
            const priorMax = Math.max(...priors);
            const curr = txs[i];

            const stdThreshold = avg + stdMult * sd;
            const overStd = sd > 0 ? curr.amount > stdThreshold : curr.amount > avg;
            const overMax = curr.amount > maxMult * priorMax;
            if (!overStd || !overMax) continue;

            const ratio = avg > 0 ? curr.amount / avg : 0;
            const label = curr.originalDescription || merchantKey;
            out.push({
                type: 'amount_outlier',
                severity: ratio >= 3 ? 'high' : 'medium',
                label,
                amount: curr.amount,
                date: isoDate(curr.date),
                context: `${ratio.toFixed(1)}× your typical ${formatCurrency(avg)} at ${label} — this charge was ${formatCurrency(curr.amount)}.`,
                merchantKey,
                accountGuid: curr.accountGuid,
                accountName: curr.accountName,
                relatedRefs: curr.txGuid ? [curr.txGuid] : [],
                dedupeKey: anomalyDedupeKey('amount_outlier', merchantKey, isoDate(curr.date), curr.amount),
            });
        }
    }
    return out;
}

/** (d) A category whose current-period spend spikes over its trailing average. */
function detectCategorySpikes(
    transactions: AnomalyTransaction[],
    now: Date,
    periodDays: number,
    thresholdPct: number,
    minDollars: number,
    minPriorPeriods: number,
): Anomaly[] {
    const periodMs = periodDays * DAY_MS;
    const nowMs = now.getTime();

    // Group expense rows by account (category)
    const byCategory = new Map<string, AnomalyTransaction[]>();
    for (const tx of transactions) {
        if (!(tx.amount > 0)) continue;
        const arr = byCategory.get(tx.accountGuid);
        if (arr) arr.push(tx);
        else byCategory.set(tx.accountGuid, [tx]);
    }

    const out: Anomaly[] = [];
    const MAX_TRAILING_PERIODS = 12;

    for (const [accountGuid, txs] of byCategory) {
        let currentTotal = 0;
        // Bucket index k: 0 = current period, 1..K = trailing periods.
        const trailing = new Map<number, number>();
        let oldestBucket = 0;
        for (const tx of txs) {
            const ageMs = nowMs - tx.date.getTime();
            if (ageMs < 0) continue; // future-dated; ignore
            const bucket = Math.floor(ageMs / periodMs);
            if (bucket === 0) {
                currentTotal += tx.amount;
            } else if (bucket <= MAX_TRAILING_PERIODS) {
                trailing.set(bucket, (trailing.get(bucket) ?? 0) + tx.amount);
                if (bucket > oldestBucket) oldestBucket = bucket;
            }
        }

        if (oldestBucket < minPriorPeriods) continue; // not enough history
        // Average over every trailing bucket in range, counting empty ones as 0.
        let sum = 0;
        for (let k = 1; k <= oldestBucket; k++) sum += trailing.get(k) ?? 0;
        const trailingAvg = sum / oldestBucket;
        if (trailingAvg <= 0) continue;

        const excess = currentTotal - trailingAvg;
        const overPct = currentTotal > trailingAvg * (1 + thresholdPct);
        if (!overPct || excess < minDollars) continue;

        const pct = (excess / trailingAvg) * 100;
        const accountName = txs[0].accountName;
        const leaf = accountName.split(':').pop() || accountName;
        out.push({
            type: 'category_spike',
            severity: pct >= 100 ? 'high' : 'medium',
            label: accountName,
            amount: currentTotal,
            date: isoDate(now),
            context: `${leaf} spending is ${formatCurrency(currentTotal)} this period — ${pct.toFixed(0)}% above your ${formatCurrency(trailingAvg)} average.`,
            accountGuid,
            accountName,
            relatedRefs: [],
            // Dedupe by month so the same spike isn't re-alerted every scan that day.
            dedupeKey: anomalyDedupeKey('category_spike', accountGuid, monthKey(now), currentTotal),
        });
    }
    return out;
}

const SEVERITY_RANK: Record<AnomalySeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * Run every detector over a set of expense transactions. Pure — exported for tests.
 */
export function detectAnomalies(
    transactions: AnomalyTransaction[],
    options: AnomalyOptions = {},
): Anomaly[] {
    const now = options.now ?? new Date();
    const groups = groupByMerchant(transactions);

    const anomalies: Anomaly[] = [
        ...detectDuplicates(groups, options.duplicateWindowDays ?? 3),
        ...detectFirstTimeMerchants(groups, now, options.firstTimeWindowDays ?? 30),
        ...detectAmountOutliers(
            groups,
            options.outlierMinSamples ?? 4,
            options.outlierStdDevMult ?? 3,
            options.outlierMaxMult ?? 1.5,
        ),
        ...detectCategorySpikes(
            transactions,
            now,
            options.spikePeriodDays ?? 30,
            options.spikeThresholdPct ?? 0.5,
            options.spikeMinDollars ?? 200,
            options.spikeMinPriorPeriods ?? 2,
        ),
    ];

    // Most severe first, then most recent, then largest amount.
    anomalies.sort((a, b) => {
        const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (sev !== 0) return sev;
        const date = b.date.localeCompare(a.date);
        if (date !== 0) return date;
        return b.amount - a.amount;
    });

    return anomalies;
}

/* ------------------------------------------------------------------ */
/* DB loader                                                            */
/* ------------------------------------------------------------------ */

interface ExpenseRow {
    tx_guid: string;
    post_date: Date;
    description: string | null;
    value_num: bigint;
    value_denom: bigint;
    account_guid: string;
    account_name: string;
    account_fullname: string | null;
}

/**
 * Load expense-side spending for the last `months` months: splits hitting
 * EXPENSE accounts whose transaction has at least one asset/liability-style
 * counterpart split (a real outflow, not an expense recategorization).
 *
 * Book-scoped by `bookAccountGuids`. Merchant normalization is applied here so
 * the pure detectors receive ready-to-group rows.
 */
export async function loadExpenseTransactions(
    bookAccountGuids: string[],
    months: number,
): Promise<AnomalyTransaction[]> {
    if (bookAccountGuids.length === 0) return [];

    const startDate = new Date();
    startDate.setUTCMonth(startDate.getUTCMonth() - months);

    const rows = await prisma.$queryRaw<ExpenseRow[]>`
        SELECT
            t.guid AS tx_guid,
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

    return rows.map(row => {
        const description = row.description ?? '';
        return {
            date: row.post_date,
            normalizedMerchant: normalizeMerchant(description),
            originalDescription: description,
            amount: toDecimalNumber(row.value_num, row.value_denom),
            accountGuid: row.account_guid,
            accountName: row.account_fullname ?? row.account_name,
            txGuid: row.tx_guid,
        };
    });
}

/* ------------------------------------------------------------------ */
/* Scan + notify                                                        */
/* ------------------------------------------------------------------ */

export interface ScanOptions extends AnomalyOptions {
    /** Owner of the notifications to create */
    userId: number;
    /** Lookback window for loading data (default 12) */
    months?: number;
    /** Only notify on anomalies whose date is within this many days (default 45) */
    notifyWithinDays?: number;
    /** Max notifications to create in a single scan (default 20) */
    maxNotifications?: number;
    /** Pre-resolved book account GUIDs; resolved from bookGuid when omitted */
    bookAccountGuids?: string[];
}

const ANOMALY_SOURCE = 'anomaly';

function toNotificationSeverity(sev: AnomalySeverity): NotificationSeverity {
    if (sev === 'high') return 'error';
    if (sev === 'medium') return 'warning';
    return 'info';
}

const TYPE_TITLES: Record<AnomalyType, string> = {
    duplicate_charge: 'Possible duplicate charge',
    first_time_merchant: 'New merchant charge',
    amount_outlier: 'Unusually large charge',
    category_spike: 'Category spending spike',
};

/**
 * Resolve every account GUID under a book's root, without touching the session.
 * The session-based `getBookAccountGuids()` is unavailable in the sync worker
 * path, so this mirrors its recursive-CTE walk from an explicit book GUID.
 */
export async function loadBookAccountGuids(bookGuid: string): Promise<string[]> {
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) return [];

    const rows = await prisma.$queryRaw<Array<{ guid: string }>>`
        WITH RECURSIVE account_tree AS (
            SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
            UNION ALL
            SELECT a.guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid FROM account_tree
    `;
    return rows.map(r => r.guid);
}

/**
 * Convenience: load book-scoped expense data and detect anomalies (no notifications).
 * Used by the review API.
 */
export async function detectAnomaliesForBook(
    bookAccountGuids: string[],
    options: AnomalyOptions & { months?: number } = {},
): Promise<Anomaly[]> {
    const months = options.months ?? 12;
    const transactions = await loadExpenseTransactions(bookAccountGuids, months);
    return detectAnomalies(transactions, options);
}

/**
 * Load data, run detectors, and create notifications for NEW anomalies only.
 *
 * Deduped via (source='anomaly', source_id=<dedupeKey>): existing anomaly
 * notifications for this user+book are fetched first and skipped. Only
 * anomalies inside the `notifyWithinDays` window are alerted, so a first scan
 * over 12 months of history doesn't create a flood of stale notifications.
 *
 * Fire-and-forget safe: never throws. Returns a small summary for callers/tests.
 */
export async function scanForAnomalies(
    bookGuid: string,
    opts: ScanOptions,
): Promise<{ detected: number; created: number }> {
    try {
        const now = opts.now ?? new Date();
        const months = opts.months ?? 12;
        const notifyWithinDays = opts.notifyWithinDays ?? 45;
        const maxNotifications = opts.maxNotifications ?? 20;

        const bookAccountGuids = opts.bookAccountGuids ?? (await loadBookAccountGuids(bookGuid));
        const transactions = await loadExpenseTransactions(bookAccountGuids, months);
        const anomalies = detectAnomalies(transactions, { ...opts, now });

        // Only recent anomalies are worth alerting on.
        const cutoffIso = isoDate(new Date(now.getTime() - notifyWithinDays * DAY_MS));
        const recent = anomalies.filter(a => a.date >= cutoffIso);
        if (recent.length === 0) return { detected: anomalies.length, created: 0 };

        // Pull existing anomaly source ids for this user+book to dedupe.
        const existingRows = await prisma.$queryRaw<Array<{ source_id: string | null }>>`
            SELECT source_id
            FROM gnucash_web_notifications
            WHERE user_id = ${opts.userId}
              AND source = ${ANOMALY_SOURCE}
              AND (book_guid IS NULL OR book_guid = ${bookGuid})
        `;
        const seen = new Set(existingRows.map(r => r.source_id).filter((s): s is string => !!s));

        let created = 0;
        for (const anomaly of recent) {
            if (created >= maxNotifications) break;
            if (seen.has(anomaly.dedupeKey)) continue;
            seen.add(anomaly.dedupeKey);

            await createNotification({
                userId: opts.userId,
                bookGuid,
                type: 'spending_anomaly',
                severity: toNotificationSeverity(anomaly.severity),
                title: TYPE_TITLES[anomaly.type],
                message: anomaly.context,
                href: '/tools/anomalies',
                source: ANOMALY_SOURCE,
                sourceId: anomaly.dedupeKey,
            });
            created++;
        }

        return { detected: anomalies.length, created };
    } catch (error) {
        // Never let anomaly scanning break the caller (e.g. the sync path).
        console.warn('Anomaly scan failed:', error);
        return { detected: 0, created: 0 };
    }
}
