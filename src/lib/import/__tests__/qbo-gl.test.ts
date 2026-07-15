import { describe, it, expect } from 'vitest';
import { detectGlHeader, parseQboGeneralLedgerRows } from '../qbo-gl';

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const GL_HEADER = ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount', 'Balance'];

/** Standard QBO General Ledger layout: preamble, sections, totals. */
const STANDARD_GL: string[][] = [
    ['Craft Supply Co.'], //                                              row 1
    ['General Ledger'], //                                                row 2
    ['January 1 - December 31, 2025'], //                                 row 3
    [], //                                                                row 4
    GL_HEADER, //                                                         row 5
    ['Checking'], //                                                      row 6 (section)
    ['Beginning Balance', '', '', '', '', '', '', '1,000.00'], //         row 7
    ['01/15/2025', 'Payment', '', 'Acme Corp', 'Invoice payment', 'Accounts Receivable', '1,250.00', '2,250.00'], // row 8
    ['02/01/2025', 'Expense', '', 'Office Depot', 'Paper', 'Supplies', '-45.99', '2,204.01'], // row 9
    ['Total for Checking', '', '', '', '', '', '1,204.01', ''], //        row 10
    ['Accounts Receivable'], //                                           row 11 (section)
    ['01/15/2025', 'Payment', '', 'Acme Corp', 'Invoice payment', 'Checking', '-1,250.00', '-1,250.00'], // row 12
    ['Total for Accounts Receivable', '', '', '', '', '', '-1,250.00', ''], // row 13
    ['Office Expenses'], //                                               row 14 (parent section)
    ['Supplies'], //                                                      row 15 (nested sub-account section)
    ['02/01/2025', 'Expense', '', 'Office Depot', 'Paper', 'Checking', '45.99', '45.99'], // row 16
    ['Total for Supplies', '', '', '', '', '', '45.99', ''], //           row 17
    ['Total for Office Expenses', '', '', '', '', '', '45.99', ''], //    row 18
];

/* ------------------------------------------------------------------ */
/* Header detection                                                     */
/* ------------------------------------------------------------------ */

describe('detectGlHeader', () => {
    it('detects Date + Amount + Balance without Debit/Credit', () => {
        const cols = detectGlHeader(GL_HEADER);
        expect(cols).not.toBeNull();
        expect(cols!.date).toBe(0);
        expect(cols!.amount).toBe(6);
        expect(cols!.balance).toBe(7);
        expect(cols!.split).toBe(5);
    });

    it('rejects Journal headers (Debit/Credit present)', () => {
        expect(
            detectGlHeader(['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'])
        ).toBeNull();
    });

    it('rejects Chart of Accounts headers (no Date/Amount)', () => {
        expect(detectGlHeader(['Full name', 'Type', 'Detail type', 'Balance'])).toBeNull();
    });

    it('tolerates a leading blank column', () => {
        const cols = detectGlHeader(['', ...GL_HEADER]);
        expect(cols).not.toBeNull();
        expect(cols!.date).toBe(1);
    });
});

/* ------------------------------------------------------------------ */
/* Reconstruction                                                       */
/* ------------------------------------------------------------------ */

describe('parseQboGeneralLedgerRows — standard export', () => {
    const result = parseQboGeneralLedgerRows(STANDARD_GL);

    it('extracts the company name from the preamble', () => {
        expect(result.companyName).toBe('Craft Supply Co.');
    });

    it('reconstructs double-entry transactions by grouping across accounts', () => {
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
        expect(result.glStats).toEqual({ reconstructed: 2, failed: 0 });

        const [t1, t2] = result.transactions;
        expect(t1.date).toBe('2025-01-15');
        expect(t1.type).toBe('Payment');
        expect(t1.name).toBe('Acme Corp');
        expect(t1.lines).toHaveLength(2);
        const t1Accounts = new Map(t1.lines.map((l) => [l.accountPath, l.amount]));
        expect(t1Accounts.get('Checking')).toBe(1250);
        expect(t1Accounts.get('Accounts Receivable')).toBe(-1250);

        expect(t2.date).toBe('2025-02-01');
        const t2Accounts = new Map(t2.lines.map((l) => [l.accountPath, l.amount]));
        expect(t2Accounts.get('Checking')).toBe(-45.99);
        expect(t2Accounts.get('Office Expenses:Supplies')).toBe(45.99);
    });

    it('builds colon paths for nested account sections', () => {
        expect(result.accountsSeen).toEqual(['Accounts Receivable', 'Checking', 'Office Expenses:Supplies']);
    });

    it('skips Beginning Balance and Total rows', () => {
        const allRows = result.transactions.flatMap((t) => t.lines.map((l) => l.row));
        expect(allRows.sort((a, b) => a - b)).toEqual([8, 9, 12, 16]);
    });

    it('every reconstructed transaction balances to zero', () => {
        for (const t of result.transactions) {
            const sum = t.lines.reduce((s, l) => s + l.amount, 0);
            expect(Math.abs(sum)).toBeLessThanOrEqual(0.01);
        }
    });

    it('computes the date range', () => {
        expect(result.dateRange).toEqual({ start: '2025-01-15', end: '2025-02-01' });
    });
});

describe('parseQboGeneralLedgerRows — grouping semantics', () => {
    it('merges same-key distinct transactions that balance combined (documented dedupe semantics)', () => {
        // Two $50 cash sales on the same day with identical type/num/name are
        // indistinguishable in a GL export: they balance individually AND
        // combined. The chosen semantics (see qbo-gl.ts header comment) is to
        // emit ONE combined transaction — per-account totals stay correct,
        // only the transaction count undercounts.
        const rows: string[][] = [
            GL_HEADER,
            ['Cash'],
            ['03/01/2025', 'Sales Receipt', '', '', 'Daily sales', 'Sales', '50.00', '50.00'],
            ['03/01/2025', 'Sales Receipt', '', '', 'Daily sales', 'Sales', '50.00', '100.00'],
            ['Total for Cash', '', '', '', '', '', '100.00', ''],
            ['Sales'],
            ['03/01/2025', 'Sales Receipt', '', '', 'Daily sales', 'Cash', '-50.00', '-50.00'],
            ['03/01/2025', 'Sales Receipt', '', '', 'Daily sales', 'Cash', '-50.00', '-100.00'],
            ['Total for Sales', '', '', '', '', '', '-100.00', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].lines).toHaveLength(4);
        const sum = result.transactions[0].lines.reduce((s, l) => s + l.amount, 0);
        expect(Math.abs(sum)).toBeLessThanOrEqual(0.01);
        expect(result.glStats).toEqual({ reconstructed: 1, failed: 0 });
    });

    it('keeps different names/nums on the same day as separate transactions', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['Checking'],
            ['03/02/2025', 'Check', '101', 'Vendor A', '', 'Rent', '-900.00', '-900.00'],
            ['03/02/2025', 'Check', '102', 'Vendor B', '', 'Rent', '-100.00', '-1,000.00'],
            ['Total for Checking', '', '', '', '', '', '-1,000.00', ''],
            ['Rent'],
            ['03/02/2025', 'Check', '101', 'Vendor A', '', 'Checking', '900.00', '900.00'],
            ['03/02/2025', 'Check', '102', 'Vendor B', '', 'Checking', '100.00', '1,000.00'],
            ['Total for Rent', '', '', '', '', '', '1,000.00', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(2);
        expect(result.glStats.reconstructed).toBe(2);
    });

    it('falls back to memo in the group key when the name is blank', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['Checking'],
            ['03/03/2025', 'Deposit', '', '', 'Memo A', '', '10.00', '10.00'],
            ['03/03/2025', 'Deposit', '', '', 'Memo B', '', '20.00', '30.00'],
            ['Total for Checking', '', '', '', '', '', '30.00', ''],
            ['Interest Income'],
            ['03/03/2025', 'Deposit', '', '', 'Memo A', '', '-10.00', '-10.00'],
            ['03/03/2025', 'Deposit', '', '', 'Memo B', '', '-20.00', '-30.00'],
            ['Total for Interest Income', '', '', '', '', '', '-30.00', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(2);
        expect(result.errors).toEqual([]);
    });
});

describe('parseQboGeneralLedgerRows — unbalanced groups', () => {
    it('emits a row-numbered error suggesting the Journal report', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['Checking'],
            ['03/05/2025', 'Transfer', '', 'One Sided', '', '', '100.00', '100.00'],
            ['Total for Checking', '', '', '', '', '', '100.00', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(0);
        expect(result.glStats).toEqual({ reconstructed: 0, failed: 1 });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].row).toBe(3);
        expect(result.errors[0].message).toMatch(/could not reconstruct/i);
        expect(result.errors[0].message).toMatch(/journal report/i);
    });

    it('salvages the trivial subset: exactly one opposite-amount pair', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['Checking'],
            ['03/06/2025', 'Journal Entry', '7', 'Mixed', '', '', '100.00', '100.00'],
            ['03/06/2025', 'Journal Entry', '7', 'Mixed', '', '', '33.00', '133.00'],
            ['Total for Checking', '', '', '', '', '', '133.00', ''],
            ['Sales'],
            ['03/06/2025', 'Journal Entry', '7', 'Mixed', '', '', '-100.00', '-100.00'],
            ['Total for Sales', '', '', '', '', '', '-100.00', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(1);
        const accounts = new Map(result.transactions[0].lines.map((l) => [l.accountPath, l.amount]));
        expect(accounts.get('Checking')).toBe(100);
        expect(accounts.get('Sales')).toBe(-100);
        expect(result.glStats).toEqual({ reconstructed: 1, failed: 1 });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('rows 4');
    });

    it('does NOT subset-match when multiple opposite pairs are possible (ambiguous)', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['Checking'],
            ['03/07/2025', 'Journal Entry', '8', 'Ambiguous', '', '', '100.00', '100.00'],
            ['03/07/2025', 'Journal Entry', '8', 'Ambiguous', '', '', '100.00', '200.00'],
            ['Total for Checking', '', '', '', '', '', '200.00', ''],
            ['Sales'],
            ['03/07/2025', 'Journal Entry', '8', 'Ambiguous', '', '', '-100.00', '-100.00'],
            ['Total for Sales', '', '', '', '', '', '-100.00', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(0);
        expect(result.glStats).toEqual({ reconstructed: 0, failed: 1 });
        expect(result.errors).toHaveLength(1);
    });
});

describe('parseQboGeneralLedgerRows — structure edge cases', () => {
    it('reports a clear error when the header row is missing', () => {
        const result = parseQboGeneralLedgerRows([['nothing'], ['useful', 'here']]);
        expect(result.transactions).toHaveLength(0);
        expect(result.errors[0].message).toMatch(/general ledger header/i);
    });

    it('skips transaction rows that appear before any account section', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['03/08/2025', 'Deposit', '', '', '', '', '10.00', '10.00'],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(0);
        expect(result.errors[0].message).toMatch(/before any account section/i);
    });

    it('reports unparseable amounts with the account path', () => {
        const rows: string[][] = [
            GL_HEADER,
            ['Checking'],
            ['03/09/2025', 'Deposit', '', '', '', '', 'garbage', ''],
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.errors[0].message).toContain('garbage');
        expect(result.errors[0].message).toContain('Checking');
    });

    it('handles a leading blank column (common in XLSX report exports)', () => {
        const pad = (r: string[]) => ['', ...r];
        const rows: string[][] = [
            pad(GL_HEADER),
            pad(['Checking']),
            pad(['03/10/2025', 'Deposit', '', 'Payer', '', '', '10.00', '10.00']),
            pad(['Total for Checking', '', '', '', '', '', '10.00', '']),
            pad(['Interest Income']),
            pad(['03/10/2025', 'Deposit', '', 'Payer', '', '', '-10.00', '-10.00']),
            pad(['Total for Interest Income', '', '', '', '', '', '-10.00', '']),
        ];
        const result = parseQboGeneralLedgerRows(rows);
        expect(result.transactions).toHaveLength(1);
        expect(result.accountsSeen).toEqual(['Checking', 'Interest Income']);
    });
});
