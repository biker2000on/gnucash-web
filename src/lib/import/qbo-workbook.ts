/**
 * QuickBooks Online workbook/ZIP ingestion (pure — no database access).
 *
 * QBO's one-click "Export data" (Settings gear → Tools → Export data)
 * produces a ZIP of XLSX workbooks (reports like General Ledger, Balance
 * Sheet, Trial Balance, and lists like the Account List / Chart of Accounts).
 * This module flattens any upload — .zip, .xlsx, or .csv — into plain
 * string[][] sheets that the existing row-level parsers consume, and
 * classifies each sheet by its header row.
 */

import { unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import {
    splitCsvRows,
    detectJournalHeader,
    detectCoaHeader,
    MAX_HEADER_SCAN_ROWS,
} from './qbo-journal';
import { detectGlHeader } from './qbo-gl';
import { detectStatementKind } from './qbo-statements';
import { detectContactListKind } from './qbo-business';

/** Hard cap on rows per sheet (mirrors the CSV route's line cap). */
export const MAX_SHEET_ROWS = 100_000;

export interface UploadSheet {
    /** "workbook name" or "workbook name — sheet name" or CSV base name */
    name: string;
    rows: string[][];
}

export type SheetKind =
    | 'journal'
    | 'general_ledger'
    | 'chart_of_accounts'
    | 'balance_sheet'
    | 'profit_and_loss'
    | 'customers'
    | 'vendors'
    | 'employees'
    | 'unknown';

/* ------------------------------------------------------------------ */
/* Ingestion                                                            */
/* ------------------------------------------------------------------ */

/**
 * Flatten an uploaded file into sheets of rows.
 *
 * - `.zip`  → unzip, recurse into contained .xlsx/.csv entries (other files
 *             are ignored; `__MACOSX`, dotfiles, and traversal paths skipped)
 * - `.xlsx` → every worksheet, formatted the way the CSV export would be
 *             (dates as date strings, never Excel serial numbers)
 * - `.csv`  → the existing tolerant CSV splitter
 *
 * Throws Error (message starts with "Could not read") for corrupt archives.
 */
export function sheetsFromUpload(filename: string, data: Uint8Array | ArrayBuffer): UploadSheet[] {
    const bytes = toU8(data);
    const lower = filename.toLowerCase();
    if (lower.endsWith('.zip')) return sheetsFromZip(filename, bytes);
    if (/\.(xlsx|xlsm|xls)$/.test(lower)) return sheetsFromXlsx(stripExtension(baseName(filename)), bytes);
    return [{ name: stripExtension(baseName(filename)), rows: splitCsvRows(decodeText(bytes)) }];
}

function sheetsFromZip(filename: string, data: Uint8Array): UploadSheet[] {
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(data);
    } catch {
        throw new Error(`Could not read the ZIP file "${filename}" — it may be corrupt or not a ZIP archive.`);
    }

    const sheets: UploadSheet[] = [];
    for (const [path, bytes] of Object.entries(entries)) {
        if (path.includes('..')) continue; // path traversal
        if (path.startsWith('__MACOSX/')) continue;
        const base = baseName(path);
        if (!base || base.startsWith('.')) continue; // directory entry or hidden file
        if (bytes.length === 0) continue;

        if (/\.(xlsx|xlsm|xls)$/i.test(base)) {
            sheets.push(...sheetsFromXlsx(stripExtension(base), bytes));
        } else if (/\.(csv|txt)$/i.test(base)) {
            sheets.push({ name: stripExtension(base), rows: splitCsvRows(decodeText(bytes)) });
        }
        // Everything else (PDFs, images, ...) is ignored.
    }
    return sheets;
}

function sheetsFromXlsx(sourceName: string, data: Uint8Array): UploadSheet[] {
    let workbook: XLSX.WorkBook;
    try {
        // cellDates so date-formatted cells surface as Date objects we can
        // format deterministically (never as raw Excel serial numbers).
        workbook = XLSX.read(data, { type: 'array', cellDates: true });
    } catch {
        throw new Error(`Could not read the Excel workbook "${sourceName}" — it may be corrupt.`);
    }

    const sheets: UploadSheet[] = [];
    for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        if (!ws) continue;
        const rows = worksheetToRows(ws, `${sourceName} / ${sheetName}`);
        if (rows.length === 0) continue;
        sheets.push({
            name: workbook.SheetNames.length > 1 ? `${sourceName} — ${sheetName}` : sourceName,
            rows,
        });
    }
    return sheets;
}

/**
 * Convert a worksheet to trimmed string rows, mirroring what
 * sheet_to_json({header:1, raw:false, defval:''}) produces — except date
 * cells are ALWAYS rendered from their Date value (ISO YYYY-MM-DD, which
 * parseQboDate accepts) so they can never arrive as serial numbers.
 */
function worksheetToRows(ws: XLSX.WorkSheet, label: string): string[][] {
    const ref = ws['!ref'];
    if (!ref) return [];
    const range = XLSX.utils.decode_range(ref);
    if (range.e.r - range.s.r + 1 > MAX_SHEET_ROWS) {
        throw new Error(
            `Could not read the sheet "${label}": it has more than ${MAX_SHEET_ROWS.toLocaleString()} rows. ` +
                'Split the export into smaller date ranges.'
        );
    }

    const rows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
        const row: string[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
            const cell: XLSX.CellObject | undefined = ws[XLSX.utils.encode_cell({ r, c })];
            row.push(cellToString(cell));
        }
        rows.push(row);
    }
    return rows;
}

function cellToString(cell: XLSX.CellObject | undefined): string {
    if (!cell || cell.v === undefined || cell.v === null) return '';
    // Serial-date guard: date cells are formatted from the Date value itself.
    if (cell.t === 'd' || cell.v instanceof Date) {
        const d = cell.v as Date;
        if (!Number.isNaN(d.getTime())) return isoFromDate(d);
    }
    // Prefer the formatted text (what the CSV export shows), else raw value.
    if (typeof cell.w === 'string' && cell.w !== '') return cell.w.trim();
    return String(cell.v).trim();
}

/**
 * SheetJS reconstructs date cells from the Excel serial on a UTC basis, so
 * the UTC components carry the spreadsheet's wall-clock date.
 */
function isoFromDate(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function decodeText(bytes: Uint8Array): string {
    return new TextDecoder('utf-8').decode(bytes);
}

function toU8(data: Uint8Array | ArrayBuffer): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    // Re-wrap Buffer (and other Uint8Array subclasses) as a plain Uint8Array.
    if (Object.getPrototypeOf(data) !== Uint8Array.prototype) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return data;
}

function baseName(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? '';
}

function stripExtension(name: string): string {
    return name.replace(/\.[^.]+$/, '');
}

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

/**
 * Classify a sheet by header detection within the first rows:
 *   - journal:           Date + Account + Debit + Credit (no Balance)
 *   - general_ledger:    Date + Balance + (Amount | Debit + Credit); the
 *                        per-account section structure is handled by qbo-gl
 *   - chart_of_accounts: Account name + Type (no Date)
 *   - balance_sheet / profit_and_loss: report title + QBO type sections
 *                        (qbo-statements; used to type accounts when the
 *                        export has no Chart of Accounts)
 *
 * The running Balance column is what tells a General Ledger from a Journal:
 * QBO's "Export data" GL uses Debit/Credit/Balance, so a Debit/Credit pair
 * alone is not enough to call a sheet a Journal.
 */
export function classifySheet(rows: string[][]): SheetKind {
    const limit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
    const checks: Array<[SheetKind, (cells: string[]) => unknown]> = [
        ['journal', detectJournalHeader],
        ['general_ledger', detectGlHeader],
        ['chart_of_accounts', detectCoaHeader],
    ];
    for (const [kind, detect] of checks) {
        for (let i = 0; i < limit; i++) {
            if (detect(rows[i])) return kind;
        }
    }
    return detectStatementKind(rows) ?? detectContactListKind(rows) ?? 'unknown';
}

export interface ClassifiedSheet extends UploadSheet {
    kind: SheetKind;
}

export interface SourceSheetSelection {
    /** Sheet the transactions come from (Journal preferred over GL) */
    source: ClassifiedSheet | null;
    /** Explicit Chart of Accounts sheet, if the archive has one */
    coa: ClassifiedSheet | null;
    /** Balance Sheet / P&L sheets (fallback typing when there is no CoA) */
    statements: ClassifiedSheet[];
    /** Customer / Vendor / Employee contact lists */
    contacts: ClassifiedSheet[];
}

/**
 * Pick the sheets that feed an import. Among several Journal sheets the one
 * whose name says "journal" wins, then the one with the most rows — the
 * "Export data" ZIP order is alphabetical, and a workbook that merely LOOKS
 * like a Journal must never shadow the real one.
 */
export function selectSourceSheets(sheets: ClassifiedSheet[]): SourceSheetSelection {
    const byPreference = (kind: SheetKind): ClassifiedSheet | null => {
        const candidates = sheets.filter((s) => s.kind === kind);
        if (candidates.length === 0) return null;
        const namePattern = kind === 'journal' ? /journal/i : /general.?ledger|\bgl\b/i;
        const named = candidates.filter((s) => namePattern.test(s.name));
        const pool = named.length > 0 ? named : candidates;
        return pool.reduce((best, s) => (s.rows.length > best.rows.length ? s : best));
    };
    return {
        source: byPreference('journal') ?? byPreference('general_ledger'),
        coa: sheets.find((s) => s.kind === 'chart_of_accounts') ?? null,
        statements: sheets.filter((s) => s.kind === 'balance_sheet' || s.kind === 'profit_and_loss'),
        contacts: sheets.filter((s) => s.kind === 'customers' || s.kind === 'vendors' || s.kind === 'employees'),
    };
}
