/**
 * Deterministic 1099-NEC compliance engine — pure functions only (no DB, no
 * clock reads beyond the injected `asOf`). Given per-vendor cash-paid totals,
 * W-9 / TIN tracking state, and per-year filing state, it derives a
 * per-vendor compliance row: over-threshold flag, W-9 tracking state, the
 * Jan 31 filing due date, days until due, and a single status.
 *
 * Consumed by the 1099 tracker page, the Action Center adapter, and the
 * Money Timeline filing-deadline source.
 */

import { getDefaultNecThreshold } from '@/lib/reports/irs-limits';

const DAY_MS = 86_400_000;

const round2 = (n: number): number => {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
};

/** W-9 tracking state derived from received flag + requested date. */
export type W9TrackingState = 'received' | 'requested' | 'missing';

/**
 * Per-vendor-year compliance status. Precedence:
 *   filed (a 1099-NEC was filed for the year — done, regardless of anything)
 *   → exempt (corps etc.)
 *   → below_threshold (< $600 paid — no filing due)
 *   → overdue (reportable, unfiled, past Jan 31)
 *   → ready_to_file (W-9 on file, inside the filing window or before it)
 *   → awaiting_w9 (W-9 requested but not received)
 *   → missing_w9 (W-9 never requested).
 */
export type Vendor1099ComplianceStatus =
    | 'filed'
    | 'exempt'
    | 'below_threshold'
    | 'overdue'
    | 'ready_to_file'
    | 'awaiting_w9'
    | 'missing_w9';

export interface Vendor1099ComplianceInput {
    vendorGuid: string;
    name: string;
    /** Cash paid to the vendor during the tax year. */
    totalPaid: number;
    exemptFrom1099: boolean;
    w9Received: boolean;
    /** ISO date (YYYY-MM-DD) the W-9 was requested, or null. */
    w9RequestedDate: string | null;
    /** A masked TIN is stored (never the full TIN). */
    tinOnFile: boolean;
    /** ISO date (YYYY-MM-DD) the 1099-NEC was filed for this year, or null. */
    filedDate: string | null;
}

export interface Vendor1099ComplianceRow extends Vendor1099ComplianceInput {
    taxYear: number;
    overThreshold: boolean;
    w9State: W9TrackingState;
    /** Reportable = over threshold and not exempt; a filing is (or was) due. */
    requiresFiling: boolean;
    /** Jan 31 of the year after the tax year (YYYY-MM-DD). */
    filingDueDate: string;
    /** Whole days from asOf until the end of the due date; negative = past. */
    daysUntilDue: number;
    status: Vendor1099ComplianceStatus;
}

export interface Vendor1099ComplianceSummary {
    taxYear: number;
    asOfDate: string;
    filingDueDate: string;
    daysUntilDue: number;
    rows: Vendor1099ComplianceRow[];
    /** Vendors at/over $600 and not exempt. */
    reportableCount: number;
    filedCount: number;
    unfiledCount: number;
    /** Reportable, unfiled vendors without a received W-9. */
    missingW9Count: number;
    /** Sum paid to reportable vendors still unfiled. */
    unfiledTotal: number;
}

/** Jan 31 of the year following the tax year. */
export function filingDueDate(taxYear: number): string {
    return `${taxYear + 1}-01-31`;
}

/** Whole days from `asOf` until the end (23:59:59Z) of the filing due date. */
export function daysUntilFilingDue(taxYear: number, asOf = new Date()): number {
    const due = new Date(`${filingDueDate(taxYear)}T23:59:59Z`);
    return Math.ceil((due.getTime() - asOf.getTime()) / DAY_MS);
}

export function deriveW9State(input: {
    w9Received: boolean;
    w9RequestedDate: string | null;
}): W9TrackingState {
    if (input.w9Received) return 'received';
    if (input.w9RequestedDate) return 'requested';
    return 'missing';
}

/** Evaluate one vendor for one tax year (see status precedence above). */
export function evaluateVendor1099Compliance(
    taxYear: number,
    vendor: Vendor1099ComplianceInput,
    asOf = new Date(),
    threshold = getDefaultNecThreshold(taxYear),
): Vendor1099ComplianceRow {
    if (threshold === null) {
        throw new Error(`No verified 1099-NEC threshold is configured for tax year ${taxYear}`);
    }
    const totalPaid = round2(vendor.totalPaid);
    const overThreshold = totalPaid >= threshold;
    const requiresFiling = overThreshold && !vendor.exemptFrom1099;
    const w9State = deriveW9State(vendor);
    const dueDate = filingDueDate(taxYear);
    const daysUntilDue = daysUntilFilingDue(taxYear, asOf);

    let status: Vendor1099ComplianceStatus;
    if (vendor.filedDate) status = 'filed';
    else if (vendor.exemptFrom1099) status = 'exempt';
    else if (!overThreshold) status = 'below_threshold';
    else if (daysUntilDue < 0) status = 'overdue';
    else if (w9State === 'received') status = 'ready_to_file';
    else if (w9State === 'requested') status = 'awaiting_w9';
    else status = 'missing_w9';

    return {
        ...vendor,
        totalPaid,
        taxYear,
        overThreshold,
        w9State,
        requiresFiling,
        filingDueDate: dueDate,
        daysUntilDue,
        status,
    };
}

/** Evaluate every vendor for a tax year and roll up filing-season totals. */
export function summarizeVendor1099Compliance(
    taxYear: number,
    vendors: ReadonlyArray<Vendor1099ComplianceInput>,
    asOf = new Date(),
    threshold = getDefaultNecThreshold(taxYear),
): Vendor1099ComplianceSummary {
    if (threshold === null) {
        throw new Error(`No verified 1099-NEC threshold is configured for tax year ${taxYear}`);
    }
    const rows = vendors
        .map(vendor => evaluateVendor1099Compliance(taxYear, vendor, asOf, threshold))
        .sort((a, b) => b.totalPaid - a.totalPaid || a.name.localeCompare(b.name));

    const reportable = rows.filter(row => row.requiresFiling);
    const unfiled = reportable.filter(row => !row.filedDate);
    return {
        taxYear,
        asOfDate: asOf.toISOString().slice(0, 10),
        filingDueDate: filingDueDate(taxYear),
        daysUntilDue: daysUntilFilingDue(taxYear, asOf),
        rows,
        reportableCount: reportable.length,
        filedCount: reportable.length - unfiled.length,
        unfiledCount: unfiled.length,
        missingW9Count: unfiled.filter(row => row.w9State !== 'received').length,
        unfiledTotal: round2(unfiled.reduce((sum, row) => sum + row.totalPaid, 0)),
    };
}
