/**
 * Timesheet pure helpers — parseTimeInput formats/bounds, week-grid cell
 * aggregation, and copy-previous-week logic.
 */

import { describe, it, expect } from 'vitest';
import {
    parseTimeInput,
    formatMinutesAsHours,
    addDaysIso,
    projectKeyOf,
    aggregateWeekCells,
    dayTotals,
    buildCopyWeekOps,
    hoursBetween,
    type GridEntryLike,
} from '../timesheet';

const CUST_A = 'a'.repeat(32);
const CUST_B = 'b'.repeat(32);
const JOB_1 = '1'.repeat(32);

let nextId = 1;
function entry(overrides: Partial<GridEntryLike>): GridEntryLike {
    return {
        id: nextId++,
        customerGuid: CUST_A,
        customerName: 'Acme',
        jobGuid: null,
        jobName: null,
        entryDate: '2026-07-13',
        minutes: 60,
        billable: true,
        description: '',
        invoicedInvoiceGuid: null,
        running: false,
        ...overrides,
    };
}

describe('parseTimeInput', () => {
    it('parses decimal hours', () => {
        expect(parseTimeInput('2.5')).toBe(150);
        expect(parseTimeInput('2,5')).toBe(150);
        expect(parseTimeInput('2')).toBe(120);
        expect(parseTimeInput('.25')).toBe(15);
        expect(parseTimeInput('0')).toBe(0);
    });

    it('parses H:MM', () => {
        expect(parseTimeInput('2:30')).toBe(150);
        expect(parseTimeInput('0:45')).toBe(45);
        expect(parseTimeInput('12:05')).toBe(725);
    });

    it('parses hour/minute unit forms', () => {
        expect(parseTimeInput('2h 30m')).toBe(150);
        expect(parseTimeInput('2h30m')).toBe(150);
        expect(parseTimeInput('2h30')).toBe(150);
        expect(parseTimeInput('2h')).toBe(120);
        expect(parseTimeInput('1.5h')).toBe(90);
        expect(parseTimeInput('150m')).toBe(150);
        expect(parseTimeInput('45 min')).toBe(45);
        expect(parseTimeInput('2 hrs 15 mins')).toBe(135);
    });

    it('treats an empty string as zero (cleared cell)', () => {
        expect(parseTimeInput('')).toBe(0);
        expect(parseTimeInput('   ')).toBe(0);
    });

    it('rejects garbage', () => {
        expect(parseTimeInput('abc')).toBeNull();
        expect(parseTimeInput('2:75')).toBeNull();
        expect(parseTimeInput('1.2.3')).toBeNull();
        expect(parseTimeInput('-2')).toBeNull();
        expect(parseTimeInput('2h 30x')).toBeNull();
    });

    it('enforces the 0–24h bound', () => {
        expect(parseTimeInput('24')).toBe(1440);
        expect(parseTimeInput('24.1')).toBeNull();
        expect(parseTimeInput('25h')).toBeNull();
        expect(parseTimeInput('1441m')).toBeNull();
        expect(parseTimeInput('1440m')).toBe(1440);
    });
});

describe('formatMinutesAsHours / addDaysIso / hoursBetween', () => {
    it('formats minutes as fixed 2-decimal hours', () => {
        expect(formatMinutesAsHours(90)).toBe('1.50');
        expect(formatMinutesAsHours(50)).toBe('0.83');
    });

    it('shifts ISO dates across month boundaries', () => {
        expect(addDaysIso('2026-07-13', 7)).toBe('2026-07-20');
        expect(addDaysIso('2026-07-30', 7)).toBe('2026-08-06');
        expect(addDaysIso('2026-01-01', -7)).toBe('2025-12-25');
    });

    it('computes hours between start/end times', () => {
        expect(hoursBetween('09:00', '17:30')).toBe(8.5);
        expect(hoursBetween('09:00', '09:00')).toBeNull();
        expect(hoursBetween('17:00', '09:00')).toBeNull();
        expect(hoursBetween('9:00', '10:15')).toBe(1.25);
        expect(hoursBetween('bogus', '10:00')).toBeNull();
    });
});

describe('aggregateWeekCells', () => {
    it('merges same project + same day into one cell', () => {
        const rows = aggregateWeekCells([
            entry({ minutes: 60, description: 'morning' }),
            entry({ minutes: 30, description: 'afternoon' }),
        ]);
        const row = rows.get(`${CUST_A}:`);
        expect(row).toBeDefined();
        const cell = row!.cells.get('2026-07-13')!;
        expect(cell.minutes).toBe(90);
        expect(cell.count).toBe(2);
        expect(cell.entryIds).toHaveLength(2);
        // Multi-entry cells expose no single description
        expect(cell.description).toBe('');
        expect(row!.totalMinutes).toBe(90);
    });

    it('keeps distinct projects (customer vs customer+job) apart', () => {
        const rows = aggregateWeekCells([
            entry({}),
            entry({ jobGuid: JOB_1, jobName: 'Website' }),
            entry({ customerGuid: CUST_B, customerName: 'Beta' }),
        ]);
        expect(rows.size).toBe(3);
        expect(projectKeyOf({ customerGuid: CUST_A, jobGuid: JOB_1 })).toBe(`${CUST_A}:${JOB_1}`);
    });

    it('flags invoiced and running cells and preserves single descriptions', () => {
        const rows = aggregateWeekCells([
            entry({ invoicedInvoiceGuid: 'i'.repeat(32), description: 'locked work' }),
            entry({ entryDate: '2026-07-14', running: true }),
        ]);
        const row = rows.get(`${CUST_A}:`)!;
        expect(row.cells.get('2026-07-13')!.hasInvoiced).toBe(true);
        expect(row.cells.get('2026-07-13')!.description).toBe('locked work');
        expect(row.cells.get('2026-07-14')!.hasRunning).toBe(true);
    });

    it('computes day totals across rows', () => {
        const totals = dayTotals(
            [entry({ minutes: 60 }), entry({ customerGuid: CUST_B, minutes: 45 })],
            ['2026-07-13', '2026-07-14'],
        );
        expect(totals.get('2026-07-13')).toBe(105);
        expect(totals.get('2026-07-14')).toBe(0);
    });
});

describe('buildCopyWeekOps', () => {
    const prev = [
        entry({ entryDate: '2026-07-06', minutes: 120 }),                      // Mon
        entry({ entryDate: '2026-07-06', minutes: 60 }),                       // Mon (same cell)
        entry({ entryDate: '2026-07-08', minutes: 90, jobGuid: JOB_1 }),       // Wed, job row
        entry({ entryDate: '2026-07-09', minutes: 45, billable: false }),      // Thu, non-billable
        entry({ entryDate: '2026-07-10', minutes: 0 }),                        // Fri, zero -> skipped
        entry({ entryDate: '2026-07-10', minutes: 30, running: true }),        // Fri, running -> skipped
    ];

    it('shifts cells forward one week, aggregating multi-entry cells', () => {
        const ops = buildCopyWeekOps(prev, []);
        expect(ops).toEqual([
            { customerGuid: CUST_A, jobGuid: null, entryDate: '2026-07-13', minutes: 180, billable: true },
            { customerGuid: CUST_A, jobGuid: JOB_1, entryDate: '2026-07-15', minutes: 90, billable: true },
            { customerGuid: CUST_A, jobGuid: null, entryDate: '2026-07-16', minutes: 45, billable: false },
        ]);
    });

    it('never overwrites a current-week cell that already has entries', () => {
        const current = [entry({ entryDate: '2026-07-13', minutes: 15 })];
        const ops = buildCopyWeekOps(prev, current);
        expect(ops.map((o) => o.entryDate)).toEqual(['2026-07-15', '2026-07-16']);
    });

    it('a different project on the same day does not block the copy', () => {
        const current = [entry({ customerGuid: CUST_B, entryDate: '2026-07-13', minutes: 15 })];
        const ops = buildCopyWeekOps(prev, current);
        expect(ops.some((o) => o.entryDate === '2026-07-13' && o.customerGuid === CUST_A)).toBe(true);
    });
});
