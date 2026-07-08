/**
 * Cash Flow Forecast Engine
 *
 * Pure projection math for the Cash Flow Forecasting tool. No database
 * access here — data loading lives in `forecast-data.ts` so this module
 * stays fully unit-testable.
 *
 * The projection model:
 * - Day 0 starts from each account's current balance.
 * - Each subsequent day applies a per-account historical daily run rate
 *   (net flow per day, computed from the past N days of transactions)
 *   plus any scheduled transaction occurrences landing on that date.
 * - Warnings are emitted whenever a projected balance crosses below the
 *   threshold (default $0), per account and for the combined total.
 */

import { computeNextOccurrences, RecurrencePattern } from './recurrence';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ForecastAccount {
    guid: string;
    name: string;
    currentBalance: number;
    /**
     * Skip low-balance warnings for this account (still projected and
     * included in the combined total). Used for CREDIT accounts, where a
     * negative balance means a normal carried card balance, not low cash.
     */
    excludeFromWarnings?: boolean;
}

export interface ForecastEvent {
    /** YYYY-MM-DD */
    date: string;
    accountGuid: string;
    accountName: string;
    amount: number;
    description: string;
}

/** One historical net flow observation (already summed per account is fine too). */
export interface HistoricalFlow {
    accountGuid: string;
    amount: number;
}

export interface ForecastPoint {
    /** YYYY-MM-DD */
    date: string;
    combined: number;
    balances: Record<string, number>;
}

export interface ForecastWarning {
    accountGuid: string;
    accountName: string;
    /** YYYY-MM-DD of the first day the balance is below the threshold */
    date: string;
    projectedBalance: number;
    threshold: number;
    /** True when the account is already below the threshold on day 0 */
    alreadyBelow: boolean;
}

export interface ForecastAccountSummary {
    guid: string;
    name: string;
    startingBalance: number;
    endingBalance: number;
    dailyRunRate: number;
}

export interface ForecastResult {
    startDate: string;
    horizonDays: number;
    threshold: number;
    accounts: ForecastAccountSummary[];
    series: ForecastPoint[];
    events: ForecastEvent[];
    warnings: ForecastWarning[];
}

export interface ForecastInput {
    accounts: ForecastAccount[];
    /** Scheduled transaction occurrences affecting the accounts */
    events: ForecastEvent[];
    /** Per-account daily net-flow rate (guid -> amount per day) */
    runRates: Record<string, number>;
    horizonDays: number;
    /** Balance warning threshold (default 0) */
    threshold?: number;
    /** Projection start date (default: today, local midnight) */
    startDate?: Date;
}

/** Minimal scheduled-transaction shape needed to expand occurrences. */
export interface ScheduledTxLike {
    guid: string;
    name: string;
    lastOccur: string | null;
    endDate: string | null;
    remainingOccurrences: number;
    recurrence: {
        periodType: string;
        mult: number;
        periodStart: string;
        weekendAdjust: string;
    } | null;
    splits: Array<{
        accountGuid: string;
        accountName: string;
        amount: number;
    }>;
}

/** Sentinel guid used for combined-total warnings. */
export const COMBINED_GUID = '__combined__';
export const COMBINED_NAME = 'All selected accounts';

/* ------------------------------------------------------------------ */
/* Date helpers (local time, no UTC drift)                             */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** Format a Date as local YYYY-MM-DD. */
export function toDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Parse a YYYY-MM-DD string as a local date (avoids UTC midnight drift). */
export function parseLocalDate(value: string): Date {
    const [y, m, d] = value.split('-').map(s => parseInt(s, 10));
    return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function round2(value: number): number {
    const rounded = Math.round(value * 100) / 100;
    // Normalize -0
    return rounded === 0 ? 0 : rounded;
}

/* ------------------------------------------------------------------ */
/* Run rate computation                                                */
/* ------------------------------------------------------------------ */

/**
 * Compute a per-account daily net-flow rate from historical flows.
 *
 * @param flows - Historical net flow amounts (one or many entries per account)
 * @param lookbackDays - Number of days the flows cover (e.g. 90)
 * @returns guid -> average net flow per day
 */
export function computeDailyRunRates(
    flows: HistoricalFlow[],
    lookbackDays: number
): Record<string, number> {
    const rates: Record<string, number> = {};
    if (lookbackDays <= 0) return rates;

    for (const flow of flows) {
        if (!Number.isFinite(flow.amount)) continue;
        rates[flow.accountGuid] = (rates[flow.accountGuid] || 0) + flow.amount;
    }
    for (const guid of Object.keys(rates)) {
        rates[guid] = rates[guid] / lookbackDays;
    }
    return rates;
}

/* ------------------------------------------------------------------ */
/* Scheduled occurrence expansion                                      */
/* ------------------------------------------------------------------ */

/**
 * Expand scheduled transactions into forecast events within the horizon.
 * Pure — reuses the shared recurrence engine. Only splits hitting one of
 * the selected accounts become events. Occurrences are strictly after
 * `startDate` (matching the /scheduled-transactions/upcoming semantics).
 */
export function expandScheduledEvents(
    scheduled: ScheduledTxLike[],
    selectedAccountGuids: Set<string>,
    startDate: Date,
    horizonDays: number
): ForecastEvent[] {
    const windowEnd = addDays(startDate, horizonDays);
    const events: ForecastEvent[] = [];

    for (const sx of scheduled) {
        if (!sx.recurrence) continue;
        if (sx.remainingOccurrences === 0) continue;
        if (!sx.splits.some(s => selectedAccountGuids.has(s.accountGuid))) continue;

        const pattern: RecurrencePattern = {
            periodType: sx.recurrence.periodType,
            mult: sx.recurrence.mult,
            periodStart: parseLocalDate(sx.recurrence.periodStart),
            weekendAdjust: sx.recurrence.weekendAdjust,
        };

        const lastOccur = sx.lastOccur ? parseLocalDate(sx.lastOccur) : null;
        const sxEnd = sx.endDate ? parseLocalDate(sx.endDate) : null;
        const effectiveEnd = sxEnd && sxEnd < windowEnd ? sxEnd : windowEnd;
        const remOccur = sx.remainingOccurrences > 0 ? sx.remainingOccurrences : null;

        const dates = computeNextOccurrences(
            pattern,
            lastOccur,
            effectiveEnd,
            remOccur,
            horizonDays + 2, // daily patterns need at most one per day (+ margin)
            startDate
        );

        for (const date of dates) {
            for (const split of sx.splits) {
                if (!selectedAccountGuids.has(split.accountGuid)) continue;
                events.push({
                    date: toDateKey(date),
                    accountGuid: split.accountGuid,
                    accountName: split.accountName,
                    amount: split.amount,
                    description: sx.name,
                });
            }
        }
    }

    events.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
    return events;
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Project per-account and combined daily balances over the horizon.
 *
 * Day 0 is the starting snapshot (current balances plus any events dated
 * on the start date). Each following day applies the daily run rate and
 * that day's scheduled events. Threshold crossings produce warnings.
 */
export function computeForecast(input: ForecastInput): ForecastResult {
    const threshold = input.threshold ?? 0;
    const horizonDays = Math.max(0, Math.floor(input.horizonDays));
    const start = input.startDate
        ? new Date(input.startDate.getFullYear(), input.startDate.getMonth(), input.startDate.getDate())
        : (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })();

    const accountGuids = new Set(input.accounts.map(a => a.guid));
    const nameByGuid = new Map(input.accounts.map(a => [a.guid, a.name]));
    const startKey = toDateKey(start);
    const endKey = toDateKey(addDays(start, horizonDays));

    // Index events by date, keeping only in-window events for selected accounts
    const eventsByDate = new Map<string, ForecastEvent[]>();
    const includedEvents: ForecastEvent[] = [];
    for (const event of input.events) {
        if (!accountGuids.has(event.accountGuid)) continue;
        if (event.date < startKey || event.date > endKey) continue;
        const list = eventsByDate.get(event.date) || [];
        list.push(event);
        eventsByDate.set(event.date, list);
        includedEvents.push(event);
    }
    includedEvents.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));

    // Running balances (unrounded)
    const balances = new Map<string, number>();
    for (const account of input.accounts) {
        balances.set(account.guid, account.currentBalance);
    }

    const series: ForecastPoint[] = [];
    const warnings: ForecastWarning[] = [];
    // Tracks which side of the threshold each account (and combined) was on
    const belowState = new Map<string, boolean>();

    const applyEvents = (dateKey: string) => {
        const dayEvents = eventsByDate.get(dateKey);
        if (!dayEvents) return;
        for (const event of dayEvents) {
            balances.set(event.accountGuid, (balances.get(event.accountGuid) || 0) + event.amount);
        }
    };

    const snapshot = (dateKey: string, isFirstDay: boolean) => {
        const pointBalances: Record<string, number> = {};
        let combined = 0;
        for (const account of input.accounts) {
            const balance = balances.get(account.guid) || 0;
            combined += balance;
            pointBalances[account.guid] = round2(balance);

            const isBelow = balance < threshold;
            const wasBelow = belowState.get(account.guid) ?? false;
            if (isBelow && !account.excludeFromWarnings && (isFirstDay || !wasBelow)) {
                warnings.push({
                    accountGuid: account.guid,
                    accountName: nameByGuid.get(account.guid) || account.guid,
                    date: dateKey,
                    projectedBalance: round2(balance),
                    threshold,
                    alreadyBelow: isFirstDay,
                });
            }
            belowState.set(account.guid, isBelow);
        }

        if (input.accounts.length > 0) {
            const combinedBelow = combined < threshold;
            const combinedWasBelow = belowState.get(COMBINED_GUID) ?? false;
            if (combinedBelow && (isFirstDay || !combinedWasBelow)) {
                warnings.push({
                    accountGuid: COMBINED_GUID,
                    accountName: COMBINED_NAME,
                    date: dateKey,
                    projectedBalance: round2(combined),
                    threshold,
                    alreadyBelow: isFirstDay,
                });
            }
            belowState.set(COMBINED_GUID, combinedBelow);
        }

        series.push({ date: dateKey, combined: round2(combined), balances: pointBalances });
    };

    // Day 0
    applyEvents(startKey);
    snapshot(startKey, true);

    // Days 1..N
    for (let day = 1; day <= horizonDays; day++) {
        const dateKey = toDateKey(addDays(start, day));
        for (const account of input.accounts) {
            const rate = input.runRates[account.guid] || 0;
            balances.set(account.guid, (balances.get(account.guid) || 0) + rate);
        }
        applyEvents(dateKey);
        snapshot(dateKey, false);
    }

    const accounts: ForecastAccountSummary[] = input.accounts.map(account => ({
        guid: account.guid,
        name: account.name,
        startingBalance: round2(account.currentBalance),
        endingBalance: round2(balances.get(account.guid) || 0),
        dailyRunRate: round2(input.runRates[account.guid] || 0),
    }));

    warnings.sort((a, b) => a.date.localeCompare(b.date) || a.accountName.localeCompare(b.accountName));

    return {
        startDate: startKey,
        horizonDays,
        threshold,
        accounts,
        series,
        events: includedEvents,
        warnings,
    };
}
