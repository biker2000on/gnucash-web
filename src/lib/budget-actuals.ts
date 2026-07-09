/**
 * Budget vs Actuals Engine
 *
 * Pure math (exported for unit tests) + a DB-bound loader for the budget
 * progress dashboard: per-period budgeted vs actual spend, current-period
 * pacing / overspend projection, and year-over-year comparison.
 *
 * Period → calendar mapping mirrors the digest (`src/lib/digest.ts`
 * loadBudgetSection): monthly periods are whole calendar months offset from
 * the recurrence's period_start (year/month only — the day component is
 * ignored, matching how the digest maps a YYYY-MM month to a period index).
 * Yearly periods are 12-month blocks, weekly/daily periods are day-based
 * blocks anchored to period_start.
 *
 * Sign conventions (GnuCash): INCOME amounts (both budgeted and actual) are
 * stored negative and are negated here so "positive = earned/planned income".
 * EXPENSE amounts are already positive-spend. Other account types (transfer
 * targets) are passed through raw.
 *
 * Roll-ups (`periodTotals`, `totals`, `pacing` on the result) cover EXPENSE
 * accounts only — the dashboard's overspend semantics don't make sense when
 * income or transfer accounts are mixed into the sum. Per-account rows are
 * emitted for every budgeted account regardless of type.
 */

import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { toDecimalNumber } from '@/lib/gnucash';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BudgetRecurrence {
    /** GnuCash recurrence period type, e.g. 'month', 'year', 'week', 'day' */
    periodType: string;
    mult: number;
    /** YYYY-MM-DD start of period 0 */
    periodStart: string;
}

export interface PeriodRange {
    periodNum: number;
    /** YYYY-MM-DD inclusive */
    start: string;
    /** YYYY-MM-DD inclusive */
    end: string;
    /** Human label, e.g. "Jan 2026", "Jan–Mar 2026", "2026" */
    label: string;
}

export type PacingStatus = 'on-track' | 'warning' | 'over';

export interface PeriodProgress {
    periodNum: number;
    budgeted: number;
    actual: number;
    /** budgeted - actual (positive = still available) */
    remaining: number;
    /** actual / budgeted * 100, null when budgeted is 0 */
    pctUsed: number | null;
}

export interface TotalProgress {
    budgeted: number;
    actual: number;
    remaining: number;
    pctUsed: number | null;
}

export interface PacingInfo {
    periodNum: number;
    budgeted: number;
    actual: number;
    /** actual / budgeted * 100, null when budgeted is 0 */
    pctUsed: number | null;
    /** Fraction of the period elapsed as of asOf, (0, 1] */
    elapsedFraction: number;
    /** (actual/budgeted) / elapsedFraction — >1 means spending ahead of pace */
    paceRatio: number | null;
    /** actual / elapsedFraction — straight-line end-of-period projection */
    projected: number;
    /** max(0, projected - budgeted) */
    projectedOver: number;
    /**
     * Spend-oriented status: 'over' = actual already exceeds budget,
     * 'warning' = projected to exceed but hasn't yet, else 'on-track'.
     */
    status: PacingStatus;
}

export interface ProgressAccountInput {
    guid: string;
    name: string;
    /** GnuCash account type (EXPENSE, INCOME, ...) */
    type: string;
    currency?: string;
    /** Sign-corrected budgeted amount per period (index = periodNum) */
    budgeted: number[];
    /** Sign-corrected actual amount per period (index = periodNum) */
    actual: number[];
}

export interface ComputeProgressInput {
    ranges: PeriodRange[];
    accounts: ProgressAccountInput[];
    /** YYYY-MM-DD */
    asOf: string;
}

export interface AccountProgress {
    guid: string;
    name: string;
    type: string;
    currency: string;
    periods: PeriodProgress[];
    total: TotalProgress;
    /** Current-period pacing; null when asOf falls outside the budget */
    pacing: PacingInfo | null;
}

export interface BudgetProgressResult {
    currentPeriod: number | null;
    elapsedFraction: number | null;
    accounts: AccountProgress[];
    /** EXPENSE accounts only */
    periodTotals: PeriodProgress[];
    /** EXPENSE accounts only */
    totals: TotalProgress;
    /** EXPENSE accounts only; null when asOf falls outside the budget */
    pacing: PacingInfo | null;
}

export interface YoYInputAccount {
    guid: string;
    name: string;
    type: string;
    /** Sign-corrected actuals per period, current year */
    current: number[];
    /** Sign-corrected actuals per period, same calendar ranges shifted -1 year */
    prior: number[];
}

export interface YoYAccountDelta {
    guid: string;
    name: string;
    type: string;
    current: number;
    prior: number;
    /** current - prior */
    delta: number;
    /** delta / |prior| * 100, null when prior is 0 */
    percent: number | null;
}

export interface YoYTotals {
    current: number;
    prior: number;
    delta: number;
    percent: number | null;
}

export interface YoYResult {
    /** Period numbers included in the comparison (elapsed periods) */
    periodsCompared: number[];
    /** False when no prior-year activity exists in any compared range */
    hasPriorData: boolean;
    /** Sorted by delta descending (biggest spending increase first) */
    accounts: YoYAccountDelta[];
    totals: {
        expense: YoYTotals;
        /** null when the budget has no income accounts */
        income: YoYTotals | null;
    };
}

export interface BudgetActualsResponse {
    budgetGuid: string;
    budgetName: string;
    numPeriods: number;
    currency: string;
    /** YYYY-MM-DD the progress/pacing was computed against */
    asOf: string;
    recurrence: BudgetRecurrence;
    periods: PeriodRange[];
    currentPeriod: number | null;
    elapsedFraction: number | null;
    accounts: AccountProgress[];
    periodTotals: PeriodProgress[];
    totals: TotalProgress;
    pacing: PacingInfo | null;
    /** null when the budget has no accounts */
    yoy: YoYResult | null;
}

/** Compact shape for the budget list cards (?summary=1) */
export interface BudgetActualsSummary {
    budgetGuid: string;
    currency: string;
    currentPeriod: number | null;
    periodLabel: string | null;
    elapsedFraction: number | null;
    /** Expense roll-up pacing for the current period; null when unavailable */
    spend: PacingInfo | null;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const EPSILON = 0.005;
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

function round4(value: number): number {
    const r = Math.round(value * 10000) / 10000;
    return r === 0 ? 0 : r;
}

function isoDateUTC(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function parseKeyUTC(key: string): number {
    return Date.parse(`${key}T00:00:00Z`);
}

function pctOf(actual: number, budgeted: number): number | null {
    return budgeted !== 0 ? round2((actual / budgeted) * 100) : null;
}

/** Sign-correct a raw GnuCash amount: income is stored negative → negate. */
export function signCorrectAmount(accountType: string, raw: number): number {
    return accountType === 'INCOME' ? -raw : raw;
}

/** Shift a YYYY-MM-DD key back one year, clamping Feb 29 → Feb 28. */
export function shiftDateKeyOneYearBack(key: string): string {
    const [y, m, d] = key.split('-').map(n => parseInt(n, 10));
    const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
    return `${y - 1}-${pad2(m)}-${pad2(Math.min(d, lastDay))}`;
}

/* ------------------------------------------------------------------ */
/* Period → calendar mapping (pure)                                    */
/* ------------------------------------------------------------------ */

function labelForRange(startKey: string, endKey: string, monthsPerPeriod: number | null): string {
    const [sy, sm] = startKey.split('-').map(n => parseInt(n, 10));
    const [ey, em] = endKey.split('-').map(n => parseInt(n, 10));

    if (monthsPerPeriod === 1) return `${MONTHS[sm - 1]} ${sy}`;
    if (monthsPerPeriod === 12 && sm === 1) return `${sy}`;
    if (monthsPerPeriod !== null) {
        return sy === ey
            ? `${MONTHS[sm - 1]}–${MONTHS[em - 1]} ${sy}`
            : `${MONTHS[sm - 1]} ${sy} – ${MONTHS[em - 1]} ${ey}`;
    }
    return `${startKey} – ${endKey}`;
}

/**
 * Resolve each budget period to an inclusive calendar date range.
 *
 * Monthly/yearly periods snap to whole calendar months anchored at the
 * recurrence period_start's year+month (day-of-month ignored) — this is the
 * same mapping the digest uses to translate a YYYY-MM month into a period
 * index, so the two views always agree. Weekly/daily periods are exact
 * day-length blocks anchored at period_start.
 */
export function computePeriodRanges(recurrence: BudgetRecurrence, numPeriods: number): PeriodRange[] {
    const type = (recurrence.periodType || 'month').toLowerCase();
    const mult = Math.max(1, recurrence.mult || 1);
    const [psY, psM, psD] = recurrence.periodStart.split('-').map(n => parseInt(n, 10));

    const monthsPerPeriod =
        type === 'year' ? 12 * mult :
        type === 'week' || type === 'day' ? null :
        mult; // 'month', 'end of month', and unknown types default to monthly
    const daysPerPeriod = type === 'week' ? 7 * mult : type === 'day' ? mult : null;

    const ranges: PeriodRange[] = [];
    for (let i = 0; i < numPeriods; i++) {
        let start: Date;
        let end: Date;
        if (monthsPerPeriod !== null) {
            start = new Date(Date.UTC(psY, (psM - 1) + i * monthsPerPeriod, 1));
            end = new Date(Date.UTC(psY, (psM - 1) + (i + 1) * monthsPerPeriod, 0));
        } else {
            start = new Date(Date.UTC(psY, psM - 1, psD + i * daysPerPeriod!));
            end = new Date(Date.UTC(psY, psM - 1, psD + (i + 1) * daysPerPeriod! - 1));
        }
        const startKey = isoDateUTC(start);
        const endKey = isoDateUTC(end);
        ranges.push({
            periodNum: i,
            start: startKey,
            end: endKey,
            label: labelForRange(startKey, endKey, monthsPerPeriod),
        });
    }
    return ranges;
}

/** Find the period containing asOf, or null when outside every range. */
export function findCurrentPeriodNum(ranges: PeriodRange[], asOf: string): number | null {
    for (const r of ranges) {
        if (asOf >= r.start && asOf <= r.end) return r.periodNum;
    }
    return null;
}

/**
 * Fraction of a period elapsed as of asOf (inclusive day count). The first
 * day of the period yields 1/totalDays (never 0 inside the range); the last
 * day yields 1. Clamped to [0, 1] outside the range.
 */
export function computeElapsedFraction(range: { start: string; end: string }, asOf: string): number {
    const start = parseKeyUTC(range.start);
    const end = parseKeyUTC(range.end);
    const at = parseKeyUTC(asOf);
    const totalDays = Math.round((end - start) / DAY_MS) + 1;
    if (totalDays <= 0) return 1;
    if (at < start) return 0;
    if (at >= end) return 1;
    const elapsedDays = Math.round((at - start) / DAY_MS) + 1;
    return Math.min(1, Math.max(0, elapsedDays / totalDays));
}

/* ------------------------------------------------------------------ */
/* Progress + pacing (pure)                                            */
/* ------------------------------------------------------------------ */

/**
 * Current-period pacing for one budgeted/actual pair. Division by the
 * elapsed fraction is guarded: at elapsedFraction 0 the projection falls
 * back to the actual (no extrapolation).
 */
export function computePacing(
    budgeted: number,
    actual: number,
    periodNum: number,
    elapsedFraction: number
): PacingInfo {
    const projected = elapsedFraction > 0 ? actual / elapsedFraction : actual;
    const projectedOver = Math.max(0, projected - budgeted);
    const paceRatio = budgeted !== 0 && elapsedFraction > 0
        ? (actual / budgeted) / elapsedFraction
        : null;

    let status: PacingStatus = 'on-track';
    if (actual > budgeted + EPSILON) status = 'over';
    else if (projected > budgeted + EPSILON) status = 'warning';

    return {
        periodNum,
        budgeted: round2(budgeted),
        actual: round2(actual),
        pctUsed: pctOf(actual, budgeted),
        elapsedFraction: round4(elapsedFraction),
        paceRatio: paceRatio !== null ? round4(paceRatio) : null,
        projected: round2(projected),
        projectedOver: round2(projectedOver),
        status,
    };
}

function makePeriodProgress(periodNum: number, budgeted: number, actual: number): PeriodProgress {
    return {
        periodNum,
        budgeted: round2(budgeted),
        actual: round2(actual),
        remaining: round2(budgeted - actual),
        pctUsed: pctOf(actual, budgeted),
    };
}

function makeTotal(budgeted: number, actual: number): TotalProgress {
    return {
        budgeted: round2(budgeted),
        actual: round2(actual),
        remaining: round2(budgeted - actual),
        pctUsed: pctOf(actual, budgeted),
    };
}

/**
 * Per-account/per-period progress with current-period pacing and expense
 * roll-ups. Pure: `asOf` drives which period is "current".
 */
export function computeBudgetProgress(input: ComputeProgressInput): BudgetProgressResult {
    const { ranges, accounts, asOf } = input;

    const currentPeriod = findCurrentPeriodNum(ranges, asOf);
    const elapsedFraction = currentPeriod !== null
        ? computeElapsedFraction(ranges[currentPeriod], asOf)
        : null;

    const accountProgress: AccountProgress[] = accounts.map(acc => {
        const periods = ranges.map(r =>
            makePeriodProgress(r.periodNum, acc.budgeted[r.periodNum] || 0, acc.actual[r.periodNum] || 0)
        );
        const totalBudgeted = periods.reduce((s, p) => s + p.budgeted, 0);
        const totalActual = periods.reduce((s, p) => s + p.actual, 0);
        const pacing = currentPeriod !== null && elapsedFraction !== null
            ? computePacing(
                acc.budgeted[currentPeriod] || 0,
                acc.actual[currentPeriod] || 0,
                currentPeriod,
                elapsedFraction
            )
            : null;
        return {
            guid: acc.guid,
            name: acc.name,
            type: acc.type,
            currency: acc.currency || 'USD',
            periods,
            total: makeTotal(totalBudgeted, totalActual),
            pacing,
        };
    });

    // Roll-ups over expense accounts only (spend semantics).
    const expense = accounts.filter(a => a.type === 'EXPENSE');
    const periodTotals = ranges.map(r => {
        const b = expense.reduce((s, a) => s + (a.budgeted[r.periodNum] || 0), 0);
        const act = expense.reduce((s, a) => s + (a.actual[r.periodNum] || 0), 0);
        return makePeriodProgress(r.periodNum, b, act);
    });
    const totals = makeTotal(
        periodTotals.reduce((s, p) => s + p.budgeted, 0),
        periodTotals.reduce((s, p) => s + p.actual, 0)
    );
    const pacing = currentPeriod !== null && elapsedFraction !== null
        ? computePacing(
            periodTotals[currentPeriod]?.budgeted ?? 0,
            periodTotals[currentPeriod]?.actual ?? 0,
            currentPeriod,
            elapsedFraction
        )
        : null;

    return { currentPeriod, elapsedFraction, accounts: accountProgress, periodTotals, totals, pacing };
}

/* ------------------------------------------------------------------ */
/* Year-over-year comparison (pure)                                    */
/* ------------------------------------------------------------------ */

/**
 * Compare actuals in the given period numbers against the same calendar
 * ranges one year earlier. Percent is null when the prior value is 0.
 */
export function computeYoY(accounts: YoYInputAccount[], periodNums: number[]): YoYResult {
    const sumPeriods = (values: number[]) =>
        periodNums.reduce((s, p) => s + (values[p] || 0), 0);

    const rows: YoYAccountDelta[] = accounts.map(acc => {
        const current = round2(sumPeriods(acc.current));
        const prior = round2(sumPeriods(acc.prior));
        const delta = round2(current - prior);
        const percent = prior !== 0 ? round2((delta / Math.abs(prior)) * 100) : null;
        return { guid: acc.guid, name: acc.name, type: acc.type, current, prior, delta, percent };
    });
    rows.sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));

    const totalsOf = (subset: YoYAccountDelta[]): YoYTotals => {
        const current = round2(subset.reduce((s, r) => s + r.current, 0));
        const prior = round2(subset.reduce((s, r) => s + r.prior, 0));
        const delta = round2(current - prior);
        const percent = prior !== 0 ? round2((delta / Math.abs(prior)) * 100) : null;
        return { current, prior, delta, percent };
    };

    const expenseRows = rows.filter(r => r.type === 'EXPENSE');
    const incomeRows = rows.filter(r => r.type === 'INCOME');

    return {
        periodsCompared: [...periodNums],
        hasPriorData: rows.some(r => r.prior !== 0),
        accounts: rows,
        totals: {
            expense: totalsOf(expenseRows),
            income: incomeRows.length > 0 ? totalsOf(incomeRows) : null,
        },
    };
}

/* ------------------------------------------------------------------ */
/* DB-bound loader                                                     */
/* ------------------------------------------------------------------ */

interface LoadedSplit {
    account_guid: string;
    quantity_num: bigint;
    quantity_denom: bigint;
    transaction: { post_date: Date | null };
}

async function loadSplits(
    accountGuids: string[],
    startKey: string,
    endKey: string
): Promise<LoadedSplit[]> {
    return prisma.splits.findMany({
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
}

/** Bucket sign-corrected split amounts into per-account/per-period matrices. */
function bucketSplits(
    splits: LoadedSplit[],
    ranges: Array<{ start: string; end: string }>,
    accountTypes: Map<string, string>,
    numPeriods: number
): Map<string, number[]> {
    const matrices = new Map<string, number[]>();
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

/**
 * Load budgeted amounts + actual spend for a budget and compute the full
 * progress/pacing/YoY payload. Book-scoped: budgeted accounts outside the
 * active book are excluded. Returns null when the budget does not exist.
 */
export async function loadBudgetActuals(
    budgetGuid: string,
    options: { asOf?: string } = {}
): Promise<BudgetActualsResponse | null> {
    const budget = await prisma.budgets.findUnique({
        where: { guid: budgetGuid },
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
    if (!budget) return null;

    const bookGuids = new Set(await getBookAccountGuids());
    const asOf = options.asOf ?? isoDateUTC(new Date());

    const rec = budget.recurrences?.[0] ?? null;
    const recurrence: BudgetRecurrence = rec
        ? {
            periodType: rec.recurrence_period_type,
            mult: rec.recurrence_mult,
            periodStart: isoDateUTC(rec.recurrence_period_start),
        }
        : { periodType: 'month', mult: 1, periodStart: `${asOf.slice(0, 4)}-01-01` };

    const ranges = computePeriodRanges(recurrence, budget.num_periods);
    const priorRanges = ranges.map(r => ({
        start: shiftDateKeyOneYearBack(r.start),
        end: shiftDateKeyOneYearBack(r.end),
    }));

    // Budgeted matrices per account (book-scoped, sign-corrected).
    const accMeta = new Map<string, { name: string; type: string; currency: string; budgeted: number[] }>();
    for (const amt of budget.amounts) {
        if (!bookGuids.has(amt.account_guid)) continue;
        if (amt.period_num < 0 || amt.period_num >= budget.num_periods) continue;
        let acc = accMeta.get(amt.account_guid);
        if (!acc) {
            acc = {
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

    const accountGuids = [...accMeta.keys()];
    const accountTypes = new Map(accountGuids.map(g => [g, accMeta.get(g)!.type]));

    let actualMatrices = new Map<string, number[]>();
    let priorMatrices = new Map<string, number[]>();
    if (accountGuids.length > 0) {
        const [currentSplits, priorSplits] = await Promise.all([
            loadSplits(accountGuids, ranges[0].start, ranges[ranges.length - 1].end),
            loadSplits(accountGuids, priorRanges[0].start, priorRanges[priorRanges.length - 1].end),
        ]);
        actualMatrices = bucketSplits(currentSplits, ranges, accountTypes, budget.num_periods);
        priorMatrices = bucketSplits(priorSplits, priorRanges, accountTypes, budget.num_periods);
    }

    const progressAccounts: ProgressAccountInput[] = accountGuids.map(guid => {
        const meta = accMeta.get(guid)!;
        return {
            guid,
            name: meta.name,
            type: meta.type,
            currency: meta.currency,
            budgeted: meta.budgeted,
            actual: actualMatrices.get(guid) || new Array(budget.num_periods).fill(0),
        };
    });

    const progress = computeBudgetProgress({ ranges, accounts: progressAccounts, asOf });

    // YoY over elapsed periods (through the current one); whole budget when
    // asOf falls outside the ranges.
    let yoy: YoYResult | null = null;
    if (progressAccounts.length > 0) {
        const lastPeriod = progress.currentPeriod ?? budget.num_periods - 1;
        const periodNums = Array.from({ length: lastPeriod + 1 }, (_, i) => i);
        yoy = computeYoY(
            progressAccounts.map(acc => ({
                guid: acc.guid,
                name: acc.name,
                type: acc.type,
                current: acc.actual,
                prior: priorMatrices.get(acc.guid) || new Array(budget.num_periods).fill(0),
            })),
            periodNums
        );
    }

    // Budget currency = most frequent account currency.
    const freq = new Map<string, number>();
    for (const acc of progressAccounts) {
        const c = acc.currency || 'USD';
        freq.set(c, (freq.get(c) || 0) + 1);
    }
    const currency = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';

    return {
        budgetGuid: budget.guid,
        budgetName: budget.name,
        numPeriods: budget.num_periods,
        currency,
        asOf,
        recurrence,
        periods: ranges,
        currentPeriod: progress.currentPeriod,
        elapsedFraction: progress.elapsedFraction,
        accounts: progress.accounts,
        periodTotals: progress.periodTotals,
        totals: progress.totals,
        pacing: progress.pacing,
        yoy,
    };
}

/** Reduce a full actuals payload to the compact list-card summary. */
export function toActualsSummary(full: BudgetActualsResponse): BudgetActualsSummary {
    return {
        budgetGuid: full.budgetGuid,
        currency: full.currency,
        currentPeriod: full.currentPeriod,
        periodLabel: full.currentPeriod !== null ? full.periods[full.currentPeriod]?.label ?? null : null,
        elapsedFraction: full.elapsedFraction,
        spend: full.pacing,
    };
}
