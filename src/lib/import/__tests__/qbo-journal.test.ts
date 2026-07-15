import { describe, it, expect } from 'vitest';
import {
    canonicalAccountPath,
    splitCsvRows,
    parseQboAmount,
    parseQboDate,
    parseQboJournalCsv,
    parseQboCoaCsv,
    mapQboTypeToGnucash,
    inferAccountTypeFromName,
    resolveAccountTypes,
    isValidGnucashType,
} from '../qbo-journal';

/* ------------------------------------------------------------------ */
/* CSV primitives                                                       */
/* ------------------------------------------------------------------ */

describe('splitCsvRows', () => {
    it('splits simple rows and trims fields', () => {
        const rows = splitCsvRows('a, b ,c\nd,e,f');
        expect(rows).toEqual([
            ['a', 'b', 'c'],
            ['d', 'e', 'f'],
        ]);
    });

    it('handles quoted fields with commas, escaped quotes, and newlines', () => {
        const rows = splitCsvRows('"1,250.00","He said ""hi""","line1\nline2"');
        expect(rows).toEqual([['1,250.00', 'He said "hi"', 'line1\nline2']]);
    });

    it('preserves blank rows so indices map to file row numbers', () => {
        const rows = splitCsvRows('a\n\nb');
        expect(rows).toHaveLength(3);
        expect(rows[1]).toEqual(['']);
    });

    it('handles CRLF line endings and a UTF-8 BOM', () => {
        const rows = splitCsvRows('﻿Date,Debit\r\n01/01/2025,5.00\r\n');
        expect(rows[0]).toEqual(['Date', 'Debit']);
        expect(rows[1]).toEqual(['01/01/2025', '5.00']);
    });
});

describe('canonicalAccountPath', () => {
    it('trims segments and drops empty ones', () => {
        expect(canonicalAccountPath('Parent : Sub')).toBe('Parent:Sub');
        expect(canonicalAccountPath('A:B:C')).toBe('A:B:C');
        expect(canonicalAccountPath(':A::B:')).toBe('A:B');
        expect(canonicalAccountPath('  Plain  ')).toBe('Plain');
    });
});

describe('parseQboAmount', () => {
    it('parses plain and comma-thousands amounts', () => {
        expect(parseQboAmount('45.99')).toBe(45.99);
        expect(parseQboAmount('1,250.00')).toBe(1250);
        expect(parseQboAmount('12,345,678.90')).toBe(12345678.9);
    });

    it('treats blank as zero', () => {
        expect(parseQboAmount('')).toBe(0);
        expect(parseQboAmount('  ')).toBe(0);
    });

    it('parses parentheses and leading minus as negative', () => {
        expect(parseQboAmount('(45.10)')).toBe(-45.1);
        expect(parseQboAmount('(1,000.00)')).toBe(-1000);
        expect(parseQboAmount('-12.5')).toBe(-12.5);
    });

    it('strips currency symbols', () => {
        expect(parseQboAmount('$3,000.00')).toBe(3000);
        expect(parseQboAmount('$ 42')).toBe(42);
    });

    it('returns null for unparseable text', () => {
        expect(parseQboAmount('abc')).toBeNull();
        expect(parseQboAmount('12abc')).toBe(12); // digits win over stray letters
        expect(parseQboAmount('N/A')).toBeNull();
    });
});

describe('parseQboDate', () => {
    it('parses US MM/DD/YYYY', () => {
        expect(parseQboDate('01/15/2025')).toBe('2025-01-15');
        expect(parseQboDate('1/5/2025')).toBe('2025-01-05');
        expect(parseQboDate('12/31/2024')).toBe('2024-12-31');
    });

    it('parses ISO YYYY-MM-DD', () => {
        expect(parseQboDate('2025-03-05')).toBe('2025-03-05');
        expect(parseQboDate('2025/03/05')).toBe('2025-03-05');
    });

    it('expands 2-digit years', () => {
        expect(parseQboDate('01/15/25')).toBe('2025-01-15');
        expect(parseQboDate('01/15/99')).toBe('1999-01-15');
    });

    it('rejects impossible dates', () => {
        expect(parseQboDate('13/45/2025')).toBeNull();
        expect(parseQboDate('02/29/2023')).toBeNull();
        expect(parseQboDate('02/29/2024')).toBe('2024-02-29');
        expect(parseQboDate('not a date')).toBeNull();
        expect(parseQboDate('')).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Journal parser                                                       */
/* ------------------------------------------------------------------ */

const STANDARD_JOURNAL = [
    'Craft Supply Co.', //                                                    row 1
    'Journal', //                                                             row 2
    '"January 1 - December 31, 2025"', //                                     row 3
    '', //                                                                    row 4
    'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit', // row 5
    '01/15/2025,Invoice,1001,Acme Corp,Website design,Accounts Receivable (A/R),"1,250.00",', // row 6
    ',,,,Website design,Sales:Design Services,,"1,250.00"', //                row 7
    ',,,,,,"1,250.00","1,250.00"', //                                         row 8 (txn total)
    '', //                                                                    row 9
    '02/01/2025,Expense,,Office Depot,Paper and toner,Office Expenses:Supplies,45.99,', // row 10
    ',,,,Paper and toner,Checking,,45.99', //                                 row 11
    ',,,,,,45.99,45.99', //                                                   row 12 (txn total)
    '', //                                                                    row 13
    ',,,,,,"1,295.99","1,295.99"', //                                         row 14 (grand total)
].join('\n');

describe('parseQboJournalCsv — standard export', () => {
    const result = parseQboJournalCsv(STANDARD_JOURNAL);

    it('extracts the company name from the preamble', () => {
        expect(result.companyName).toBe('Craft Supply Co.');
    });

    it('groups rows into transactions by non-empty Date', () => {
        expect(result.transactions).toHaveLength(2);
        expect(result.errors).toHaveLength(0);

        const [t1, t2] = result.transactions;
        expect(t1.date).toBe('2025-01-15');
        expect(t1.type).toBe('Invoice');
        expect(t1.num).toBe('1001');
        expect(t1.name).toBe('Acme Corp');
        expect(t1.startRow).toBe(6);
        expect(t1.lines).toHaveLength(2);

        expect(t2.date).toBe('2025-02-01');
        expect(t2.lines).toHaveLength(2);
    });

    it('applies the debit-positive / credit-negative sign convention', () => {
        const [t1] = result.transactions;
        expect(t1.lines[0]).toMatchObject({
            accountPath: 'Accounts Receivable (A/R)',
            amount: 1250,
        });
        expect(t1.lines[1]).toMatchObject({
            accountPath: 'Sales:Design Services',
            amount: -1250,
        });
    });

    it('skips per-transaction total rows and the grand total row', () => {
        const allLines = result.transactions.flatMap((t) => t.lines);
        expect(allLines).toHaveLength(4);
        expect(allLines.every((l) => l.accountPath !== '')).toBe(true);
    });

    it('collects distinct accounts and the date range', () => {
        expect(result.accountsSeen).toEqual([
            'Accounts Receivable (A/R)',
            'Checking',
            'Office Expenses:Supplies',
            'Sales:Design Services',
        ]);
        expect(result.dateRange).toEqual({ start: '2025-01-15', end: '2025-02-01' });
    });

    it('records line row numbers from the original file', () => {
        const [t1] = result.transactions;
        expect(t1.lines[0].row).toBe(6);
        expect(t1.lines[1].row).toBe(7);
    });
});

describe('parseQboJournalCsv — header and column variants', () => {
    it('accepts "Memo" instead of "Memo/Description" and captures Class/Location into split memos', () => {
        const csv = [
            'Date,Transaction Type,No.,Name,Memo,Account,Class,Location,Debit,Credit',
            '03/10/2025,Journal Entry,42,,Adjusting entry,Checking,Retail,East,100.00,',
            ',,,,Adjusting entry,Owner Equity,Retail,East,,100.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        const t = result.transactions[0];
        expect(t.num).toBe('42');
        expect(t.lines[0].memo).toBe('Adjusting entry | Class: Retail | Location: East');
    });

    it('handles a currency column and extra unknown columns', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Currency,Foo,Account,Debit,Credit',
            '04/01/2025,Payment,,Customer A,,USD,x,Undeposited Funds,500.00,',
            ',,,,,USD,x,Accounts Receivable (A/R),,500.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].lines[0].accountPath).toBe('Undeposited Funds');
    });

    it('parses ISO dates', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '2025-03-05,Deposit,,,,Checking,10.00,',
            ',,,,,Interest Income,,10.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions[0].date).toBe('2025-03-05');
    });

    it('reports a clear error when no header row is found', () => {
        const result = parseQboJournalCsv('just,some,random\ncontent,here,now');
        expect(result.transactions).toHaveLength(0);
        expect(result.errors[0].message).toMatch(/header row/i);
    });

    it('works with no preamble at all', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '05/05/2025,Check,101,Vendor,,Rent Expense,900.00,',
            ',,,,,Checking,,900.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.companyName).toBeNull();
    });
});

describe('parseQboJournalCsv — amounts and balance validation', () => {
    it('parses parentheses negatives and keeps the transaction balanced', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '06/01/2025,Credit Memo,,Acme,,Accounts Receivable (A/R),(50.00),',
            ',,,,,Sales,,(50.00)',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.errors).toHaveLength(0);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].lines[0].amount).toBe(-50);
        expect(result.transactions[0].lines[1].amount).toBe(50);
    });

    it('excludes imbalanced transactions and reports them with row numbers', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '06/01/2025,Journal Entry,,Bad Entry,,Checking,100.00,',
            ',,,,,Sales,,99.00',
            '06/02/2025,Journal Entry,,Good Entry,,Checking,10.00,',
            ',,,,,Sales,,10.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].name).toBe('Good Entry');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].row).toBe(2);
        expect(result.errors[0].message).toMatch(/does not balance/);
        expect(result.errors[0].message).toContain('1.00');
    });

    it('tolerates a one-cent rounding gap', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '06/01/2025,Journal Entry,,,,Checking,10.00,',
            ',,,,,Sales,,10.01',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.errors).toHaveLength(0);
    });

    it('rejects rows with unparseable amounts, poisoning only that transaction', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '06/01/2025,Journal Entry,,,,Checking,garbage,',
            ',,,,,Sales,,100.00',
            '06/02/2025,Journal Entry,,,,Checking,5.00,',
            ',,,,,Sales,,5.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe('2025-06-02');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toMatch(/amount/i);
    });

    it('reports unrecognized dates as errors', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            'bogus,Journal Entry,,,,Checking,5.00,',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(0);
        expect(result.errors[0].message).toMatch(/date/i);
    });
});

describe('parseQboJournalCsv — grouping edge cases', () => {
    it('handles multi-line transactions (more than two splits)', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '07/01/2025,Bill,88,Supplier,,Job Expenses:Materials,60.00,',
            ',,,,,Job Expenses:Freight,15.00,',
            ',,,,,Accounts Payable (A/P),,75.00',
            ',,,,,,75.00,75.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].lines).toHaveLength(3);
        expect(result.transactions[0].lines.map((l) => l.amount)).toEqual([60, 15, -75]);
    });

    it('backfills Name/Memo from continuation rows when the first row is blank', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '07/01/2025,Payment,,,,Checking,200.00,',
            ',,,Late Customer,Payment received,Accounts Receivable (A/R),,200.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions[0].name).toBe('Late Customer');
        expect(result.transactions[0].memo).toBe('Payment received');
    });

    it('skips "Total ..." label rows in the account column', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '07/01/2025,Invoice,,X,,Accounts Receivable (A/R),20.00,',
            ',,,,,Sales,,20.00',
            ',,,,,Total for Invoice,20.00,20.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions[0].lines).toHaveLength(2);
    });

    it('ignores continuation rows before any transaction and preserves colon paths', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            ',,,,,Orphan Row,5.00,',
            '07/02/2025,Expense,,,,Utilities:Gas & Electric,30.00,',
            ',,,,,Checking,,30.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.accountsSeen).toContain('Utilities:Gas & Electric');
        expect(result.accountsSeen).not.toContain('Orphan Row');
    });

    it('canonicalizes colon paths (spaces around segment separators)', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '07/05/2025,Expense,,,,Utilities : Gas & Electric,30.00,',
            ',,,,,Checking,,30.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions[0].lines[0].accountPath).toBe('Utilities:Gas & Electric');
        expect(result.accountsSeen).toContain('Utilities:Gas & Electric');
    });

    it('drops date rows that contribute no account lines (report artifacts)', () => {
        const csv = [
            'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
            '07/03/2025,,,,,,,',
            '07/04/2025,Expense,,,,Supplies,1.00,',
            ',,,,,Checking,,1.00',
        ].join('\n');
        const result = parseQboJournalCsv(csv);
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe('2025-07-04');
        expect(result.errors).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ */
/* Chart of Accounts parser                                             */
/* ------------------------------------------------------------------ */

describe('mapQboTypeToGnucash', () => {
    const cases: Array<[string, string]> = [
        ['Bank', 'BANK'],
        ['Accounts receivable (A/R)', 'RECEIVABLE'],
        ['Accounts Receivable', 'RECEIVABLE'],
        ['Other Current Assets', 'ASSET'],
        ['Other Assets', 'ASSET'],
        ['Fixed Assets', 'ASSET'],
        ['Accounts payable (A/P)', 'PAYABLE'],
        ['Accounts Payable', 'PAYABLE'],
        ['Credit Card', 'CREDIT'],
        ['Other Current Liabilities', 'LIABILITY'],
        ['Long Term Liabilities', 'LIABILITY'],
        ['Long-Term Liabilities', 'LIABILITY'],
        ['Equity', 'EQUITY'],
        ['Income', 'INCOME'],
        ['Other Income', 'INCOME'],
        ['Cost of Goods Sold', 'EXPENSE'],
        ['Expenses', 'EXPENSE'],
        ['Other Expense', 'EXPENSE'],
    ];
    it.each(cases)('%s → %s', (qbo, gnucash) => {
        expect(mapQboTypeToGnucash(qbo)).toBe(gnucash);
    });

    it('returns null for unknown types', () => {
        expect(mapQboTypeToGnucash('Frobnicator')).toBeNull();
        expect(mapQboTypeToGnucash('')).toBeNull();
    });
});

const STANDARD_COA = [
    'Craft Supply Co.',
    'Chart of Accounts',
    '',
    'Full name,Type,Detail type,Balance',
    'Business Checking,Bank,Checking,"5,000.00"',
    'Accounts Receivable (A/R),Accounts receivable (A/R),Accounts Receivable,"1,250.00"',
    'Machinery,Fixed Assets,Machinery & Equipment,0.00',
    'Visa,Credit Card,Credit Card,(300.00)',
    'Payroll Liabilities,Other Current Liabilities,Payroll Tax Payable,0.00',
    'Owner Equity,Equity,Owner\'s Equity,0.00',
    'Sales:Design Services,Income,Service/Fee Income,0.00',
    'Job Materials,Cost of Goods Sold,Supplies & Materials - COGS,0.00',
    'Office Expenses:Supplies,Expenses,Office/General Administrative Expenses,0.00',
    'Weird Account,Frobnicator,Unknown,0.00',
].join('\n');

describe('parseQboCoaCsv', () => {
    const result = parseQboCoaCsv(STANDARD_COA);

    it('finds the header after preamble rows and parses every account', () => {
        expect(result.accounts).toHaveLength(10);
        expect(result.errors).toHaveLength(0);
    });

    it('maps QBO types to GnuCash types', () => {
        const byName = new Map(result.accounts.map((a) => [a.fullName, a]));
        expect(byName.get('Business Checking')?.gnucashType).toBe('BANK');
        expect(byName.get('Accounts Receivable (A/R)')?.gnucashType).toBe('RECEIVABLE');
        expect(byName.get('Machinery')?.gnucashType).toBe('ASSET');
        expect(byName.get('Visa')?.gnucashType).toBe('CREDIT');
        expect(byName.get('Payroll Liabilities')?.gnucashType).toBe('LIABILITY');
        expect(byName.get('Owner Equity')?.gnucashType).toBe('EQUITY');
        expect(byName.get('Sales:Design Services')?.gnucashType).toBe('INCOME');
        expect(byName.get('Job Materials')?.gnucashType).toBe('EXPENSE');
        expect(byName.get('Office Expenses:Supplies')?.gnucashType).toBe('EXPENSE');
    });

    it('flags unknown QBO types with a warning and a null mapping', () => {
        const weird = result.accounts.find((a) => a.fullName === 'Weird Account');
        expect(weird?.gnucashType).toBeNull();
        expect(result.warnings.some((w) => w.includes('Frobnicator'))).toBe(true);
    });

    it('captures the detail type', () => {
        const checking = result.accounts.find((a) => a.fullName === 'Business Checking');
        expect(checking?.detailType).toBe('Checking');
    });

    it('accepts "Account name"/"Account type" header variants and skips Total rows', () => {
        const csv = [
            'Account name,Account type,Detail type',
            'Checking,Bank,Checking',
            'Total Bank,Bank,',
        ].join('\n');
        const r = parseQboCoaCsv(csv);
        expect(r.accounts).toHaveLength(1);
        expect(r.accounts[0].fullName).toBe('Checking');
    });

    it('reports an error when the header cannot be found', () => {
        const r = parseQboCoaCsv('nope\nnothing,useful');
        expect(r.accounts).toHaveLength(0);
        expect(r.errors[0].message).toMatch(/header row/i);
    });
});

/* ------------------------------------------------------------------ */
/* Type inference + resolution                                          */
/* ------------------------------------------------------------------ */

describe('inferAccountTypeFromName', () => {
    const cases: Array<[string, string | null]> = [
        ['Business Checking', 'BANK'],
        ['Savings', 'BANK'],
        ['Petty Cash', 'BANK'],
        ['Accounts Receivable', 'RECEIVABLE'],
        ['Sales Tax Payable', 'PAYABLE'],
        ['Chase Credit Card', 'CREDIT'],
        ['Equipment Loan', 'LIABILITY'],
        ['Long Term Liabilities:SBA Loan', 'LIABILITY'],
        ['Consulting Income', 'INCOME'],
        ['Sales', 'INCOME'],
        ['Revenue:Product', 'INCOME'],
        ['Office Expenses', 'EXPENSE'],
        ['Cost of Goods Sold', 'EXPENSE'],
        ['Bank Fees', 'EXPENSE'], // fee wins over the generic "bank" keyword
        ['Retained Earnings', 'EQUITY'],
        ['Opening Balance Equity', 'EQUITY'],
        ["Owner's Draw", 'EQUITY'],
        ['Miscellaneous', null],
    ];
    it.each(cases)('%s → %s', (name, expected) => {
        expect(inferAccountTypeFromName(name)).toBe(expected);
    });
});

describe('resolveAccountTypes', () => {
    const coa = parseQboCoaCsv(STANDARD_COA);

    it('uses CoA full-path matches (case-insensitive), source "coa"', () => {
        const [r] = resolveAccountTypes(['business checking'], coa);
        expect(r).toEqual({ path: 'business checking', gnucashType: 'BANK', source: 'coa' });
    });

    it('falls back to unambiguous CoA leaf-name matches', () => {
        // Journal shows the full path, CoA exported only the leaf name.
        const [r] = resolveAccountTypes(['Job Expenses:Job Materials'], coa);
        expect(r.gnucashType).toBe('EXPENSE');
        expect(r.source).toBe('coa');
    });

    it('defaults unknown CoA types to ASSET', () => {
        const [r] = resolveAccountTypes(['Weird Account'], coa);
        expect(r).toMatchObject({ gnucashType: 'ASSET', source: 'coa' });
    });

    it('infers from name keywords when the account is missing from the CoA', () => {
        const [r] = resolveAccountTypes(['Consulting Income'], coa);
        expect(r).toMatchObject({ gnucashType: 'INCOME', source: 'inferred' });
    });

    it('defaults to ASSET when nothing matches', () => {
        const [r] = resolveAccountTypes(['Miscellaneous'], coa);
        expect(r).toMatchObject({ gnucashType: 'ASSET', source: 'default' });
    });

    it('lets explicit overrides win over everything', () => {
        const [r] = resolveAccountTypes(['Business Checking'], coa, {
            'Business Checking': 'CASH',
        });
        expect(r).toMatchObject({ gnucashType: 'CASH', source: 'override' });
    });

    it('ignores overrides with invalid GnuCash types', () => {
        const [r] = resolveAccountTypes(['Business Checking'], coa, {
            'Business Checking': 'NOT_A_TYPE',
        });
        expect(r).toMatchObject({ gnucashType: 'BANK', source: 'coa' });
    });

    it('works without a CoA at all (inference + default)', () => {
        const resolved = resolveAccountTypes(['Checking', 'Rent Expense', 'Mystery'], null);
        expect(resolved.map((r) => r.gnucashType)).toEqual(['BANK', 'EXPENSE', 'ASSET']);
        expect(resolved.map((r) => r.source)).toEqual(['inferred', 'inferred', 'default']);
    });
});

describe('isValidGnucashType', () => {
    it('accepts the standard types and rejects junk', () => {
        expect(isValidGnucashType('BANK')).toBe(true);
        expect(isValidGnucashType('EXPENSE')).toBe(true);
        expect(isValidGnucashType('ROOT')).toBe(false);
        expect(isValidGnucashType('bank')).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* End-to-end shape                                                     */
/* ------------------------------------------------------------------ */

describe('journal + CoA together', () => {
    it('resolves every journal account with the expected sources', () => {
        const journal = parseQboJournalCsv(STANDARD_JOURNAL);
        const coa = parseQboCoaCsv(STANDARD_COA);
        const resolved = resolveAccountTypes(journal.accountsSeen, coa);

        const byPath = new Map(resolved.map((r) => [r.path, r]));
        expect(byPath.get('Accounts Receivable (A/R)')).toMatchObject({
            gnucashType: 'RECEIVABLE',
            source: 'coa',
        });
        expect(byPath.get('Sales:Design Services')).toMatchObject({
            gnucashType: 'INCOME',
            source: 'coa',
        });
        expect(byPath.get('Office Expenses:Supplies')).toMatchObject({
            gnucashType: 'EXPENSE',
            source: 'coa',
        });
        // "Checking" is not in the CoA under that exact name → leaf match fails
        // ("Business Checking" leaf is "business checking") → inference kicks in.
        expect(byPath.get('Checking')).toMatchObject({
            gnucashType: 'BANK',
            source: 'inferred',
        });
    });
});
