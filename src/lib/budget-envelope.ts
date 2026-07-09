/**
 * Envelope / Rollover Budgeting + Overspend Alerts
 *
 * Builds on the Budget vs Actuals engine (`budget-actuals.ts`) without
 * modifying it. Three responsibilities:
 *
 * 1. Rollover math (pure): for rollover-enabled budget lines, each period's
 *    unspent remaining (or overspend deficit) carries forward cumulatively:
 *        effectiveBudgeted(p) = budgeted(p) + carryIn(p)
 *        carryOut(p)          = effectiveBudgeted(p) − actual(p)
 *        carryIn(p+1)         = carryOut(p)
 *    Sinking funds fall out of the same math — budget a little every period,
 *    spend rarely, and the envelope balance accumulates.
 *
 * 2. Alert evaluation (pure): current-period overspend conditions per
 *    EXPENSE line — 'over' (actual exceeds budget), 'threshold' (pctUsed at
 *    or above a configurable threshold, default 80), and 'projected'
 *    (straight-line pacing projects an overspend). When a rollover envelope
 *    exists for a line, conditions are evaluated against the effective
 *    (carry-adjusted) budget. Income accounts never alert.
 *
 * 3. Loaders: envelope config CRUD against the lazily-created
 *    `gnucash_web_budget_envelopes` table, a merged envelope view for the
 *    UI, and `scanBudgetAlerts` — a session-free scan that pushes NEW
 *    alerts through the shared notifications system (deduped by
 *    source='budget-alert' + a stable source id, mirroring the anomaly scan).
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import { formatCurrency } from '@/lib/format';
import { createNotification, ensureNotificationsTable, type NotificationSeverity } from '@/lib/notifications';
import { loadBookAccountGuids } from '@/lib/anomaly-detection';
import {
    computePeriodRanges,
    findCurrentPeriodNum,
    computeElapsedFraction,
    computePacing,
    signCorrectAmount,
    loadBudgetActuals,
    type BudgetRecurrence,
    type PeriodRange,
    type PacingStatus,
} from '@/lib/budget-actuals';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One configured envelope line (row in gnucash_web_budget_envelopes). */
export interface EnvelopeConfig {
    accountGuid: string;
    rolloverEnabled: boolean;
    /** Per-line alert threshold override (percent); null = use default. */
    alertThresholdPct: number | null;
    /** FK-less link to gnucash_web_goals.id; null = not linked. */
    goalId: number | null;
}

/** Minimal per-account shape the rollover math needs (AccountProgress fits). */
export interface EnvelopeAccountInput {
    guid: string;
    periods: Array<{ periodNum: number; budgeted: number; actual: number }>;
}

export interface EnvelopePeriodState {
    periodNum: number;
    /** Carry from prior periods (positive = surplus, negative = deficit). */
    carryIn: number;
    /** budgeted + carryIn */
    effectiveBudgeted: number;
    /** effectiveBudgeted − actual ("available" for this period) */
    effectiveRemaining: number;
}

export interface AccountEnvelope {
    accountGuid: string;
    rolloverEnabled: boolean;
    periods: EnvelopePeriodState[];
    /** Current-period effectiveRemaining ("available now"); null when no current period. */
    availableNow: number | null;
}

export type BudgetAlertKind = 'threshold' | 'over' | 'projected';

export interface BudgetAlertCandidate {
    accountGuid: string;
    name: string;
    kind: BudgetAlertKind;
    periodNum: number;
    /** actual / effective budgeted × 100 (null when effective budget ≤ 0) */
    pctUsed: number | null;
    /** Effective (carry-adjusted when rollover enabled) budgeted amount evaluated against. */
    budgeted: number;
    actual: number;
    message: string;
    /** Stable dedupe key: budget + account + period + kind. */
    dedupeKey: string;
}

/** Minimal per-account shape alert evaluation needs (AccountProgress fits). */
export interface AlertEvalAccount {
    guid: string;
    name: string;
    /** GnuCash account type; only EXPENSE lines alert. */
    type: string;
    currency?: string;
    periods: Array<{ periodNum: number; budgeted: number; actual: number }>;
    pacing: { projected: number; status: PacingStatus } | null;
}

export interface AlertEvalInput {
    budgetGuid: string;
    currentPeriod: number | null;
    accounts: AlertEvalAccount[];
}

export interface AlertDefaults {
    /** Default alert threshold percent (default 80). */
    thresholdPct?: number;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const EPSILON = 0.005;
export const DEFAULT_ALERT_THRESHOLD_PCT = 80;
const BUDGET_ALERT_SOURCE = 'budget-alert';

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

function isoDateUTC(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/** Stable dedupe key for one alert condition. */
export function budgetAlertDedupeKey(
    budgetGuid: string,
    accountGuid: string,
    periodNum: number,
    kind: BudgetAlertKind
): string {
    return `${budgetGuid}:${accountGuid}:p${periodNum}:${kind}`;
}

/* ------------------------------------------------------------------ */
/* Rollover math (pure)                                                */
/* ------------------------------------------------------------------ */

/**
 * Compute per-account envelope states. Rollover-enabled lines carry each
 * period's surplus/deficit forward cumulatively; disabled (or unconfigured)
 * lines get carryIn 0 everywhere, so effective values equal the raw ones.
 *
 * Every input account is returned (uniform shape for the UI); the
 * `rolloverEnabled` flag records whether carry actually applies.
 */
export function computeRollovers(
    accounts: EnvelopeAccountInput[],
    envelopeConfig: EnvelopeConfig[],
    currentPeriod: number | null
): AccountEnvelope[] {
    const configByAccount = new Map(envelopeConfig.map(c => [c.accountGuid, c]));

    return accounts.map(acc => {
        const rolloverEnabled = configByAccount.get(acc.guid)?.rolloverEnabled ?? false;
        const sorted = [...acc.periods].sort((a, b) => a.periodNum - b.periodNum);

        let carry = 0;
        const periods: EnvelopePeriodState[] = sorted.map(p => {
            const carryIn = rolloverEnabled ? round2(carry) : 0;
            const effectiveBudgeted = round2(p.budgeted + carryIn);
            const effectiveRemaining = round2(effectiveBudgeted - p.actual);
            carry = effectiveRemaining;
            return { periodNum: p.periodNum, carryIn, effectiveBudgeted, effectiveRemaining };
        });

        const current = currentPeriod !== null
            ? periods.find(p => p.periodNum === currentPeriod) ?? null
            : null;

        return {
            accountGuid: acc.guid,
            rolloverEnabled,
            periods,
            availableNow: current ? current.effectiveRemaining : null,
        };
    });
}

/* ------------------------------------------------------------------ */
/* Alert evaluation (pure)                                             */
/* ------------------------------------------------------------------ */

/**
 * Evaluate current-period alert conditions for every EXPENSE line.
 *
 * At most one alert per account, by severity precedence:
 *   over > threshold > projected
 * so an over-budget line doesn't also emit its (implied) threshold alert,
 * while escalation still produces a new dedupe key ('threshold' → 'over').
 *
 * When `rollovers` is provided, rollover-enabled lines evaluate against the
 * carry-adjusted effective budget — a carried surplus can legitimately
 * absorb what would otherwise be an overspend.
 */
export function evaluateBudgetAlerts(
    progress: AlertEvalInput,
    envelopeConfig: EnvelopeConfig[],
    defaults: AlertDefaults = {},
    rollovers?: AccountEnvelope[]
): BudgetAlertCandidate[] {
    const currentPeriod = progress.currentPeriod;
    if (currentPeriod === null) return [];

    const defaultThreshold = defaults.thresholdPct ?? DEFAULT_ALERT_THRESHOLD_PCT;
    const configByAccount = new Map(envelopeConfig.map(c => [c.accountGuid, c]));
    const envelopeByAccount = new Map((rollovers ?? []).map(e => [e.accountGuid, e]));

    const alerts: BudgetAlertCandidate[] = [];

    for (const acc of progress.accounts) {
        if (acc.type !== 'EXPENSE') continue; // income (and transfers) never alert

        const period = acc.periods.find(p => p.periodNum === currentPeriod);
        if (!period) continue;

        const config = configByAccount.get(acc.guid);
        const envelope = envelopeByAccount.get(acc.guid);
        const effBudgeted = envelope?.rolloverEnabled
            ? envelope.periods.find(p => p.periodNum === currentPeriod)?.effectiveBudgeted ?? period.budgeted
            : period.budgeted;
        const actual = period.actual;

        // Skip lines with no budget and no spend — nothing to alert on.
        if (effBudgeted <= 0 && actual <= EPSILON) continue;

        const pctUsed = effBudgeted > 0 ? round2((actual / effBudgeted) * 100) : null;
        const threshold = config?.alertThresholdPct ?? defaultThreshold;
        const currency = acc.currency ?? 'USD';
        const fmt = (v: number) => formatCurrency(v, currency);

        let kind: BudgetAlertKind | null = null;
        let message = '';

        if (actual > effBudgeted + EPSILON) {
            kind = 'over';
            message = `${acc.name} is over budget: ${fmt(actual)} spent of ${fmt(effBudgeted)}${pctUsed !== null ? ` (${pctUsed.toFixed(0)}%)` : ''}.`;
        } else if (pctUsed !== null && pctUsed >= threshold) {
            kind = 'threshold';
            message = `${acc.name} has used ${pctUsed.toFixed(0)}% of its ${fmt(effBudgeted)} budget (${fmt(actual)} spent).`;
        } else if (acc.pacing && effBudgeted > 0 && acc.pacing.projected > effBudgeted + EPSILON) {
            kind = 'projected';
            message = `${acc.name} is pacing to exceed budget: projected ${fmt(acc.pacing.projected)} vs ${fmt(effBudgeted)}.`;
        }

        if (!kind) continue;

        alerts.push({
            accountGuid: acc.guid,
            name: acc.name,
            kind,
            periodNum: currentPeriod,
            pctUsed,
            budgeted: round2(effBudgeted),
            actual: round2(actual),
            message,
            dedupeKey: budgetAlertDedupeKey(progress.budgetGuid, acc.guid, currentPeriod, kind),
        });
    }

    return alerts;
}

/* ------------------------------------------------------------------ */
/* Envelope config table + CRUD                                        */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

/** Lazily create the envelopes table (advisory-lock guarded, idempotent). */
export function ensureEnvelopesTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_budget_envelopes_schema'));

                    CREATE TABLE IF NOT EXISTS gnucash_web_budget_envelopes (
                        id SERIAL PRIMARY KEY,
                        budget_guid VARCHAR(32) NOT NULL,
                        account_guid VARCHAR(32) NOT NULL,
                        rollover_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                        alert_threshold_pct INTEGER,
                        goal_id INTEGER,
                        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE (budget_guid, account_guid)
                    );

                    CREATE INDEX IF NOT EXISTS idx_budget_envelopes_budget
                        ON gnucash_web_budget_envelopes(budget_guid);
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

interface EnvelopeRow {
    account_guid: string;
    rollover_enabled: boolean;
    alert_threshold_pct: number | null;
    goal_id: number | null;
}

/** Load envelope config rows for one budget. */
export async function getEnvelopeConfig(budgetGuid: string): Promise<EnvelopeConfig[]> {
    await ensureEnvelopesTable();
    const rows = await prisma.$queryRaw<EnvelopeRow[]>`
        SELECT account_guid, rollover_enabled, alert_threshold_pct, goal_id
        FROM gnucash_web_budget_envelopes
        WHERE budget_guid = ${budgetGuid}
        ORDER BY account_guid
    `;
    return rows.map(r => ({
        accountGuid: r.account_guid,
        rolloverEnabled: r.rollover_enabled,
        alertThresholdPct: r.alert_threshold_pct,
        goalId: r.goal_id,
    }));
}

/** Upsert envelope config rows (unique on budget_guid + account_guid). */
export async function upsertEnvelopeConfig(
    budgetGuid: string,
    rows: EnvelopeConfig[]
): Promise<void> {
    await ensureEnvelopesTable();
    for (const row of rows) {
        await prisma.$executeRaw`
            INSERT INTO gnucash_web_budget_envelopes
                (budget_guid, account_guid, rollover_enabled, alert_threshold_pct, goal_id)
            VALUES (
                ${budgetGuid},
                ${row.accountGuid},
                ${row.rolloverEnabled},
                ${row.alertThresholdPct},
                ${row.goalId}
            )
            ON CONFLICT (budget_guid, account_guid)
            DO UPDATE SET
                rollover_enabled = EXCLUDED.rollover_enabled,
                alert_threshold_pct = EXCLUDED.alert_threshold_pct,
                goal_id = EXCLUDED.goal_id
        `;
    }
}

/* ------------------------------------------------------------------ */
/* Envelope view (actuals + config + rollovers merged, for the UI)     */
/* ------------------------------------------------------------------ */

export interface EnvelopeViewResponse {
    budgetGuid: string;
    currency: string;
    asOf: string;
    currentPeriod: number | null;
    periods: PeriodRange[];
    config: EnvelopeConfig[];
    envelopes: AccountEnvelope[];
    /** Active alert conditions for the current period. */
    alerts: BudgetAlertCandidate[];
}

/**
 * Merged envelope view for one budget: rollover states per account/period
 * plus the currently-active alert conditions. Session-scoped (uses
 * `loadBudgetActuals`, which book-scopes via the active session).
 * Returns null when the budget does not exist.
 */
export async function getEnvelopeView(
    budgetGuid: string,
    options: { asOf?: string } = {}
): Promise<EnvelopeViewResponse | null> {
    const actuals = await loadBudgetActuals(budgetGuid, options);
    if (!actuals) return null;

    const config = await getEnvelopeConfig(budgetGuid);
    const envelopes = computeRollovers(actuals.accounts, config, actuals.currentPeriod);
    const alerts = evaluateBudgetAlerts(
        { budgetGuid, currentPeriod: actuals.currentPeriod, accounts: actuals.accounts },
        config,
        {},
        envelopes
    );

    return {
        budgetGuid,
        currency: actuals.currency,
        asOf: actuals.asOf,
        currentPeriod: actuals.currentPeriod,
        periods: actuals.periods,
        config,
        envelopes,
        alerts,
    };
}

/* ------------------------------------------------------------------ */
/* Scan + notify (session-free, sync-path safe)                        */
/* ------------------------------------------------------------------ */

interface ScanBudgetAccount {
    guid: string;
    name: string;
    type: string;
    currency: string;
    /** Sign-corrected budgeted per period (index = periodNum). */
    budgeted: number[];
}

/**
 * Session-free actuals for one budget through the current period: buckets
 * split quantities into per-period matrices keyed by account. Mirrors the
 * loader in budget-actuals without touching the session-scoped book helpers.
 */
async function loadActualMatrices(
    accountGuids: string[],
    ranges: PeriodRange[],
    throughPeriod: number,
    accountTypes: Map<string, string>,
    numPeriods: number
): Promise<Map<string, number[]>> {
    const matrices = new Map<string, number[]>();
    if (accountGuids.length === 0) return matrices;

    const startKey = ranges[0].start;
    const endKey = ranges[throughPeriod].end;
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
            account_guid: true,
            quantity_num: true,
            quantity_denom: true,
            transaction: { select: { post_date: true } },
        },
    });

    for (const split of splits) {
        const postDate = split.transaction.post_date;
        if (!postDate) continue;
        const dateKey = isoDateUTC(postDate);
        const periodIdx = ranges.findIndex(r => dateKey >= r.start && dateKey <= r.end);
        if (periodIdx < 0) continue;

        let row = matrices.get(split.account_guid);
        if (!row) {
            row = new Array(numPeriods).fill(0);
            matrices.set(split.account_guid, row);
        }
        const raw = toDecimalNumber(split.quantity_num, split.quantity_denom);
        row[periodIdx] += signCorrectAmount(accountTypes.get(split.account_guid) || '', raw);
    }
    return matrices;
}

export interface BudgetAlertScanOptions {
    /** Owner of the notifications to create. */
    userId: number;
    /** Override the as-of date (YYYY-MM-DD), mainly for testing. */
    asOf?: string;
    /** Max notifications to create in a single scan (default 20). */
    maxNotifications?: number;
}

const ALERT_TITLES: Record<BudgetAlertKind, string> = {
    over: 'Budget exceeded',
    threshold: 'Budget threshold reached',
    projected: 'Projected budget overspend',
};

const ALERT_SEVERITY: Record<BudgetAlertKind, NotificationSeverity> = {
    over: 'error',
    threshold: 'warning',
    projected: 'warning',
};

/**
 * Scan every active budget in the book (a budget is active when the as-of
 * date falls inside one of its periods), evaluate alert conditions against
 * rollover-adjusted budgets, and create notifications for NEW alerts only.
 *
 * Deduped via (source='budget-alert', source_id=<dedupeKey>) exactly like
 * the anomaly scan. Session-free (safe from the SimpleFin sync path).
 * Fire-and-forget safe: never throws.
 */
export async function scanBudgetAlerts(
    bookGuid: string,
    opts: BudgetAlertScanOptions
): Promise<{ detected: number; created: number }> {
    try {
        const asOf = opts.asOf ?? isoDateUTC(new Date());
        const maxNotifications = opts.maxNotifications ?? 20;

        const bookGuids = new Set(await loadBookAccountGuids(bookGuid));

        const budgets = await prisma.budgets.findMany({
            include: {
                recurrences: true,
                amounts: {
                    include: {
                        account: {
                            select: {
                                name: true,
                                account_type: true,
                                commodity: { select: { mnemonic: true } },
                            },
                        },
                    },
                },
            },
        });

        const candidates: Array<BudgetAlertCandidate & { budgetGuid: string }> = [];

        for (const budget of budgets) {
            const rec = budget.recurrences?.[0] ?? null;
            const recurrence: BudgetRecurrence = rec
                ? {
                    periodType: rec.recurrence_period_type,
                    mult: rec.recurrence_mult,
                    periodStart: isoDateUTC(rec.recurrence_period_start),
                }
                : { periodType: 'month', mult: 1, periodStart: `${asOf.slice(0, 4)}-01-01` };

            const ranges = computePeriodRanges(recurrence, budget.num_periods);
            const currentPeriod = findCurrentPeriodNum(ranges, asOf);
            if (currentPeriod === null) continue; // inactive budget

            // Book-scoped, sign-corrected budgeted matrices.
            const accMeta = new Map<string, ScanBudgetAccount>();
            for (const amt of budget.amounts) {
                if (!bookGuids.has(amt.account_guid)) continue;
                if (amt.period_num < 0 || amt.period_num >= budget.num_periods) continue;
                let acc = accMeta.get(amt.account_guid);
                if (!acc) {
                    acc = {
                        guid: amt.account_guid,
                        name: amt.account.name,
                        type: amt.account.account_type,
                        currency: amt.account.commodity?.mnemonic || 'USD',
                        budgeted: new Array(budget.num_periods).fill(0),
                    };
                    accMeta.set(amt.account_guid, acc);
                }
                const raw = toDecimalNumber(amt.amount_num, amt.amount_denom);
                acc.budgeted[amt.period_num] += signCorrectAmount(acc.type, raw);
            }

            const expenseGuids = [...accMeta.values()]
                .filter(a => a.type === 'EXPENSE')
                .map(a => a.guid);
            if (expenseGuids.length === 0) continue;

            const accountTypes = new Map([...accMeta.values()].map(a => [a.guid, a.type]));
            const actualMatrices = await loadActualMatrices(
                expenseGuids,
                ranges,
                currentPeriod,
                accountTypes,
                budget.num_periods
            );

            const elapsedFraction = computeElapsedFraction(ranges[currentPeriod], asOf);
            const accounts: AlertEvalAccount[] = expenseGuids.map(guid => {
                const meta = accMeta.get(guid)!;
                const actual = actualMatrices.get(guid) || new Array(budget.num_periods).fill(0);
                return {
                    guid,
                    name: meta.name,
                    type: meta.type,
                    currency: meta.currency,
                    periods: ranges.map(r => ({
                        periodNum: r.periodNum,
                        budgeted: meta.budgeted[r.periodNum] || 0,
                        actual: actual[r.periodNum] || 0,
                    })),
                    pacing: computePacing(
                        meta.budgeted[currentPeriod] || 0,
                        actual[currentPeriod] || 0,
                        currentPeriod,
                        elapsedFraction
                    ),
                };
            });

            const config = await getEnvelopeConfig(budget.guid);
            const rollovers = computeRollovers(accounts, config, currentPeriod);
            const alerts = evaluateBudgetAlerts(
                { budgetGuid: budget.guid, currentPeriod, accounts },
                config,
                {},
                rollovers
            );
            candidates.push(...alerts.map(a => ({ ...a, budgetGuid: budget.guid })));
        }

        if (candidates.length === 0) return { detected: 0, created: 0 };

        // Pull existing budget-alert source ids for this user+book to dedupe.
        await ensureNotificationsTable();
        const existingRows = await prisma.$queryRaw<Array<{ source_id: string | null }>>`
            SELECT source_id
            FROM gnucash_web_notifications
            WHERE user_id = ${opts.userId}
              AND source = ${BUDGET_ALERT_SOURCE}
              AND (book_guid IS NULL OR book_guid = ${bookGuid})
        `;
        const seen = new Set(existingRows.map(r => r.source_id).filter((s): s is string => !!s));

        let created = 0;
        for (const alert of candidates) {
            if (created >= maxNotifications) break;
            if (seen.has(alert.dedupeKey)) continue;
            seen.add(alert.dedupeKey);

            await createNotification({
                userId: opts.userId,
                bookGuid,
                type: 'budget_alert',
                severity: ALERT_SEVERITY[alert.kind],
                title: ALERT_TITLES[alert.kind],
                message: alert.message,
                href: `/budgets/${alert.budgetGuid}`,
                source: BUDGET_ALERT_SOURCE,
                sourceId: alert.dedupeKey,
            });
            created++;
        }

        return { detected: candidates.length, created };
    } catch (error) {
        // Never let alert scanning break the caller (e.g. the sync path).
        console.warn('Budget alert scan failed:', error);
        return { detected: 0, created: 0 };
    }
}
