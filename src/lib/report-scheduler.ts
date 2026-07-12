import prisma from '@/lib/prisma';
import { sendEmail, isEmailConfigured } from '@/lib/email';
import { generateBalanceSheet } from '@/lib/reports/balance-sheet';
import { generateIncomeStatement } from '@/lib/reports/income-statement';
import { generateCashFlow } from '@/lib/reports/cash-flow';
import { generateTrialBalance } from '@/lib/reports/trial-balance';
import {
    selectPeriodNums,
    buildBudgetReportGroups,
    buildBudgetReportSections,
    type BudgetReportAccountInput,
} from '@/lib/reports/budget-report';
import {
    computePeriodRanges,
    signCorrectAmount,
    type BudgetRecurrence,
} from '@/lib/budget-actuals';
import { generateCSV, generateTrialBalanceCSV, generateChartCSV } from '@/lib/reports/csv-export';
import { toDecimalNumber } from '@/lib/gnucash';
import { getSavedReport } from '@/lib/reports/saved-reports';
import {
    ReportType,
    type ReportData,
    type ReportFilters,
    type TrialBalanceData,
    type ChartReportData,
    type LineItem,
} from '@/lib/reports/types';

/**
 * Report Scheduler — periodic email delivery of saved/standard reports.
 *
 * Storage follows the lazy-table + advisory-lock pattern from notifications.ts:
 * the `gnucash_web_report_schedules` table is created on first use, no Prisma
 * schema change required.
 *
 * Cadence model: every schedule resolves, for any given `now`, to its most
 * recent anchor occurrence (a YYYY-MM-DD date). A schedule is DUE when that
 * occurrence differs from `last_run_period`. After a successful send the
 * occurrence is stamped into `last_run_period`, which makes runs idempotent
 * per period no matter how often the daily job fires (and lets missed days
 * catch up later in the same period).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleCadence = 'weekly' | 'monthly' | 'quarterly';

export const SCHEDULE_CADENCES: ScheduleCadence[] = ['weekly', 'monthly', 'quarterly'];

/** Curated v1 set of report types the scheduler can render server-side. */
export const SCHEDULABLE_REPORT_TYPES: Array<{ type: string; label: string }> = [
    { type: 'balance_sheet', label: 'Balance Sheet' },
    { type: 'income_statement', label: 'Income Statement' },
    { type: 'cash_flow', label: 'Cash Flow Statement' },
    { type: 'budget_report', label: 'Budget Report' },
    { type: 'net_worth_chart', label: 'Net Worth (table)' },
    { type: 'trial_balance', label: 'Trial Balance' },
];

const SCHEDULABLE_TYPE_SET = new Set(SCHEDULABLE_REPORT_TYPES.map(r => r.type));

export function isSchedulableReportType(type: string | null | undefined): boolean {
    return !!type && SCHEDULABLE_TYPE_SET.has(type);
}

export function schedulableReportLabel(type: string): string {
    return SCHEDULABLE_REPORT_TYPES.find(r => r.type === type)?.label ?? type;
}

export interface ReportSchedule {
    id: number;
    userId: number;
    bookGuid: string;
    /** When set, the schedule targets a saved report config. */
    savedReportId: number | null;
    /** Fallback when no saved report: one of SCHEDULABLE_REPORT_TYPES. */
    baseReportType: string | null;
    config: Record<string, unknown>;
    cadence: ScheduleCadence;
    /** weekly: 0-6 (0=Sunday) · monthly/quarterly: day-of-month 1-28. */
    anchorDay: number;
    /** Comma-separated emails; null/empty falls back to the owner's email. */
    recipients: string | null;
    enabled: boolean;
    lastRunAt: Date | null;
    /** Occurrence key (YYYY-MM-DD) of the last completed run. */
    lastRunPeriod: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ReportScheduleInput {
    savedReportId?: number | null;
    baseReportType?: string | null;
    config?: Record<string, unknown>;
    cadence: ScheduleCadence;
    anchorDay: number;
    recipients?: string | null;
    enabled?: boolean;
}

export interface RunScheduleResult {
    scheduleId: number;
    status: 'sent' | 'skipped' | 'failed';
    detail?: string;
    occurrence?: string;
    recipients?: string[];
}

// ---------------------------------------------------------------------------
// Lazy table
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureReportSchedulesTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_report_schedules_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_report_schedules (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                    book_guid VARCHAR(32) NOT NULL,
                    saved_report_id INTEGER REFERENCES gnucash_web_saved_reports(id) ON DELETE CASCADE,
                    base_report_type VARCHAR(50),
                    config JSONB NOT NULL DEFAULT '{}'::jsonb,
                    cadence VARCHAR(20) NOT NULL DEFAULT 'monthly',
                    anchor_day INTEGER NOT NULL DEFAULT 1,
                    recipients TEXT,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    last_run_at TIMESTAMP,
                    last_run_period VARCHAR(10),
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );

                  CREATE INDEX IF NOT EXISTS idx_report_schedules_user_book
                    ON gnucash_web_report_schedules(user_id, book_guid);
                  CREATE INDEX IF NOT EXISTS idx_report_schedules_enabled
                    ON gnucash_web_report_schedules(enabled)
                    WHERE enabled;
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface ScheduleRow {
    id: number;
    user_id: number;
    book_guid: string;
    saved_report_id: number | null;
    base_report_type: string | null;
    config: unknown;
    cadence: string;
    anchor_day: number;
    recipients: string | null;
    enabled: boolean;
    last_run_at: Date | null;
    last_run_period: string | null;
    created_at: Date;
    updated_at: Date;
}

const ROW_COLUMNS = `
    id, user_id, book_guid, saved_report_id, base_report_type, config,
    cadence, anchor_day, recipients, enabled, last_run_at, last_run_period,
    created_at, updated_at
`;

function toSchedule(row: ScheduleRow): ReportSchedule {
    return {
        id: row.id,
        userId: row.user_id,
        bookGuid: row.book_guid,
        savedReportId: row.saved_report_id,
        baseReportType: row.base_report_type,
        config: (row.config && typeof row.config === 'object' && !Array.isArray(row.config)
            ? row.config as Record<string, unknown>
            : {}),
        cadence: (SCHEDULE_CADENCES.includes(row.cadence as ScheduleCadence)
            ? row.cadence
            : 'monthly') as ScheduleCadence,
        anchorDay: row.anchor_day,
        recipients: row.recipients,
        enabled: row.enabled,
        lastRunAt: row.last_run_at,
        lastRunPeriod: row.last_run_period,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function validateInput(input: ReportScheduleInput): void {
    if (!SCHEDULE_CADENCES.includes(input.cadence)) {
        throw new Error(`Invalid cadence: ${input.cadence}`);
    }
    if (!Number.isInteger(input.anchorDay)) {
        throw new Error('anchorDay must be an integer');
    }
    if (input.savedReportId == null && !isSchedulableReportType(input.baseReportType)) {
        throw new Error('Either savedReportId or a supported baseReportType is required');
    }
    if (input.baseReportType && !isSchedulableReportType(input.baseReportType)) {
        throw new Error(`Unsupported report type for scheduling: ${input.baseReportType}`);
    }
}

export function normalizeRecipients(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const parts = raw
        .split(/[,;\s]+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
    if (parts.length === 0) return null;
    for (const part of parts) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(part)) {
            throw new Error(`Invalid recipient email: ${part}`);
        }
    }
    return parts.join(', ');
}

export async function listReportSchedules(userId: number, bookGuid: string): Promise<ReportSchedule[]> {
    await ensureReportSchedulesTable();
    const rows = await prisma.$queryRawUnsafe<ScheduleRow[]>(
        `SELECT ${ROW_COLUMNS} FROM gnucash_web_report_schedules
         WHERE user_id = $1 AND book_guid = $2
         ORDER BY id`,
        userId,
        bookGuid,
    );
    return rows.map(toSchedule);
}

export async function getReportSchedule(id: number, userId: number): Promise<ReportSchedule | null> {
    await ensureReportSchedulesTable();
    const rows = await prisma.$queryRawUnsafe<ScheduleRow[]>(
        `SELECT ${ROW_COLUMNS} FROM gnucash_web_report_schedules
         WHERE id = $1 AND user_id = $2`,
        id,
        userId,
    );
    return rows.length > 0 ? toSchedule(rows[0]) : null;
}

export async function createReportSchedule(
    userId: number,
    bookGuid: string,
    input: ReportScheduleInput,
): Promise<ReportSchedule> {
    validateInput(input);
    await ensureReportSchedulesTable();

    const recipients = normalizeRecipients(input.recipients);
    const rows = await prisma.$queryRawUnsafe<ScheduleRow[]>(
        `INSERT INTO gnucash_web_report_schedules
           (user_id, book_guid, saved_report_id, base_report_type, config,
            cadence, anchor_day, recipients, enabled)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         RETURNING ${ROW_COLUMNS}`,
        userId,
        bookGuid,
        input.savedReportId ?? null,
        input.baseReportType ?? null,
        JSON.stringify(input.config ?? {}),
        input.cadence,
        clampAnchorDay(input.cadence, input.anchorDay),
        recipients,
        input.enabled ?? true,
    );
    return toSchedule(rows[0]);
}

export async function updateReportSchedule(
    id: number,
    userId: number,
    patch: Partial<ReportScheduleInput>,
): Promise<ReportSchedule | null> {
    const existing = await getReportSchedule(id, userId);
    if (!existing) return null;

    const merged: ReportScheduleInput = {
        savedReportId: patch.savedReportId !== undefined ? patch.savedReportId : existing.savedReportId,
        baseReportType: patch.baseReportType !== undefined ? patch.baseReportType : existing.baseReportType,
        config: patch.config !== undefined ? patch.config : existing.config,
        cadence: patch.cadence !== undefined ? patch.cadence : existing.cadence,
        anchorDay: patch.anchorDay !== undefined ? patch.anchorDay : existing.anchorDay,
        recipients: patch.recipients !== undefined ? patch.recipients : existing.recipients,
        enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    };
    validateInput(merged);

    const recipients = patch.recipients !== undefined
        ? normalizeRecipients(patch.recipients)
        : existing.recipients;

    const rows = await prisma.$queryRawUnsafe<ScheduleRow[]>(
        `UPDATE gnucash_web_report_schedules SET
            saved_report_id = $3,
            base_report_type = $4,
            config = $5::jsonb,
            cadence = $6,
            anchor_day = $7,
            recipients = $8,
            enabled = $9,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2
         RETURNING ${ROW_COLUMNS}`,
        id,
        userId,
        merged.savedReportId ?? null,
        merged.baseReportType ?? null,
        JSON.stringify(merged.config ?? {}),
        merged.cadence,
        clampAnchorDay(merged.cadence, merged.anchorDay),
        recipients,
        merged.enabled ?? true,
    );
    return rows.length > 0 ? toSchedule(rows[0]) : null;
}

export async function deleteReportSchedule(id: number, userId: number): Promise<boolean> {
    await ensureReportSchedulesTable();
    const count = await prisma.$executeRawUnsafe(
        `DELETE FROM gnucash_web_report_schedules WHERE id = $1 AND user_id = $2`,
        id,
        userId,
    );
    return count > 0;
}

async function stampLastRun(id: number, at: Date, occurrence: string): Promise<void> {
    await prisma.$executeRawUnsafe(
        `UPDATE gnucash_web_report_schedules
         SET last_run_at = $2, last_run_period = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        id,
        at,
        occurrence,
    );
}

// ---------------------------------------------------------------------------
// Cadence math (pure, exported for tests)
// ---------------------------------------------------------------------------

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Clamp the anchor day to the cadence's valid range (0-6 weekly, 1-28 otherwise). */
export function clampAnchorDay(cadence: ScheduleCadence, day: number): number {
    const n = Math.trunc(Number.isFinite(day) ? day : 1);
    if (cadence === 'weekly') return Math.min(6, Math.max(0, n));
    return Math.min(28, Math.max(1, n));
}

/**
 * The most recent anchor occurrence (YYYY-MM-DD, UTC) on or before `now`.
 *
 *   weekly    → the last `anchorDay` weekday (0=Sunday … 6=Saturday)
 *   monthly   → the last `anchorDay`-th of a month
 *   quarterly → the last `anchorDay`-th of a quarter's first month (Jan/Apr/Jul/Oct)
 */
export function currentOccurrence(cadence: ScheduleCadence, anchorDay: number, now: Date): string {
    const day = clampAnchorDay(cadence, anchorDay);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (cadence === 'weekly') {
        const diff = (today.getUTCDay() - day + 7) % 7;
        const occ = new Date(today);
        occ.setUTCDate(occ.getUTCDate() - diff);
        return isoDate(occ);
    }

    if (cadence === 'monthly') {
        let occ = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day));
        if (occ.getTime() > today.getTime()) {
            occ = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, day));
        }
        return isoDate(occ);
    }

    // quarterly
    const quarterMonth = Math.floor(today.getUTCMonth() / 3) * 3;
    let occ = new Date(Date.UTC(today.getUTCFullYear(), quarterMonth, day));
    if (occ.getTime() > today.getTime()) {
        occ = new Date(Date.UTC(today.getUTCFullYear(), quarterMonth - 3, day));
    }
    return isoDate(occ);
}

/**
 * The reporting period covered by a run at `occurrence`:
 *   weekly    → the 7 days ending the day before the occurrence
 *   monthly   → the previous calendar month
 *   quarterly → the previous calendar quarter
 */
export function reportPeriodFor(
    cadence: ScheduleCadence,
    occurrence: string,
): { startDate: string; endDate: string } {
    const [y, m, d] = occurrence.split('-').map(n => parseInt(n, 10));

    if (cadence === 'weekly') {
        const end = new Date(Date.UTC(y, m - 1, d - 1));
        const start = new Date(Date.UTC(y, m - 1, d - 7));
        return { startDate: isoDate(start), endDate: isoDate(end) };
    }

    if (cadence === 'monthly') {
        const start = new Date(Date.UTC(y, m - 2, 1));
        const end = new Date(Date.UTC(y, m - 1, 0));
        return { startDate: isoDate(start), endDate: isoDate(end) };
    }

    // quarterly: previous calendar quarter relative to the occurrence's quarter
    const quarterMonth = Math.floor((m - 1) / 3) * 3; // 0-based first month of quarter
    const start = new Date(Date.UTC(y, quarterMonth - 3, 1));
    const end = new Date(Date.UTC(y, quarterMonth, 0));
    return { startDate: isoDate(start), endDate: isoDate(end) };
}

/** A schedule is due when enabled and its current occurrence has not run yet. */
export function isScheduleDue(
    schedule: Pick<ReportSchedule, 'enabled' | 'cadence' | 'anchorDay' | 'lastRunPeriod'>,
    now: Date,
): boolean {
    if (!schedule.enabled) return false;
    return currentOccurrence(schedule.cadence, schedule.anchorDay, now) !== schedule.lastRunPeriod;
}

/** All enabled schedules whose current occurrence has not been run yet. */
export async function dueSchedules(now: Date = new Date()): Promise<ReportSchedule[]> {
    await ensureReportSchedulesTable();
    const rows = await prisma.$queryRawUnsafe<ScheduleRow[]>(
        `SELECT ${ROW_COLUMNS} FROM gnucash_web_report_schedules WHERE enabled = TRUE ORDER BY id`,
    );
    return rows.map(toSchedule).filter(s => isScheduleDue(s, now));
}

// ---------------------------------------------------------------------------
// Report generation (session-free — safe inside the worker)
// ---------------------------------------------------------------------------

export type GeneratedScheduledReport =
    | { kind: 'sections'; data: ReportData }
    | { kind: 'trial_balance'; data: TrialBalanceData }
    | { kind: 'chart'; data: ChartReportData };

/**
 * All account GUIDs under a book's root, resolved without a session
 * (book-scope.ts needs request cookies, which the worker doesn't have).
 */
async function bookAccountGuidsForBook(bookGuid: string): Promise<string[]> {
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) throw new Error(`Book ${bookGuid} not found`);

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
 * Budget report without the session-bound loadBudgetActuals(): loads budgeted
 * amounts + actual splits directly (book-scoped via the provided GUID set) and
 * reuses the pure builders from reports/budget-report.ts.
 */
async function generateBudgetReportData(
    config: Record<string, unknown>,
    filters: ReportFilters,
): Promise<ReportData> {
    const include = {
        recurrences: true,
        amounts: {
            include: {
                account: { select: { name: true, account_type: true } },
            },
        },
    } as const;

    const budgetGuid = typeof config.budgetGuid === 'string' ? config.budgetGuid : null;
    const budget = budgetGuid
        ? await prisma.budgets.findUnique({ where: { guid: budgetGuid }, include })
        : await prisma.budgets.findFirst({ include });
    if (!budget) throw new Error('No budget found for budget report schedule');

    const bookGuids = new Set(filters.bookAccountGuids ?? []);
    const rec = budget.recurrences?.[0] ?? null;
    const recurrence: BudgetRecurrence = rec
        ? {
            periodType: rec.recurrence_period_type,
            mult: rec.recurrence_mult,
            periodStart: isoDate(rec.recurrence_period_start),
        }
        : { periodType: 'month', mult: 1, periodStart: `${new Date().getUTCFullYear()}-01-01` };

    const ranges = computePeriodRanges(recurrence, budget.num_periods);

    // Budgeted matrices per account (sign-corrected, book-scoped).
    const accMeta = new Map<string, { name: string; type: string; budgeted: number[] }>();
    for (const amt of budget.amounts) {
        if (bookGuids.size > 0 && !bookGuids.has(amt.account_guid)) continue;
        if (amt.period_num < 0 || amt.period_num >= budget.num_periods) continue;
        let acc = accMeta.get(amt.account_guid);
        if (!acc) {
            acc = {
                name: amt.account.name,
                type: amt.account.account_type,
                budgeted: new Array(budget.num_periods).fill(0),
            };
            accMeta.set(amt.account_guid, acc);
        }
        const raw = toDecimalNumber(amt.amount_num, amt.amount_denom);
        acc.budgeted[amt.period_num] += signCorrectAmount(acc.type, raw);
    }

    const accountGuids = [...accMeta.keys()];
    const actualMatrices = new Map<string, number[]>();
    if (accountGuids.length > 0) {
        const splits = await prisma.splits.findMany({
            where: {
                account_guid: { in: accountGuids },
                transaction: {
                    post_date: {
                        gte: new Date(`${ranges[0].start}T00:00:00.000Z`),
                        lte: new Date(`${ranges[ranges.length - 1].end}T23:59:59.999Z`),
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
            const dateKey = isoDate(postDate);
            const periodIdx = ranges.findIndex(r => dateKey >= r.start && dateKey <= r.end);
            if (periodIdx < 0) continue;
            let row = actualMatrices.get(split.account_guid);
            if (!row) {
                row = new Array(budget.num_periods).fill(0);
                actualMatrices.set(split.account_guid, row);
            }
            const raw = toDecimalNumber(split.quantity_num, split.quantity_denom);
            row[periodIdx] += signCorrectAmount(accMeta.get(split.account_guid)?.type || '', raw);
        }
    }

    const accounts: BudgetReportAccountInput[] = accountGuids.map(guid => {
        const meta = accMeta.get(guid)!;
        return {
            guid,
            name: meta.name,
            type: meta.type,
            budgeted: meta.budgeted,
            actual: actualMatrices.get(guid) || new Array(budget.num_periods).fill(0),
        };
    });

    // Budget periods overlapping the schedule's reporting window; when none
    // overlap (e.g. last year's budget) fall back to the whole budget.
    let periodNums = selectPeriodNums(ranges, filters.startDate, filters.endDate);
    if (periodNums.length === 0) periodNums = ranges.map(r => r.periodNum);

    const { groups, net } = buildBudgetReportGroups(accounts, periodNums);

    return {
        type: ReportType.BUDGET_REPORT,
        title: `Budget Report — ${budget.name}`,
        generatedAt: new Date().toISOString(),
        filters,
        sections: buildBudgetReportSections(groups),
        grandTotal: net.actual,
    };
}

/**
 * Net worth in table form: assets, liabilities, and net worth at each of the
 * last 12 month-ends (ending with the schedule period's end). Reuses the
 * balance sheet generator so investments get proper price valuation.
 */
async function generateNetWorthTable(filters: ReportFilters): Promise<ChartReportData> {
    const endKey = filters.endDate ?? isoDate(new Date());
    const [ey, em] = endKey.split('-').map(n => parseInt(n, 10));

    const points: string[] = [];
    for (let i = 11; i >= 1; i--) {
        points.push(isoDate(new Date(Date.UTC(ey, em - i, 0)))); // month-end i months back
    }
    points.push(endKey);

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const dataPoints: ChartReportData['dataPoints'] = [];
    for (const point of points) {
        const bs = await generateBalanceSheet({
            startDate: null,
            endDate: point,
            bookAccountGuids: filters.bookAccountGuids,
        });
        const assets = bs.sections.find(s => s.title === 'Assets')?.total ?? 0;
        const liabilities = bs.sections.find(s => s.title === 'Liabilities')?.total ?? 0;
        dataPoints.push({
            date: point,
            assets: round2(assets),
            liabilities: round2(liabilities),
            netWorth: round2(assets - liabilities),
        });
    }

    return {
        type: ReportType.NET_WORTH_CHART,
        title: 'Net Worth',
        generatedAt: new Date().toISOString(),
        filters,
        dataPoints,
        series: ['assets', 'liabilities', 'netWorth'],
    };
}

/** Map a schedulable report type onto its lib generator. */
export async function generateScheduledReport(
    baseReportType: string,
    config: Record<string, unknown>,
    filters: ReportFilters,
): Promise<GeneratedScheduledReport> {
    switch (baseReportType) {
        case 'balance_sheet':
            return { kind: 'sections', data: await generateBalanceSheet(filters) };
        case 'income_statement':
            return { kind: 'sections', data: await generateIncomeStatement(filters) };
        case 'cash_flow':
            return { kind: 'sections', data: await generateCashFlow(filters) };
        case 'budget_report':
            return { kind: 'sections', data: await generateBudgetReportData(config, filters) };
        case 'trial_balance':
            return { kind: 'trial_balance', data: await generateTrialBalance(filters) };
        case 'net_worth_chart':
            return { kind: 'chart', data: await generateNetWorthTable(filters) };
        default:
            throw new Error(`Unsupported report type for scheduling: ${baseReportType}`);
    }
}

// ---------------------------------------------------------------------------
// Email rendering (pure, exported for tests)
// ---------------------------------------------------------------------------

const AMOUNT_FMT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function fmtAmount(n: number): string {
    const rounded = Math.round(n * 100) / 100;
    return AMOUNT_FMT.format(rounded === 0 ? 0 : rounded);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const MONO = "'SFMono-Regular',Consolas,'Liberation Mono','Courier New',monospace";
const TD_BASE = 'padding:6px 12px;font-size:13px;border-bottom:1px solid #1c2740;';
const TD_NUM = `${TD_BASE}text-align:right;font-family:${MONO};color:#e8edf7;white-space:nowrap;`;
const TD_NAME = `${TD_BASE}color:#aeb9d0;`;
const TH = `padding:6px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7d8bab;text-align:left;border-bottom:1px solid #24304a;`;
const TH_NUM = `${TH}text-align:right;`;

function flattenItems(items: LineItem[], depth = 0): Array<{ name: string; amount: number; depth: number }> {
    const out: Array<{ name: string; amount: number; depth: number }> = [];
    for (const item of items) {
        out.push({ name: item.name, amount: item.amount, depth: item.depth ?? depth });
        if (item.children && item.children.length > 0) {
            out.push(...flattenItems(item.children, (item.depth ?? depth) + 1));
        }
    }
    return out;
}

function renderSectionsTable(data: ReportData): string {
    const rows: string[] = [];
    for (const section of data.sections) {
        rows.push(
            `<tr><td colspan="2" style="padding:12px 12px 4px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7d8bab;">${escapeHtml(section.title)}</td></tr>`,
        );
        for (const item of flattenItems(section.items)) {
            rows.push(
                `<tr><td style="${TD_NAME}padding-left:${12 + item.depth * 16}px;">${escapeHtml(item.name)}</td>` +
                `<td style="${TD_NUM}">${fmtAmount(item.amount)}</td></tr>`,
            );
        }
        rows.push(
            `<tr><td style="${TD_NAME}color:#e8edf7;font-weight:600;">Total ${escapeHtml(section.title)}</td>` +
            `<td style="${TD_NUM}font-weight:600;border-top:1px solid #24304a;">${fmtAmount(section.total)}</td></tr>`,
        );
    }
    if (data.grandTotal !== undefined) {
        rows.push(
            `<tr><td style="padding:10px 12px;font-size:13px;color:#e8edf7;font-weight:700;">Net</td>` +
            `<td style="padding:10px 12px;font-size:13px;text-align:right;font-family:${MONO};color:#2dd4bf;font-weight:700;white-space:nowrap;">${fmtAmount(data.grandTotal)}</td></tr>`,
        );
    }
    return `<table role="presentation" width="100%" style="border-collapse:collapse;">${rows.join('')}</table>`;
}

function renderTrialBalanceTable(data: TrialBalanceData): string {
    const rows: string[] = [
        `<tr><th style="${TH}">Account</th><th style="${TH_NUM}">Debit</th><th style="${TH_NUM}">Credit</th></tr>`,
    ];
    for (const entry of data.entries) {
        rows.push(
            `<tr><td style="${TD_NAME}">${escapeHtml(entry.accountPath)}</td>` +
            `<td style="${TD_NUM}">${entry.debit ? fmtAmount(entry.debit) : ''}</td>` +
            `<td style="${TD_NUM}">${entry.credit ? fmtAmount(entry.credit) : ''}</td></tr>`,
        );
    }
    rows.push(
        `<tr><td style="${TD_NAME}color:#e8edf7;font-weight:700;">Totals</td>` +
        `<td style="${TD_NUM}font-weight:700;border-top:1px solid #24304a;">${fmtAmount(data.totalDebits)}</td>` +
        `<td style="${TD_NUM}font-weight:700;border-top:1px solid #24304a;">${fmtAmount(data.totalCredits)}</td></tr>`,
    );
    return `<table role="presentation" width="100%" style="border-collapse:collapse;">${rows.join('')}</table>`;
}

function seriesLabel(key: string): string {
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, c => c.toUpperCase());
}

function renderChartTable(data: ChartReportData): string {
    const rows: string[] = [
        `<tr><th style="${TH}">Date</th>${data.series.map(s => `<th style="${TH_NUM}">${escapeHtml(seriesLabel(s))}</th>`).join('')}</tr>`,
    ];
    for (const point of data.dataPoints) {
        rows.push(
            `<tr><td style="${TD_NAME}">${escapeHtml(String(point.date))}</td>` +
            data.series
                .map(s => `<td style="${TD_NUM}">${typeof point[s] === 'number' ? fmtAmount(point[s] as number) : escapeHtml(String(point[s] ?? ''))}</td>`)
                .join('') +
            `</tr>`,
        );
    }
    return `<table role="presentation" width="100%" style="border-collapse:collapse;">${rows.join('')}</table>`;
}

export interface ScheduleEmailInput {
    reportName: string;
    cadence: ScheduleCadence;
    period: { startDate: string; endDate: string };
    generated: GeneratedScheduledReport;
}

export interface ScheduleEmail {
    subject: string;
    html: string;
    /** Plain-text alternative; the CSV export is appended after a marker. */
    text: string;
    csv: string;
    csvFilename: string;
}

export function buildScheduleCsv(generated: GeneratedScheduledReport): string {
    switch (generated.kind) {
        case 'sections':
            return generateCSV(generated.data);
        case 'trial_balance':
            return generateTrialBalanceCSV(generated.data);
        case 'chart':
            return generateChartCSV(generated.data);
    }
}

/** Point-in-time reports are labeled "as of end", flow reports "start → end". */
function periodLabel(generated: GeneratedScheduledReport, period: { startDate: string; endDate: string }): string {
    const type = generated.data.type;
    if (type === ReportType.BALANCE_SHEET || type === ReportType.TRIAL_BALANCE) {
        return `as of ${period.endDate}`;
    }
    return `${period.startDate} → ${period.endDate}`;
}

export function renderScheduleEmail(input: ScheduleEmailInput): ScheduleEmail {
    const label = periodLabel(input.generated, input.period);
    const title = input.generated.data.title || input.reportName;
    const subject = `[GnuCash Web] ${input.reportName} — ${label}`;

    let table: string;
    switch (input.generated.kind) {
        case 'sections':
            table = renderSectionsTable(input.generated.data);
            break;
        case 'trial_balance':
            table = renderTrialBalanceTable(input.generated.data);
            break;
        case 'chart':
            table = renderChartTable(input.generated.data);
            break;
    }

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#0b1220;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#111a2e;border:1px solid #24304a;border-radius:12px;overflow:hidden;">
    <div style="padding:4px 0;background:#2dd4bf;"></div>
    <div style="padding:24px;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7d8bab;margin-bottom:8px;">
        GnuCash Web · scheduled report · ${escapeHtml(input.cadence)}
      </div>
      <h1 style="margin:0 0 4px;font-size:18px;color:#e8edf7;">${escapeHtml(title)}</h1>
      <p style="margin:0 0 16px;font-size:13px;color:#aeb9d0;">${escapeHtml(input.reportName)} · ${escapeHtml(label)}</p>
      ${table}
    </div>
    <div style="padding:12px 24px;border-top:1px solid #24304a;font-size:11px;color:#7d8bab;">
      You are receiving this because a report schedule is configured in Settings.
      A CSV export is included in the plain-text part of this email.
    </div>
  </div>
</body></html>`;

    const csv = buildScheduleCsv(input.generated);
    const csvFilename = `${input.reportName.replace(/[^\w.-]+/g, '_')}_${input.period.endDate}.csv`;

    const text = [
        `${title}`,
        `${input.reportName} · ${label}`,
        '',
        'A CSV export of this report follows.',
        '',
        `---- CSV (${csvFilename}) ----`,
        csv,
    ].join('\n');

    return { subject, html, text, csv, csvFilename };
}

// ---------------------------------------------------------------------------
// Running schedules
// ---------------------------------------------------------------------------

async function resolveRecipients(schedule: ReportSchedule): Promise<string[]> {
    const explicit = (schedule.recipients || '')
        .split(',')
        .map(r => r.trim())
        .filter(r => r.length > 0);
    if (explicit.length > 0) return explicit;

    const user = await prisma.gnucash_web_users.findUnique({
        where: { id: schedule.userId },
        select: { email: true },
    });
    return user?.email ? [user.email] : [];
}

/**
 * Generate, render, and email one schedule's report, then stamp last_run.
 * Idempotent per period: a schedule whose current occurrence already ran is
 * skipped unless `force` is set (Run-now).
 */
export async function runReportSchedule(
    schedule: ReportSchedule,
    options: { now?: Date; force?: boolean } = {},
): Promise<RunScheduleResult> {
    const now = options.now ?? new Date();
    const force = options.force ?? false;
    const occurrence = currentOccurrence(schedule.cadence, schedule.anchorDay, now);

    if (!force && !schedule.enabled) {
        return { scheduleId: schedule.id, status: 'skipped', detail: 'disabled', occurrence };
    }
    if (!force && schedule.lastRunPeriod === occurrence) {
        return { scheduleId: schedule.id, status: 'skipped', detail: 'already ran this period', occurrence };
    }

    // Resolve the report definition (saved report wins over base type).
    let baseReportType = schedule.baseReportType;
    let config = schedule.config;
    let reportName = baseReportType ? schedulableReportLabel(baseReportType) : 'Report';
    let showZeroBalances = false;
    if (schedule.savedReportId != null) {
        const saved = await getSavedReport(schedule.savedReportId, schedule.userId);
        if (!saved) {
            return { scheduleId: schedule.id, status: 'failed', detail: 'saved report not found', occurrence };
        }
        baseReportType = saved.baseReportType;
        config = { ...saved.config, ...schedule.config };
        reportName = saved.name;
        showZeroBalances = saved.filters?.showZeroBalances ?? false;
    }
    if (!baseReportType || !isSchedulableReportType(baseReportType)) {
        return {
            scheduleId: schedule.id,
            status: 'failed',
            detail: `unsupported report type: ${baseReportType ?? '(none)'}`,
            occurrence,
        };
    }

    if (!isEmailConfigured()) {
        // Don't stamp — the period can still be delivered once SMTP is set up.
        return { scheduleId: schedule.id, status: 'skipped', detail: 'email not configured (SMTP_HOST unset)', occurrence };
    }

    const recipients = await resolveRecipients(schedule);
    if (recipients.length === 0) {
        return { scheduleId: schedule.id, status: 'failed', detail: 'no recipients (user has no email)', occurrence };
    }

    const period = reportPeriodFor(schedule.cadence, occurrence);
    const bookAccountGuids = await bookAccountGuidsForBook(schedule.bookGuid);
    // Dates always come from the cadence period (saved date filters go stale);
    // non-date preferences from the saved report are honored.
    const filters: ReportFilters = {
        startDate: period.startDate,
        endDate: period.endDate,
        showZeroBalances,
        bookAccountGuids,
    };

    const generated = await generateScheduledReport(baseReportType, config, filters);
    const email = renderScheduleEmail({
        reportName,
        cadence: schedule.cadence,
        period,
        generated,
    });

    const sent = await sendEmail({
        to: recipients.join(', '),
        subject: email.subject,
        text: email.text,
        html: email.html,
    });
    if (!sent) {
        return { scheduleId: schedule.id, status: 'failed', detail: 'sendEmail returned false', occurrence };
    }

    await stampLastRun(schedule.id, now, occurrence);
    return { scheduleId: schedule.id, status: 'sent', occurrence, recipients };
}
