import { describe, it, expect } from 'vitest';
import {
    parseWaveTransactionsCsv,
    parseWaveCoaCsv,
    mapWaveTypeToGnucash,
} from '../wave';
import {
    parseXeroJournalCsv,
    parseXeroCoaCsv,
    mapXeroTypeToGnucash,
    stripXeroAccountCode,
} from '../xero';
import { resolveAccountTypes } from '../qbo-journal';
import { IMPORT_LOCALES } from '../parse-locale';

/* ------------------------------------------------------------------ */
/* Wave — transactions                                                  */
/* ------------------------------------------------------------------ */

const WAVE_TWO_COL_HEADER =
    'Transaction ID,Transaction Date,Account Name,Transaction Description,Transaction Line Description,Debit Amount (Two Column Approach),Credit Amount (Two Column Approach)';

describe('parseWaveTransactionsCsv', () => {
    it('groups rows by Transaction ID with two-column amounts (debit positive)', () => {
        const csv = [
            WAVE_TWO_COL_HEADER,
            'T1,2025-01-15,Cash on Hand,Client payment,Deposit,500.00,',
            'T1,2025-01-15,Sales,Client payment,Invoice 12,,500.00',
            'T2,2025-01-16,Office Supplies,Staples run,Paper,42.10,',
            'T2,2025-01-16,Cash on Hand,Staples run,,,42.10',
        ].join('\n');
        const result = parseWaveTransactionsCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
        const [t1, t2] = result.transactions;
        expect(t1).toMatchObject({ date: '2025-01-15', num: 'T1', memo: 'Client payment' });
        expect(t1.lines).toEqual([
            expect.objectContaining({ accountPath: 'Cash on Hand', amount: 500, memo: 'Deposit' }),
            expect.objectContaining({ accountPath: 'Sales', amount: -500, memo: 'Invoice 12' }),
        ]);
        expect(t2.lines.map((l) => l.amount)).toEqual([42.1, -42.1]);
        expect(result.accountsSeen).toEqual(['Cash on Hand', 'Office Supplies', 'Sales']);
        expect(result.dateRange).toEqual({ start: '2025-01-15', end: '2025-01-16' });
    });

    it('groups non-adjacent rows sharing a Transaction ID', () => {
        const csv = [
            WAVE_TWO_COL_HEADER,
            'T1,2025-01-15,Cash on Hand,Payment,,100.00,',
            'T2,2025-01-15,Cash on Hand,Other,,25.00,',
            'T2,2025-01-15,Sales,Other,,,25.00',
            'T1,2025-01-15,Sales,Payment,,,100.00',
        ].join('\n');
        const result = parseWaveTransactionsCsv(csv);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
    });

    it('falls back to consecutive date+description grouping without an ID column', () => {
        const csv = [
            'Transaction Date,Account Name,Transaction Description,Transaction Line Description,Amount (One column)',
            '2025-01-15,Cash on Hand,Client payment,,500.00',
            '2025-01-15,Sales,Client payment,,-500.00',
            '2025-01-15,Office Supplies,Staples run,,42.10',
            '2025-01-15,Cash on Hand,Staples run,,-42.10',
        ].join('\n');
        const result = parseWaveTransactionsCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
        expect(result.warnings.some((w) => w.includes('grouped by date and description'))).toBe(true);
    });

    it('honors a debit/credit indicator column on unsigned amounts', () => {
        const csv = [
            'Transaction ID,Transaction Date,Account Name,Transaction Description,Amount,Debit Or Credit',
            'T1,2025-01-15,Cash on Hand,Payment,500.00,debit',
            'T1,2025-01-15,Sales,Payment,500.00,credit',
        ].join('\n');
        const result = parseWaveTransactionsCsv(csv);
        expect(result.errors).toEqual([]);
        expect(result.transactions[0].lines.map((l) => l.amount)).toEqual([500, -500]);
    });

    it('rejects unbalanced groups with row numbers', () => {
        const csv = [
            WAVE_TWO_COL_HEADER,
            'T1,2025-01-15,Cash on Hand,Broken,,500.00,',
            'T1,2025-01-15,Sales,Broken,,,400.00',
        ].join('\n');
        const result = parseWaveTransactionsCsv(csv);
        expect(result.transactions).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('does not balance');
        expect(result.errors[0].message).toContain('rows 2, 3');
    });

    it('parses EU locale amounts and dates', () => {
        const csv = [
            WAVE_TWO_COL_HEADER,
            'T1,15/01/2025,Cash on Hand,Sale,,"1.234,56",',
            'T1,15/01/2025,Sales,Sale,,,"1.234,56"',
        ].join('\n');
        const result = parseWaveTransactionsCsv(csv, IMPORT_LOCALES.eu);
        expect(result.errors).toEqual([]);
        expect(result.transactions[0].date).toBe('2025-01-15');
        expect(result.transactions[0].lines[0].amount).toBe(1234.56);
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseWaveTransactionsCsv('a,b\n1,2');
        expect(result.transactions).toEqual([]);
        expect(result.errors[0].message).toContain('Wave transactions header');
    });
});

/* ------------------------------------------------------------------ */
/* Wave — Chart of Accounts + type mapping                              */
/* ------------------------------------------------------------------ */

describe('mapWaveTypeToGnucash', () => {
    it('maps the documented Wave types', () => {
        expect(mapWaveTypeToGnucash('Cash and Bank')).toBe('BANK');
        expect(mapWaveTypeToGnucash('Expected Payments from Customers')).toBe('RECEIVABLE');
        expect(mapWaveTypeToGnucash('Expected Payments to Vendors')).toBe('PAYABLE');
        expect(mapWaveTypeToGnucash('Credit Card')).toBe('CREDIT');
        expect(mapWaveTypeToGnucash('Money in Transit')).toBe('ASSET');
        expect(mapWaveTypeToGnucash('Inventory')).toBe('ASSET');
        expect(mapWaveTypeToGnucash('Loan and Line of Credit')).toBe('LIABILITY');
        expect(mapWaveTypeToGnucash('Sales Taxes')).toBe('LIABILITY');
        expect(mapWaveTypeToGnucash('Due to You and Other Business Owners')).toBe('LIABILITY');
        expect(mapWaveTypeToGnucash('Business Owner Contribution and Drawing')).toBe('EQUITY');
        expect(mapWaveTypeToGnucash('Retained Earnings: Profit')).toBe('EQUITY');
        expect(mapWaveTypeToGnucash('Income')).toBe('INCOME');
        expect(mapWaveTypeToGnucash('Discount')).toBe('INCOME');
        expect(mapWaveTypeToGnucash('Uncategorized Income')).toBe('INCOME');
        expect(mapWaveTypeToGnucash('Operating Expense')).toBe('EXPENSE');
        expect(mapWaveTypeToGnucash('Cost of Goods Sold')).toBe('EXPENSE');
        expect(mapWaveTypeToGnucash('Payment Processing Fee')).toBe('EXPENSE');
        expect(mapWaveTypeToGnucash('Bogus Type')).toBeNull();
    });
});

describe('parseWaveCoaCsv', () => {
    it('parses accounts and maps types', () => {
        const csv = [
            'Account Name,Account Type,Description',
            'Cash on Hand,Cash and Bank,',
            'Sales,Income,',
            'Office Supplies,Operating Expense,',
            'Weird,Nonsense Type,',
        ].join('\n');
        const coa = parseWaveCoaCsv(csv);
        expect(coa.accounts).toHaveLength(4);
        expect(coa.accounts[0]).toMatchObject({ fullName: 'Cash on Hand', gnucashType: 'BANK' });
        expect(coa.accounts[3].gnucashType).toBeNull();
        expect(coa.warnings[0]).toContain('Nonsense Type');
    });

    it('merges with journal accounts through resolveAccountTypes', () => {
        const coaCsv = ['Account Name,Account Type', 'Cash on Hand,Cash and Bank', 'Sales,Income'].join('\n');
        const coa = parseWaveCoaCsv(coaCsv);
        const resolved = resolveAccountTypes(['Cash on Hand', 'Sales', 'Mystery Account'], coa);
        expect(resolved).toEqual([
            { path: 'Cash on Hand', gnucashType: 'BANK', source: 'coa' },
            { path: 'Sales', gnucashType: 'INCOME', source: 'coa' },
            { path: 'Mystery Account', gnucashType: 'ASSET', source: 'default' },
        ]);
    });
});

/* ------------------------------------------------------------------ */
/* Xero — type mapping                                                  */
/* ------------------------------------------------------------------ */

describe('mapXeroTypeToGnucash', () => {
    it('maps Xero type codes per the documented table', () => {
        expect(mapXeroTypeToGnucash('BANK')).toBe('BANK');
        expect(mapXeroTypeToGnucash('CURRENT')).toBe('ASSET');
        expect(mapXeroTypeToGnucash('FIXED')).toBe('ASSET');
        expect(mapXeroTypeToGnucash('INVENTORY')).toBe('ASSET');
        expect(mapXeroTypeToGnucash('PREPAYMENT')).toBe('ASSET');
        expect(mapXeroTypeToGnucash('CURRLIAB')).toBe('LIABILITY');
        expect(mapXeroTypeToGnucash('TERMLIAB')).toBe('LIABILITY');
        expect(mapXeroTypeToGnucash('LIABILITY')).toBe('LIABILITY');
        expect(mapXeroTypeToGnucash('EQUITY')).toBe('EQUITY');
        expect(mapXeroTypeToGnucash('REVENUE')).toBe('INCOME');
        expect(mapXeroTypeToGnucash('SALES')).toBe('INCOME');
        expect(mapXeroTypeToGnucash('OTHERINCOME')).toBe('INCOME');
        expect(mapXeroTypeToGnucash('EXPENSE')).toBe('EXPENSE');
        expect(mapXeroTypeToGnucash('OVERHEADS')).toBe('EXPENSE');
        expect(mapXeroTypeToGnucash('DIRECTCOSTS')).toBe('EXPENSE');
        expect(mapXeroTypeToGnucash('DEPRECIATN')).toBe('EXPENSE');
        expect(mapXeroTypeToGnucash('WHATEVER')).toBeNull();
    });

    it('maps human-readable labels too', () => {
        expect(mapXeroTypeToGnucash('Current Asset')).toBe('ASSET');
        expect(mapXeroTypeToGnucash('Current Liability')).toBe('LIABILITY');
        expect(mapXeroTypeToGnucash('Direct Costs')).toBe('EXPENSE');
    });

    it('refines system accounts to RECEIVABLE / PAYABLE / CREDIT by name', () => {
        expect(mapXeroTypeToGnucash('CURRENT', 'Accounts Receivable')).toBe('RECEIVABLE');
        expect(mapXeroTypeToGnucash('CURRLIAB', 'Accounts Payable')).toBe('PAYABLE');
        expect(mapXeroTypeToGnucash('CURRLIAB', 'Company Credit Card')).toBe('CREDIT');
        expect(mapXeroTypeToGnucash('CURRENT', 'Prepayments')).toBe('ASSET');
    });
});

describe('stripXeroAccountCode', () => {
    it('strips a leading numeric code', () => {
        expect(stripXeroAccountCode('200 - Sales')).toBe('Sales');
        expect(stripXeroAccountCode('090 - Business Bank Account')).toBe('Business Bank Account');
        expect(stripXeroAccountCode('Sales')).toBe('Sales');
        expect(stripXeroAccountCode('24 Hour Towing')).toBe('24 Hour Towing');
    });
});

/* ------------------------------------------------------------------ */
/* Xero — Chart of Accounts                                             */
/* ------------------------------------------------------------------ */

describe('parseXeroCoaCsv', () => {
    it('parses Code, Name, Type', () => {
        const csv = [
            'Code,Name,Type,Tax Code',
            '090,Business Bank Account,BANK,None',
            '200,Sales,REVENUE,Tax on Sales',
            '610,Accounts Receivable,CURRENT,None',
            '800,Accounts Payable,CURRLIAB,None',
        ].join('\n');
        const coa = parseXeroCoaCsv(csv);
        expect(coa.accounts).toHaveLength(4);
        expect(coa.accounts.map((a) => a.gnucashType)).toEqual([
            'BANK',
            'INCOME',
            'RECEIVABLE',
            'PAYABLE',
        ]);
        expect(coa.accounts[0].detailType).toBe('090');
    });
});

/* ------------------------------------------------------------------ */
/* Xero — Journal                                                       */
/* ------------------------------------------------------------------ */

const XERO_HEADER = 'Date,Source,Description,Reference,Journal Number,Account Code,Account,Debit,Credit';

describe('parseXeroJournalCsv', () => {
    it('groups by Journal Number and signs Debit - Credit', () => {
        const csv = [
            'Acme Ltd',
            'Journal Report',
            '',
            XERO_HEADER,
            '2025-01-15,Receivable Invoice,Invoice INV-1,INV-1,1,610,610 - Accounts Receivable,1000.00,',
            '2025-01-15,Receivable Invoice,Invoice INV-1,INV-1,1,200,200 - Sales,,1000.00',
            '2025-01-20,Receive Money,Payment INV-1,INV-1,2,090,090 - Business Bank Account,1000.00,',
            '2025-01-20,Receive Money,Payment INV-1,INV-1,2,610,610 - Accounts Receivable,,1000.00',
        ].join('\n');
        const result = parseXeroJournalCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.companyName).toBe('Acme Ltd');
        expect(result.transactions).toHaveLength(2);
        const [t1, t2] = result.transactions;
        expect(t1).toMatchObject({ date: '2025-01-15', type: 'Receivable Invoice', num: 'INV-1' });
        expect(t1.lines).toEqual([
            expect.objectContaining({ accountPath: 'Accounts Receivable', amount: 1000 }),
            expect.objectContaining({ accountPath: 'Sales', amount: -1000 }),
        ]);
        expect(t2.date).toBe('2025-01-20');
        expect(result.accountsSeen).toEqual([
            'Accounts Receivable',
            'Business Bank Account',
            'Sales',
        ]);
    });

    it('keeps journals distinct when every row repeats the date', () => {
        const csv = [
            XERO_HEADER,
            '2025-01-15,Manual Journal,Entry A,,10,,Cash,50.00,',
            '2025-01-15,Manual Journal,Entry A,,10,,Sales,,50.00',
            '2025-01-15,Manual Journal,Entry B,,11,,Cash,20.00,',
            '2025-01-15,Manual Journal,Entry B,,11,,Sales,,20.00',
        ].join('\n');
        const result = parseXeroJournalCsv(csv);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].num).toBe('10');
        expect(result.transactions[1].num).toBe('11');
    });

    it('uses blank-date continuation when there is no Journal Number column', () => {
        const csv = [
            'Date,Source,Description,Reference,Account,Debit,Credit',
            '2025-01-15,Spend Money,Fuel,,Motor Vehicle Expenses,80.00,',
            ',,,,Business Bank Account,,80.00',
            '2025-01-16,Spend Money,Stationery,,Office Expenses,12.50,',
            ',,,,Business Bank Account,,12.50',
        ].join('\n');
        const result = parseXeroJournalCsv(csv);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].lines.map((l) => l.amount)).toEqual([80, -80]);
    });

    it('rejects unbalanced journals', () => {
        const csv = [
            XERO_HEADER,
            '2025-01-15,Manual Journal,Broken,,7,,Cash,100.00,',
            '2025-01-15,Manual Journal,Broken,,7,,Sales,,90.00',
        ].join('\n');
        const result = parseXeroJournalCsv(csv);
        expect(result.transactions).toEqual([]);
        expect(result.errors[0].message).toContain('does not balance');
        expect(result.errors[0].message).toContain('Journal 7');
    });

    it('tolerates currency-suffixed Debit/Credit headers', () => {
        const csv = [
            'Date,Source,Description,Reference,Journal Number,Account,Debit USD,Credit USD',
            '2025-01-15,Receive Money,Sale,,1,Bank,10.00,',
            '2025-01-15,Receive Money,Sale,,1,Sales,,10.00',
        ].join('\n');
        const result = parseXeroJournalCsv(csv);
        expect(result.errors).toEqual([]);
        expect(result.transactions).toHaveLength(1);
    });

    it('parses EU locale amounts and day-first dates', () => {
        const csv = [
            XERO_HEADER,
            '15/01/2025,Receive Money,Sale,,1,,Bank,"1.234,56",',
            '15/01/2025,Receive Money,Sale,,1,,Sales,,"1.234,56"',
        ].join('\n');
        const result = parseXeroJournalCsv(csv, IMPORT_LOCALES.eu);
        expect(result.errors).toEqual([]);
        expect(result.transactions[0].date).toBe('2025-01-15');
        expect(result.transactions[0].lines[0].amount).toBe(1234.56);
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseXeroJournalCsv('a,b\n1,2');
        expect(result.transactions).toEqual([]);
        expect(result.errors[0].message).toContain('Xero Journal header');
    });

    it('merges CoA types with journal accounts through resolveAccountTypes', () => {
        const journal = parseXeroJournalCsv(
            [
                XERO_HEADER,
                '2025-01-15,Receivable Invoice,Sale,,1,,200 - Sales,,100.00',
                '2025-01-15,Receivable Invoice,Sale,,1,,610 - Accounts Receivable,100.00,',
            ].join('\n')
        );
        const coa = parseXeroCoaCsv(
            ['Code,Name,Type', '200,Sales,REVENUE', '610,Accounts Receivable,CURRENT'].join('\n')
        );
        const resolved = resolveAccountTypes(journal.accountsSeen, coa);
        expect(resolved).toEqual([
            { path: 'Accounts Receivable', gnucashType: 'RECEIVABLE', source: 'coa' },
            { path: 'Sales', gnucashType: 'INCOME', source: 'coa' },
        ]);
    });
});
