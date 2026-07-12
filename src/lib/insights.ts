/**
 * Proactive insights.
 *
 * A curated set of deterministic checks (plain SQL + arithmetic, NOT free-form
 * AI SQL) that surface notable changes in a book:
 *
 *  1. category-spike        top-category spend this month vs its 3-month average (>25%)
 *  2. new-merchant          first-ever charge from a merchant, over $100
 *  3. savings-rate-drop     savings rate this month vs the 6-month average (>=10 pts down)
 *  4. net-worth-milestone   crossings of $25k net-worth increments (up or down)
 *  5. balance-drop          cash-account balance down >30% week-over-week
 *
 * Detectors are pure functions over synthetic-friendly series (unit-tested in
 * src/lib/__tests__/insights.test.ts). Detected insights are persisted to a
 * lazily-created `gnucash_web_insights` table, deduped by (book_guid,
 * dedupe_key). An OPTIONAL AI pass rewrites titles/details more naturally in
 * one batched call; the deterministic template text is the fallback.
 */

import prisma from '@/lib/prisma';
import { formatCurrency } from '@/lib/format';
import { getBaseCurrency } from '@/lib/currency';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import { getAiConfig } from '@/lib/ai-config';
import {
    chatComplete,
    extractJsonObject,
    isAiConfigured,
    type AiChatMessage,
} from '@/lib/ai-query/client';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type InsightKind =
    | 'category-spike'
    | 'new-merchant'
    | 'savings-rate-drop'
    | 'net-worth-milestone'
    | 'balance-drop';

export type InsightSeverity = 'info' | 'warning' | 'critical';

export interface InsightCandidate {
    kind: InsightKind;
    severity: InsightSeverity;
    title: string;
    detail: string;
    href: string;
    /** Stable key for dedupe (unique per book) */
    dedupeKey: string;
}

export interface StoredInsight {
    id: number;
    kind: InsightKind;
    severity: InsightSeverity;
    title: string;
    detail: string;
    href: string;
    createdAt: string;
    dismissedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Thresholds (exported so tests document the contract)                */
/* ------------------------------------------------------------------ */

export const CATEGORY_SPIKE_PCT = 25;
export const CATEGORY_SPIKE_MIN_AMOUNT = 100;
export const NEW_MERCHANT_MIN_AMOUNT = 100;
export const SAVINGS_RATE_DROP_PTS = 10;
export const NET_WORTH_MILESTONE_STEP = 25_000;
export const BALANCE_DROP_PCT = 30;
export const BALANCE_DROP_MIN_PRIOR = 100;

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function slug(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

/* ------------------------------------------------------------------ */
/* Detectors (pure)                                                    */
/* ------------------------------------------------------------------ */

export interface CategorySeries {
    name: string;
    /** Spend in the current month so far */
    current: number;
    /** Spend in each of the prior N full months (any order) */
    priorMonths: number[];
}

/**
 * Top-category spike: current-month spend more than 25% above the average of
 * the prior months (needs at least one prior month with data). Only the
 * single largest current-month category is examined ("top category").
 */
export function detectCategorySpike(
    month: string,
    categories: CategorySeries[],
    currency = 'USD'
): InsightCandidate[] {
    if (categories.length === 0) return [];
    const top = [...categories].sort(
        (a, b) => b.current - a.current || a.name.localeCompare(b.name)
    )[0];
    if (!top || top.current < CATEGORY_SPIKE_MIN_AMOUNT) return [];
    const priors = top.priorMonths.filter(v => Number.isFinite(v));
    if (priors.length === 0) return [];
    const avg = priors.reduce((s, v) => s + v, 0) / priors.length;
    if (avg <= 0) return [];
    const pct = ((top.current - avg) / avg) * 100;
    if (pct <= CATEGORY_SPIKE_PCT) return [];

    return [{
        kind: 'category-spike',
        severity: pct > 50 ? 'warning' : 'info',
        title: `${top.name} spending is up ${Math.round(pct)}%`,
        detail:
            `You have spent ${formatCurrency(round2(top.current), currency)} on ${top.name} this month, ` +
            `${Math.round(pct)}% above its 3-month average of ${formatCurrency(round2(avg), currency)}.`,
        href: '/tools/digest',
        dedupeKey: `category-spike:${month}:${slug(top.name)}`,
    }];
}

export interface NewMerchant {
    description: string;
    /** YYYY-MM-DD of the merchant's first-ever charge */
    firstDate: string;
    firstAmount: number;
}

/** New merchant whose FIRST charge lands in the month and exceeds $100. */
export function detectNewMerchants(
    month: string,
    merchants: NewMerchant[],
    currency = 'USD'
): InsightCandidate[] {
    return merchants
        .filter(m => m.firstDate.slice(0, 7) === month && m.firstAmount > NEW_MERCHANT_MIN_AMOUNT)
        .map(m => ({
            kind: 'new-merchant' as const,
            severity: 'info' as const,
            title: `New merchant: ${m.description}`,
            detail:
                `First charge of ${formatCurrency(round2(m.firstAmount), currency)} from ` +
                `"${m.description}" on ${m.firstDate}. You have not paid this merchant before.`,
            href: '/ledger',
            dedupeKey: `new-merchant:${slug(m.description)}`,
        }));
}

/**
 * Savings-rate drop: current month at least 10 percentage points below the
 * average of the prior months (needs >= 3 prior months for a stable base).
 */
export function detectSavingsRateDrop(
    month: string,
    currentRate: number,
    priorRates: number[]
): InsightCandidate[] {
    const priors = priorRates.filter(v => Number.isFinite(v));
    if (priors.length < 3) return [];
    const avg = priors.reduce((s, v) => s + v, 0) / priors.length;
    const drop = avg - currentRate;
    if (drop < SAVINGS_RATE_DROP_PTS) return [];

    return [{
        kind: 'savings-rate-drop',
        severity: 'warning',
        title: `Savings rate down ${Math.round(drop)} points`,
        detail:
            `Your savings rate this month is ${currentRate.toFixed(1)}%, versus a ` +
            `6-month average of ${avg.toFixed(1)}%.`,
        href: '/tools/digest',
        dedupeKey: `savings-rate:${month}`,
    }];
}

/**
 * Net-worth milestone crossings at $25k increments. Reports each milestone
 * strictly between the previous and current values (up = info, down =
 * warning). Nothing is reported when both values sit in the same bracket.
 */
export function detectNetWorthMilestone(
    previous: number,
    current: number,
    currency = 'USD',
    step = NET_WORTH_MILESTONE_STEP
): InsightCandidate[] {
    if (!Number.isFinite(previous) || !Number.isFinite(current) || step <= 0) return [];
    const out: InsightCandidate[] = [];

    if (current > previous) {
        const first = Math.floor(previous / step) + 1;
        const last = Math.floor(current / step);
        for (let k = first; k <= last; k++) {
            const milestone = k * step;
            if (milestone <= 0) continue;
            out.push({
                kind: 'net-worth-milestone',
                severity: 'info',
                title: `Net worth crossed ${formatCurrency(milestone, currency)}`,
                detail:
                    `Your net worth reached ${formatCurrency(round2(current), currency)}, ` +
                    `crossing the ${formatCurrency(milestone, currency)} milestone.`,
                href: '/dashboard',
                dedupeKey: `net-worth-milestone:up:${milestone}`,
            });
        }
    } else if (current < previous) {
        const first = Math.floor(current / step) + 1;
        const last = Math.floor(previous / step);
        for (let k = last; k >= first; k--) {
            const milestone = k * step;
            if (milestone <= 0) continue;
            out.push({
                kind: 'net-worth-milestone',
                severity: 'warning',
                title: `Net worth fell below ${formatCurrency(milestone, currency)}`,
                detail:
                    `Your net worth is now ${formatCurrency(round2(current), currency)}, ` +
                    `below the ${formatCurrency(milestone, currency)} mark it previously held.`,
                href: '/dashboard',
                dedupeKey: `net-worth-milestone:down:${milestone}`,
            });
        }
    }

    return out;
}

export interface CashBalance {
    guid: string;
    name: string;
    current: number;
    weekAgo: number;
}

/**
 * Unusual cash-account drop: balance down more than 30% week-over-week
 * (prior balance must be at least $100 so near-empty accounts don't alarm).
 * The dedupe key includes the week so a persistent low balance re-alerts at
 * most once per week.
 */
export function detectBalanceDrops(
    weekKey: string,
    accounts: CashBalance[],
    currency = 'USD'
): InsightCandidate[] {
    const out: InsightCandidate[] = [];
    for (const a of accounts) {
        if (a.weekAgo < BALANCE_DROP_MIN_PRIOR) continue;
        const dropPct = ((a.weekAgo - a.current) / a.weekAgo) * 100;
        if (dropPct <= BALANCE_DROP_PCT) continue;
        out.push({
            kind: 'balance-drop',
            severity: dropPct > 60 ? 'critical' : 'warning',
            title: `${a.name} balance down ${Math.round(dropPct)}% this week`,
            detail:
                `${a.name} fell from ${formatCurrency(round2(a.weekAgo), currency)} to ` +
                `${formatCurrency(round2(a.current), currency)} over the last 7 days.`,
            href: `/accounts/${a.guid}`,
            dedupeKey: `balance-drop:${a.guid}:${weekKey}`,
        });
    }
    return out;
}

/** YYYY-Www key of the ISO week containing `d` (UTC) — stable within a week. */
export function isoWeekKey(d: Date): string {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    // Shift to the Thursday of this week to determine the ISO year/week.
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Aggregate compute (pure)                                            */
/* ------------------------------------------------------------------ */

export interface InsightSource {
    /** YYYY-MM of the current month */
    month: string;
    /** ISO week key used for balance-drop dedupe */
    weekKey: string;
    currency: string;
    categories: CategorySeries[];
    newMerchants: NewMerchant[];
    savingsRate: { current: number; priorRates: number[] };
    netWorth: { previous: number; current: number };
    cashBalances: CashBalance[];
}

/** Run every detector over a loaded source. Pure. */
export function computeInsights(source: InsightSource): InsightCandidate[] {
    return [
        ...detectCategorySpike(source.month, source.categories, source.currency),
        ...detectNewMerchants(source.month, source.newMerchants, source.currency),
        ...detectSavingsRateDrop(
            source.month,
            source.savingsRate.current,
            source.savingsRate.priorRates
        ),
        ...detectNetWorthMilestone(
            source.netWorth.previous,
            source.netWorth.current,
            source.currency
        ),
        ...detectBalanceDrops(source.weekKey, source.cashBalances, source.currency),
    ];
}

/** Pure filter used by the list API: hides dismissed rows unless asked. */
export function filterInsights<T extends { dismissedAt: string | null }>(
    rows: T[],
    options: { includeDismissed?: boolean } = {}
): T[] {
    if (options.includeDismissed) return rows;
    return rows.filter(r => r.dismissedAt === null);
}

/* ------------------------------------------------------------------ */
/* Optional AI polish                                                  */
/* ------------------------------------------------------------------ */

type ChatFn = (messages: AiChatMessage[]) => Promise<string>;

/**
 * Rewrite titles/details more naturally in ONE batched call. Falls back to
 * the deterministic template text (the input) on any failure. Exported for
 * tests; never throws.
 */
export async function polishInsights(
    candidates: InsightCandidate[],
    chat: ChatFn
): Promise<InsightCandidate[]> {
    if (candidates.length === 0) return candidates;
    try {
        const payload = candidates.map((c, i) => ({
            i,
            kind: c.kind,
            title: c.title,
            detail: c.detail,
        }));
        const messages: AiChatMessage[] = [
            {
                role: 'system',
                content: [
                    'You rewrite short personal-finance insight notifications to sound natural and human.',
                    'Reply with ONLY a JSON object: { "items": [{ "i": number, "title": string, "detail": string }] }.',
                    'Keep every number and account/merchant name exactly as given. No advice, no emojis.',
                    'Titles under 80 characters; details 1-2 sentences.',
                ].join('\n'),
            },
            { role: 'user', content: JSON.stringify(payload) },
        ];
        const reply = await chat(messages);
        const parsed = extractJsonObject(reply);
        const items = Array.isArray(parsed.items) ? parsed.items : null;
        if (!items) return candidates;

        const polished = [...candidates];
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const { i, title, detail } = item as Record<string, unknown>;
            if (typeof i !== 'number' || i < 0 || i >= polished.length) continue;
            polished[i] = {
                ...polished[i],
                title:
                    typeof title === 'string' && title.trim()
                        ? title.trim().slice(0, 120)
                        : polished[i].title,
                detail:
                    typeof detail === 'string' && detail.trim()
                        ? detail.trim().slice(0, 500)
                        : polished[i].detail,
            };
        }
        return polished;
    } catch {
        return candidates;
    }
}

/* ------------------------------------------------------------------ */
/* Persistence (lazy table)                                            */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureInsightsTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_insights_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_insights (
                    id SERIAL PRIMARY KEY,
                    book_guid VARCHAR(32) NOT NULL,
                    kind VARCHAR(50) NOT NULL,
                    dedupe_key VARCHAR(200) NOT NULL,
                    payload JSONB NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    dismissed_at TIMESTAMP NULL,
                    UNIQUE (book_guid, dedupe_key)
                  );

                  CREATE INDEX IF NOT EXISTS idx_insights_book_active
                    ON gnucash_web_insights(book_guid, created_at DESC)
                    WHERE dismissed_at IS NULL;
                END $$;
            `);
        })().catch(err => {
            ensurePromise = null; // allow retry on transient failure
            throw err;
        });
    }
    return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Source loading (deterministic SQL, book-scoped without a session)   */
/* ------------------------------------------------------------------ */

/** Account GUIDs under a book's root — no session dependency (job-safe). */
async function getBookScopeGuids(bookGuid: string): Promise<string[]> {
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

function monthKeyUTC(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Assemble every detector's inputs for a book. */
export async function loadInsightSource(bookGuid: string, now = new Date()): Promise<InsightSource | null> {
    const guids = await getBookScopeGuids(bookGuid);
    if (guids.length === 0) return null;

    const baseCurrency = await getBaseCurrency();
    const currency = baseCurrency?.mnemonic ?? 'USD';

    const month = monthKeyUTC(now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // --- 1. Category spend: current month + 3 prior full months -----------
    const catWindowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const catRows = await prisma.$queryRaw<Array<{
        month: string;
        category: string;
        total: number;
    }>>`
        SELECT to_char(t.post_date, 'YYYY-MM') AS month,
               COALESCE(ah.level2, ah.level1, a.name) AS category,
               SUM(s.value_num::double precision / NULLIF(s.value_denom, 0)::double precision) AS total
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        JOIN accounts a ON a.guid = s.account_guid
        LEFT JOIN account_hierarchy ah ON ah.guid = a.guid
        WHERE a.account_type = 'EXPENSE'
          AND a.hidden = 0
          AND s.account_guid = ANY(${guids})
          AND t.post_date >= ${catWindowStart}
        GROUP BY 1, 2
    `;
    const byCategory = new Map<string, { current: number; priors: Map<string, number> }>();
    for (const row of catRows) {
        const entry = byCategory.get(row.category) ?? { current: 0, priors: new Map() };
        if (row.month === month) entry.current += Number(row.total);
        else entry.priors.set(row.month, (entry.priors.get(row.month) ?? 0) + Number(row.total));
        byCategory.set(row.category, entry);
    }
    const priorMonthKeys = [1, 2, 3].map(i =>
        monthKeyUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)))
    );
    const categories: CategorySeries[] = [...byCategory.entries()].map(([name, e]) => ({
        name,
        current: e.current,
        priorMonths: priorMonthKeys.map(k => e.priors.get(k) ?? 0),
    }));

    // --- 2. New merchants: first-ever charge lands in the current month ---
    const merchantRows = await prisma.$queryRaw<Array<{
        description: string;
        first_date: Date;
        first_amount: number;
    }>>`
        WITH tx_amounts AS (
            SELECT t.guid,
                   t.description,
                   t.post_date,
                   SUM(s.value_num::double precision / NULLIF(s.value_denom, 0)::double precision) AS amount
            FROM transactions t
            JOIN splits s ON s.tx_guid = t.guid
            JOIN accounts a ON a.guid = s.account_guid
            WHERE a.account_type = 'EXPENSE'
              AND s.account_guid = ANY(${guids})
              AND t.description IS NOT NULL
              AND btrim(t.description) <> ''
            GROUP BY t.guid, t.description, t.post_date
        ),
        ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                       PARTITION BY lower(btrim(description))
                       ORDER BY post_date, guid
                   ) AS rn
            FROM tx_amounts
        )
        SELECT description, post_date AS first_date, amount AS first_amount
        FROM ranked
        WHERE rn = 1 AND post_date >= ${monthStart}
    `;
    const newMerchants: NewMerchant[] = merchantRows.map(r => ({
        description: r.description.trim(),
        firstDate: r.first_date.toISOString().slice(0, 10),
        firstAmount: Number(r.first_amount),
    }));

    // --- 3. Savings rate: current month vs prior 6 months -----------------
    const srWindowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
    const srRows = await prisma.$queryRaw<Array<{
        month: string;
        income: number;
        expenses: number;
    }>>`
        SELECT to_char(t.post_date, 'YYYY-MM') AS month,
               SUM(CASE WHEN a.account_type = 'INCOME'
                        THEN -s.value_num::double precision / NULLIF(s.value_denom, 0)::double precision
                        ELSE 0 END) AS income,
               SUM(CASE WHEN a.account_type = 'EXPENSE'
                        THEN s.value_num::double precision / NULLIF(s.value_denom, 0)::double precision
                        ELSE 0 END) AS expenses
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        JOIN accounts a ON a.guid = s.account_guid
        WHERE a.account_type IN ('INCOME', 'EXPENSE')
          AND a.hidden = 0
          AND s.account_guid = ANY(${guids})
          AND t.post_date >= ${srWindowStart}
        GROUP BY 1
    `;
    const rateFor = (income: number, expenses: number) =>
        income > 0 ? ((income - expenses) / income) * 100 : 0;
    const srByMonth = new Map(srRows.map(r => [r.month, r]));
    const currentSr = srByMonth.get(month);
    const priorRates: number[] = [];
    for (let i = 1; i <= 6; i++) {
        const key = monthKeyUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
        const row = srByMonth.get(key);
        if (row && Number(row.income) > 0) {
            priorRates.push(rateFor(Number(row.income), Number(row.expenses)));
        }
    }
    const savingsRate = {
        current: currentSr ? rateFor(Number(currentSr.income), Number(currentSr.expenses)) : 0,
        priorRates,
    };

    // --- 4. Net worth: ~30 days ago vs now --------------------------------
    let netWorth = { previous: 0, current: 0 };
    try {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
        const nw = await FinancialSummaryService.computeNetWorthSummary(
            guids,
            thirtyDaysAgo,
            now,
            baseCurrency
        );
        netWorth = { previous: nw.start.netWorth, current: nw.end.netWorth };
    } catch (error) {
        console.error('Insights: net worth load failed:', error);
    }

    // --- 5. Cash balances: now vs 7 days ago -------------------------------
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const cashRows = await prisma.$queryRaw<Array<{
        guid: string;
        name: string;
        current: number;
        week_ago: number;
    }>>`
        SELECT a.guid,
               a.name,
               COALESCE(SUM(CASE WHEN t.post_date <= ${now}
                    THEN s.quantity_num::double precision / NULLIF(s.quantity_denom, 0)::double precision
                    ELSE 0 END), 0) AS current,
               COALESCE(SUM(CASE WHEN t.post_date <= ${weekAgo}
                    THEN s.quantity_num::double precision / NULLIF(s.quantity_denom, 0)::double precision
                    ELSE 0 END), 0) AS week_ago
        FROM accounts a
        LEFT JOIN splits s ON s.account_guid = a.guid
        LEFT JOIN transactions t ON t.guid = s.tx_guid
        WHERE a.account_type IN ('BANK', 'CASH')
          AND a.hidden = 0
          AND a.guid = ANY(${guids})
        GROUP BY a.guid, a.name
    `;
    const cashBalances: CashBalance[] = cashRows.map(r => ({
        guid: r.guid,
        name: r.name,
        current: Number(r.current),
        weekAgo: Number(r.week_ago),
    }));

    return {
        month,
        weekKey: isoWeekKey(now),
        currency,
        categories,
        newMerchants,
        savingsRate,
        netWorth,
        cashBalances,
    };
}

/* ------------------------------------------------------------------ */
/* Runner + list/dismiss                                               */
/* ------------------------------------------------------------------ */

interface InsightRow {
    id: number;
    kind: string;
    dedupe_key: string;
    payload: {
        severity?: string;
        title?: string;
        detail?: string;
        href?: string;
    };
    created_at: Date;
    dismissed_at: Date | null;
}

function toStored(row: InsightRow): StoredInsight {
    const p = row.payload ?? {};
    return {
        id: row.id,
        kind: row.kind as InsightKind,
        severity: (p.severity as InsightSeverity) ?? 'info',
        title: p.title ?? row.dedupe_key,
        detail: p.detail ?? '',
        href: p.href ?? '/dashboard',
        createdAt: row.created_at.toISOString(),
        dismissedAt: row.dismissed_at ? row.dismissed_at.toISOString() : null,
    };
}

/**
 * Run every detector for a book, optionally polish the copy with AI (one
 * batched call, template text as fallback), and persist the new insights.
 * Dedupe happens via the (book_guid, dedupe_key) unique constraint.
 */
export async function runInsights(
    bookGuid: string,
    userId: number
): Promise<{ detected: number; created: number }> {
    await ensureInsightsTable();

    const source = await loadInsightSource(bookGuid);
    if (!source) return { detected: 0, created: 0 };

    let candidates = computeInsights(source);
    if (candidates.length === 0) return { detected: 0, created: 0 };

    // Skip candidates already persisted so the AI polish call only covers new ones.
    const keys = candidates.map(c => c.dedupeKey);
    const existing = await prisma.$queryRaw<Array<{ dedupe_key: string }>>`
        SELECT dedupe_key FROM gnucash_web_insights
        WHERE book_guid = ${bookGuid} AND dedupe_key = ANY(${keys})
    `;
    const existingKeys = new Set(existing.map(r => r.dedupe_key));
    candidates = candidates.filter(c => !existingKeys.has(c.dedupeKey));
    const detected = candidates.length;
    if (detected === 0) return { detected: 0, created: 0 };

    // Optional AI polish — template text is the fallback on any failure.
    try {
        const config = await getAiConfig(userId);
        if (isAiConfigured(config)) {
            candidates = await polishInsights(candidates, messages =>
                chatComplete(config, messages, { maxTokens: 900, timeoutMs: 20000 })
            );
        }
    } catch (error) {
        console.error('Insights: AI polish failed (using template text):', error);
    }

    let created = 0;
    for (const c of candidates) {
        const payload = JSON.stringify({
            severity: c.severity,
            title: c.title,
            detail: c.detail,
            href: c.href,
        });
        const inserted = await prisma.$executeRaw`
            INSERT INTO gnucash_web_insights (book_guid, kind, dedupe_key, payload)
            VALUES (${bookGuid}, ${c.kind}, ${c.dedupeKey}, ${payload}::jsonb)
            ON CONFLICT (book_guid, dedupe_key) DO NOTHING
        `;
        created += inserted;
    }

    return { detected, created };
}

/** List a book's insights, newest first (undismissed only by default). */
export async function listInsights(
    bookGuid: string,
    options: { includeDismissed?: boolean; limit?: number } = {}
): Promise<StoredInsight[]> {
    await ensureInsightsTable();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await prisma.$queryRaw<InsightRow[]>`
        SELECT id, kind, dedupe_key, payload, created_at, dismissed_at
        FROM gnucash_web_insights
        WHERE book_guid = ${bookGuid}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
    `;
    return filterInsights(rows.map(toStored), options);
}

/** Mark an insight dismissed. Returns false when it doesn't exist (or is another book's). */
export async function dismissInsight(bookGuid: string, id: number): Promise<boolean> {
    await ensureInsightsTable();
    const updated = await prisma.$executeRaw`
        UPDATE gnucash_web_insights
        SET dismissed_at = NOW()
        WHERE id = ${id} AND book_guid = ${bookGuid} AND dismissed_at IS NULL
    `;
    return updated > 0;
}
