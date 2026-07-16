/**
 * Pure timesheet helpers (DB-free, unit tested).
 *
 * - parseTimeInput: multi-format hours input ('2.5', '2:30', '2h 30m',
 *   '150m') normalized to whole minutes, validated to 0–24h.
 * - Week-grid aggregation: entries -> project rows x day cells.
 * - Copy-previous-week: compute the create operations that fill the empty
 *   cells of the current week from the previous week's grid.
 */

import type { TimeEntryDTO } from '@/lib/business/time-tracking.service';

export const MAX_DAY_MINUTES = 24 * 60;

/**
 * A selectable "project" in the timesheet UI: a customer, or a customer/job
 * pair. Served by GET /api/business/time/projects (names only — safe for the
 * restricted timekeeper role).
 */
export interface TimeProject {
    /** Stable row key: `${customerGuid}:${jobGuid ?? ''}`. */
    key: string;
    customerGuid: string;
    customerName: string;
    jobGuid: string | null;
    jobName: string | null;
    /** Display label: "Customer" or "Customer — Job". */
    label: string;
}

/* ------------------------------------------------------------------ */
/* Time input parsing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parse a human time-worked input into whole minutes.
 *
 * Accepted formats (case-insensitive, surrounding whitespace ignored):
 *   '2.5' / '2,5'   -> decimal hours
 *   '2:30'          -> hours:minutes (minutes 0–59)
 *   '2h 30m' / '2h30m' / '2 h' / '1.5h' -> hour/minute units
 *   '150m' / '45 min' -> minutes only
 *   ''              -> 0 (an emptied cell)
 *
 * Returns whole minutes (rounded), or null when the input is not parseable
 * or falls outside 0–24 hours.
 */
export function parseTimeInput(raw: string): number | null {
    const input = raw.trim().toLowerCase();
    if (input === '') return 0;

    let minutes: number | null = null;

    // H:MM (also allows :30 and 1:5 -> 1h05? no — require 1–2 digit minutes 0–59)
    const colon = /^(\d{1,2}):([0-5]?\d)$/.exec(input);
    if (colon) {
        minutes = Number(colon[1]) * 60 + Number(colon[2]);
    }

    // Plain decimal hours: '2', '2.5', '2,5', '.5'
    if (minutes === null && /^(\d+([.,]\d+)?|[.,]\d+)$/.test(input)) {
        minutes = Math.round(parseFloat(input.replace(',', '.')) * 60);
    }

    // Unit forms: '2h', '2h30', '2h 30m', '30m', '1.5h', '2 hrs 15 mins'
    if (minutes === null) {
        const units = /^(?:(\d+(?:[.,]\d+)?|[.,]\d+)\s*h(?:ours?|rs?)?\.?)?\s*(?:(\d+(?:[.,]\d+)?|[.,]\d+)\s*(?:m(?:in(?:ute)?s?)?\.?)?)?$/.exec(input);
        if (units && (units[1] !== undefined || units[2] !== undefined)) {
            const hours = units[1] !== undefined ? parseFloat(units[1].replace(',', '.')) : 0;
            const mins = units[2] !== undefined ? parseFloat(units[2].replace(',', '.')) : 0;
            // Bare trailing number without a unit only counts after an hour
            // part ('2h30' -> 2h 30m); a lone bare number was already handled
            // as decimal hours above, so anything reaching here with only
            // units[2] set must have carried an explicit m suffix.
            if (units[1] === undefined && !/m(?:in(?:ute)?s?)?\.?\s*$/.test(input)) {
                return null;
            }
            minutes = Math.round(hours * 60 + mins);
        }
    }

    if (minutes === null || !isFinite(minutes)) return null;
    if (minutes < 0 || minutes > MAX_DAY_MINUTES) return null;
    return minutes;
}

/** Minutes -> 'H.HH' display string (JetBrains Mono friendly). */
export function formatMinutesAsHours(minutes: number): string {
    return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Date helpers (string based — entryDate is a plain YYYY-MM-DD)       */
/* ------------------------------------------------------------------ */

/** Shift an ISO date string by n days (UTC math, no TZ drift). */
export function addDaysIso(iso: string, n: number): string {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Week grid aggregation                                               */
/* ------------------------------------------------------------------ */

/** Minimal entry shape the grid helpers need (subset of TimeEntryDTO). */
export interface GridEntryLike {
    id: number;
    customerGuid: string | null;
    customerName?: string | null;
    jobGuid: string | null;
    jobName?: string | null;
    entryDate: string;
    minutes: number;
    billable: boolean;
    description?: string;
    invoicedInvoiceGuid?: string | null;
    running?: boolean;
}

/** A project row is a customer (or customer+job) pair; '' parts = none. */
export function projectKeyOf(e: { customerGuid: string | null; jobGuid: string | null }): string {
    return `${e.customerGuid ?? ''}:${e.jobGuid ?? ''}`;
}

export interface GridCell {
    minutes: number;
    entryIds: number[];
    /** Number of entries backing this cell (>1 -> open the day detail). */
    count: number;
    /** True when any backing entry is billable. */
    billable: boolean;
    /** Description of the single backing entry ('' when 0 or >1). */
    description: string;
    /** Any backing entry already invoiced (cell is locked). */
    hasInvoiced: boolean;
    /** Any backing entry has a running timer (cell is locked). */
    hasRunning: boolean;
}

export interface GridRow {
    key: string;
    customerGuid: string | null;
    customerName: string | null;
    jobGuid: string | null;
    jobName: string | null;
    /** dateIso -> cell (only days that have entries). */
    cells: Map<string, GridCell>;
    totalMinutes: number;
}

/**
 * Aggregate a week's entries into project rows x day cells. Entries sharing
 * the same project and day merge into one cell (count reflects how many).
 */
export function aggregateWeekCells(entries: ReadonlyArray<GridEntryLike>): Map<string, GridRow> {
    const rows = new Map<string, GridRow>();
    for (const e of entries) {
        const key = projectKeyOf(e);
        let row = rows.get(key);
        if (!row) {
            row = {
                key,
                customerGuid: e.customerGuid,
                customerName: e.customerName ?? null,
                jobGuid: e.jobGuid,
                jobName: e.jobName ?? null,
                cells: new Map(),
                totalMinutes: 0,
            };
            rows.set(key, row);
        }
        let cell = row.cells.get(e.entryDate);
        if (!cell) {
            cell = {
                minutes: 0,
                entryIds: [],
                count: 0,
                billable: false,
                description: '',
                hasInvoiced: false,
                hasRunning: false,
            };
            row.cells.set(e.entryDate, cell);
        }
        cell.minutes += e.minutes;
        cell.entryIds.push(e.id);
        cell.count += 1;
        cell.billable = cell.billable || e.billable;
        cell.description = cell.count === 1 ? (e.description ?? '') : '';
        cell.hasInvoiced = cell.hasInvoiced || Boolean(e.invoicedInvoiceGuid);
        cell.hasRunning = cell.hasRunning || Boolean(e.running);
        row.totalMinutes += e.minutes;
    }
    return rows;
}

/** Per-day totals across all rows for a list of ISO days. */
export function dayTotals(entries: ReadonlyArray<GridEntryLike>, days: ReadonlyArray<string>): Map<string, number> {
    const totals = new Map<string, number>(days.map((d) => [d, 0]));
    for (const e of entries) {
        if (totals.has(e.entryDate)) {
            totals.set(e.entryDate, (totals.get(e.entryDate) ?? 0) + e.minutes);
        }
    }
    return totals;
}

/* ------------------------------------------------------------------ */
/* Copy previous week                                                  */
/* ------------------------------------------------------------------ */

export interface CopyWeekOp {
    customerGuid: string | null;
    jobGuid: string | null;
    /** Target date in the CURRENT week. */
    entryDate: string;
    minutes: number;
    billable: boolean;
}

/**
 * Compute the entry-create operations for "Copy previous week": each
 * previous-week project/day cell is shifted forward by `offsetDays` (default
 * one week) and copied ONLY when the corresponding current-week cell is
 * empty. Running-timer entries and zero-minute cells are skipped; notes and
 * rates are not copied (rates re-resolve to their defaults server-side).
 */
export function buildCopyWeekOps(
    previousWeekEntries: ReadonlyArray<GridEntryLike>,
    currentWeekEntries: ReadonlyArray<GridEntryLike>,
    offsetDays = 7,
): CopyWeekOp[] {
    const source = aggregateWeekCells(previousWeekEntries.filter((e) => !e.running));
    const existing = new Set(
        currentWeekEntries.map((e) => `${projectKeyOf(e)}@${e.entryDate}`),
    );

    const ops: CopyWeekOp[] = [];
    for (const row of source.values()) {
        for (const [dateIso, cell] of row.cells) {
            if (cell.minutes <= 0) continue;
            const targetDate = addDaysIso(dateIso, offsetDays);
            if (existing.has(`${row.key}@${targetDate}`)) continue;
            ops.push({
                customerGuid: row.customerGuid,
                jobGuid: row.jobGuid,
                entryDate: targetDate,
                minutes: cell.minutes,
                billable: cell.billable,
            });
        }
    }
    // Deterministic order: date, then project key.
    ops.sort((a, b) => a.entryDate.localeCompare(b.entryDate)
        || `${a.customerGuid ?? ''}:${a.jobGuid ?? ''}`.localeCompare(`${b.customerGuid ?? ''}:${b.jobGuid ?? ''}`));
    return ops;
}

/* ------------------------------------------------------------------ */
/* Misc UI helpers                                                     */
/* ------------------------------------------------------------------ */

/** Compute hours between two 'HH:MM' times (end may cross midnight -> null). */
export function hoursBetween(start: string, end: string): number | null {
    const re = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    const s = re.exec(start);
    const e = re.exec(end);
    if (!s || !e) return null;
    const startMin = Number(s[1]) * 60 + Number(s[2]);
    const endMin = Number(e[1]) * 60 + Number(e[2]);
    if (endMin <= startMin) return null;
    return Math.round(((endMin - startMin) / 60) * 100) / 100;
}

/** Type re-export convenience for components. */
export type { TimeEntryDTO };
