import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { zipSync, strToU8 } from 'fflate';
import { sheetsFromUpload, classifySheet } from '../qbo-workbook';
import { parseQboJournalRows, parseQboCoaRows, splitCsvRows } from '../qbo-journal';
import { parseQboGeneralLedgerRows } from '../qbo-gl';

/* ------------------------------------------------------------------ */
/* Fixture builders                                                     */
/* ------------------------------------------------------------------ */

type Aoa = Array<Array<string | number | Date>>;

/**
 * fflate's zipSync type-checks entries with `instanceof Uint8Array`, which
 * fails across the jsdom/node realm boundary for strToU8 output in this test
 * environment — re-wrap to a same-realm Uint8Array.
 */
const u8 = (s: string) => new Uint8Array(strToU8(s));

function xlsxBytes(sheets: Array<{ name: string; data: Aoa }>, cellDates = false): Uint8Array {
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.data, { cellDates }), s.name);
    }
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates }) as ArrayBuffer;
    return new Uint8Array(out);
}

const JOURNAL_AOA: Aoa = [
    ['Craft Supply Co.'],
    ['Journal'],
    [],
    ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
    ['01/15/2025', 'Invoice', '1001', 'Acme Corp', 'Website design', 'Accounts Receivable (A/R)', 1250, ''],
    ['', '', '', '', 'Website design', 'Sales:Design Services', '', 1250],
    ['02/01/2025', 'Expense', '', 'Office Depot', 'Paper', 'Office Expenses:Supplies', 45.99, ''],
    ['', '', '', '', 'Paper', 'Checking', '', 45.99],
];

const GL_AOA: Aoa = [
    ['Craft Supply Co.'],
    ['General Ledger'],
    [],
    ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount', 'Balance'],
    ['Checking'],
    ['Beginning Balance', '', '', '', '', '', '', 1000],
    ['01/15/2025', 'Payment', '', 'Acme Corp', 'Invoice payment', 'Accounts Receivable', 1250, 2250],
    ['Total for Checking', '', '', '', '', '', 1250, ''],
    ['Accounts Receivable'],
    ['01/15/2025', 'Payment', '', 'Acme Corp', 'Invoice payment', 'Checking', -1250, -1250],
    ['Total for Accounts Receivable', '', '', '', '', '', -1250, ''],
];

const COA_CSV = [
    'Account name,Type,Detail type,Balance',
    'Checking,Bank,Checking,"5,000.00"',
    'Accounts Receivable,Accounts receivable (A/R),Accounts Receivable,0.00',
    'Sales:Design Services,Income,Service/Fee Income,0.00',
].join('\n');

/* ------------------------------------------------------------------ */
/* Sheet classification                                                 */
/* ------------------------------------------------------------------ */

describe('classifySheet', () => {
    it('classifies a Journal sheet (Date + Account + Debit + Credit)', () => {
        const rows = JOURNAL_AOA.map((r) => r.map(String));
        expect(classifySheet(rows)).toBe('journal');
    });

    it('classifies a General Ledger sheet (Date + Amount + Balance, no Debit/Credit)', () => {
        const rows = GL_AOA.map((r) => r.map(String));
        expect(classifySheet(rows)).toBe('general_ledger');
    });

    it('classifies a Chart of Accounts sheet (Account + Type, no Date)', () => {
        expect(classifySheet(splitCsvRows(COA_CSV))).toBe('chart_of_accounts');
    });

    it('returns unknown for anything else (e.g. a Balance Sheet report)', () => {
        expect(
            classifySheet([['Craft Supply Co.'], ['Balance Sheet'], [], ['', 'Total'], ['Assets', '5,000.00']])
        ).toBe('unknown');
    });

    it('prefers journal over general_ledger classification', () => {
        // Both header styles in one sheet (contrived): journal must win.
        const rows = [
            ['Date', 'Transaction Type', 'Num', 'Name', 'Memo', 'Split', 'Amount', 'Balance'],
            ['Date', 'Transaction Type', 'Num', 'Name', 'Memo', 'Account', 'Debit', 'Credit'],
        ];
        expect(classifySheet(rows)).toBe('journal');
    });
});

/* ------------------------------------------------------------------ */
/* XLSX ingestion                                                       */
/* ------------------------------------------------------------------ */

describe('sheetsFromUpload — xlsx', () => {
    it('reads every worksheet into string rows the Journal parser accepts', () => {
        const bytes = xlsxBytes([{ name: 'Journal', data: JOURNAL_AOA }]);
        const sheets = sheetsFromUpload('Journal.xlsx', bytes);
        expect(sheets).toHaveLength(1);
        expect(sheets[0].name).toBe('Journal');

        const result = parseQboJournalRows(sheets[0].rows);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
        expect(result.companyName).toBe('Craft Supply Co.');
        expect(result.transactions[0].lines[0].amount).toBe(1250);
        expect(result.transactions[1].lines.map((l) => l.amount)).toEqual([45.99, -45.99]);
    });

    it('names sheets "workbook — sheet" when a workbook has multiple sheets', () => {
        const bytes = xlsxBytes([
            { name: 'Journal', data: JOURNAL_AOA },
            { name: 'Account List', data: [['Account name', 'Type'], ['Checking', 'Bank']] },
        ]);
        const sheets = sheetsFromUpload('Export.xlsx', bytes);
        expect(sheets.map((s) => s.name)).toEqual(['Export — Journal', 'Export — Account List']);
        expect(classifySheet(sheets[0].rows)).toBe('journal');
        expect(classifySheet(sheets[1].rows)).toBe('chart_of_accounts');
    });

    it('serial-date guard: Date cells arrive as parseable date strings, never serial numbers', () => {
        const aoa: Aoa = [
            ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
            [new Date(2025, 0, 15), 'Deposit', '', '', '', 'Checking', 10, ''],
            ['', '', '', '', '', 'Interest Income', '', 10],
        ];
        const bytes = xlsxBytes([{ name: 'Journal', data: aoa }], true);
        const sheets = sheetsFromUpload('Journal.xlsx', bytes);
        const dateCell = sheets[0].rows[1][0];

        // 45672 is the Excel serial for 2025-01-15; it must never surface.
        expect(dateCell).not.toMatch(/^4\d{4}(\.\d+)?$/);

        const result = parseQboJournalRows(sheets[0].rows);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe('2025-01-15');
    });

    it('degrades gracefully for a non-workbook .xlsx: SheetJS falls back to text, classified unknown', () => {
        const sheets = sheetsFromUpload('bad.xlsx', u8('this is not a workbook'));
        for (const s of sheets) {
            expect(classifySheet(s.rows)).toBe('unknown');
        }
    });
});

/* ------------------------------------------------------------------ */
/* ZIP ingestion (QBO "Export data")                                    */
/* ------------------------------------------------------------------ */

describe('sheetsFromUpload — zip', () => {
    it('recurses into contained .xlsx and .csv entries and ignores other files', () => {
        const zip = zipSync({
            'reports/General Ledger.xlsx': xlsxBytes([{ name: 'General Ledger', data: GL_AOA }]),
            'lists/Account List.csv': u8(COA_CSV),
            'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            '__MACOSX/reports/._General Ledger.xlsx': u8('junk'),
        });
        const sheets = sheetsFromUpload('export.zip', zip);
        expect(sheets.map((s) => s.name).sort()).toEqual(['Account List', 'General Ledger']);

        const byKind = new Map(sheets.map((s) => [classifySheet(s.rows), s]));
        expect(byKind.has('general_ledger')).toBe(true);
        expect(byKind.has('chart_of_accounts')).toBe(true);

        const gl = parseQboGeneralLedgerRows(byKind.get('general_ledger')!.rows);
        expect(gl.transactions).toHaveLength(1);
        expect(gl.glStats).toEqual({ reconstructed: 1, failed: 0 });

        const coa = parseQboCoaRows(byKind.get('chart_of_accounts')!.rows);
        expect(coa.accounts).toHaveLength(3);
        expect(coa.accounts[0].gnucashType).toBe('BANK');
    });

    it('throws "Could not read" for a corrupt zip', () => {
        expect(() => sheetsFromUpload('bad.zip', u8('not a zip at all'))).toThrow(/could not read/i);
    });

    it('returns no sheets for a zip with no xlsx/csv entries', () => {
        const zip = zipSync({ 'readme.pdf': u8('pdf-ish') });
        expect(sheetsFromUpload('export.zip', zip)).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* CSV passthrough                                                      */
/* ------------------------------------------------------------------ */

describe('sheetsFromUpload — csv', () => {
    it('feeds CSV bytes through the existing splitter', () => {
        const sheets = sheetsFromUpload('ChartOfAccounts.csv', u8(COA_CSV));
        expect(sheets).toHaveLength(1);
        expect(sheets[0].name).toBe('ChartOfAccounts');
        expect(classifySheet(sheets[0].rows)).toBe('chart_of_accounts');
    });
});
