import { describe, it, expect } from 'vitest';
import { parseMintCsv } from '../mint';
import { parseYnabCsv } from '../ynab';
import { parseMonarchCsv } from '../monarch';
import { IMPORT_LOCALES } from '../parse-locale';

/* ------------------------------------------------------------------ */
/* Mint                                                                 */
/* ------------------------------------------------------------------ */

const MINT_HEADER =
    'Date,Description,Original Description,Amount,Transaction Type,Category,Account Name,Labels,Notes';

describe('parseMintCsv', () => {
    it('normalizes rows: debit = money out, credit = money in', () => {
        const csv = [
            MINT_HEADER,
            '01/15/2025,Grocery Store,GROCERY STORE #123,54.20,debit,Groceries,Chase Checking,,',
            '01/16/2025,Paycheck,ACME PAYROLL,2500.00,credit,Paycheck,Chase Checking,,',
        ].join('\n');
        const result = parseMintCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.records).toHaveLength(2);
        expect(result.records[0]).toMatchObject({
            date: '2025-01-15',
            description: 'Grocery Store',
            amount: -54.2,
            category: 'Groceries',
            account: 'Chase Checking',
        });
        expect(result.records[0].memo).toContain('GROCERY STORE #123');
        expect(result.records[1].amount).toBe(2500);
        expect(result.dateRange).toEqual({ start: '2025-01-15', end: '2025-01-16' });
    });

    it('takes abs() of the amount cell — the type column always wins', () => {
        const csv = [
            MINT_HEADER,
            '01/15/2025,Refund,REFUND,-25.00,credit,Shopping,Visa,,',
            '01/15/2025,Fee,FEE,-10.00,debit,Fees,Visa,,',
        ].join('\n');
        const result = parseMintCsv(csv);
        expect(result.records[0].amount).toBe(25);
        expect(result.records[1].amount).toBe(-10);
    });

    it('collects labels and notes into the memo', () => {
        const csv = [
            MINT_HEADER,
            '01/15/2025,Dinner,DINNER,30.00,debit,Restaurants,Visa,vacation,Anniversary dinner',
        ].join('\n');
        const r = parseMintCsv(csv).records[0];
        expect(r.memo).toContain('Anniversary dinner');
        expect(r.memo).toContain('Labels: vacation');
    });

    it('reports bad dates / amounts / types as row errors', () => {
        const csv = [
            MINT_HEADER,
            'nonsense,X,X,5.00,debit,C,A,,',
            '01/15/2025,X,X,abc,debit,C,A,,',
            '01/15/2025,X,X,5.00,sideways,C,A,,',
            '01/16/2025,OK,OK,5.00,debit,C,A,,',
        ].join('\n');
        const result = parseMintCsv(csv);
        expect(result.errors).toHaveLength(3);
        expect(result.records).toHaveLength(1);
        expect(result.rowsRead).toBe(4);
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseMintCsv('a,b,c\n1,2,3');
        expect(result.records).toEqual([]);
        expect(result.errors[0].message).toContain('Mint header');
    });

    it('parses EU locale dates and amounts', () => {
        const csv = [
            MINT_HEADER,
            '15/01/2025,Markt,MARKT,"1.234,56",debit,Lebensmittel,Giro,,',
        ].join('\n');
        const result = parseMintCsv(csv, IMPORT_LOCALES.eu);
        expect(result.records[0].date).toBe('2025-01-15');
        expect(result.records[0].amount).toBe(-1234.56);
    });

    it('counts day/month-ambiguous dates', () => {
        const csv = [
            MINT_HEADER,
            '03/04/2025,A,A,1.00,debit,C,X,,',
            '04/15/2025,B,B,1.00,debit,C,X,,',
        ].join('\n');
        expect(parseMintCsv(csv).ambiguousDateRows).toBe(1);
    });
});

/* ------------------------------------------------------------------ */
/* YNAB                                                                 */
/* ------------------------------------------------------------------ */

const YNAB_HEADER =
    '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow"';

describe('parseYnabCsv', () => {
    it('normalizes rows: amount = inflow − outflow, strips currency symbols', () => {
        const csv = [
            YNAB_HEADER,
            '"Checking","","01/15/2025","Grocery Store","Everyday Expenses: Groceries","Everyday Expenses","Groceries","weekly run","$54.20","$0.00"',
            '"Checking","","01/16/2025","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$2,500.00"',
        ].join('\n');
        const result = parseYnabCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.records[0]).toMatchObject({
            date: '2025-01-15',
            description: 'Grocery Store',
            amount: -54.2,
            category: 'Everyday Expenses: Groceries',
            account: 'Checking',
            memo: 'weekly run',
        });
        expect(result.records[1].amount).toBe(2500);
    });

    it('joins separate Category Group + Category columns when no combined column exists', () => {
        const csv = [
            '"Account","Flag","Date","Payee","Category Group","Category","Memo","Outflow","Inflow"',
            '"Checking","","01/15/2025","Store","Everyday Expenses","Groceries","","$10.00","$0.00"',
        ].join('\n');
        const result = parseYnabCsv(csv);
        expect(result.records[0].category).toBe('Everyday Expenses: Groceries');
    });

    it('keeps flags in the memo and tolerates transfer rows without category', () => {
        const csv = [
            YNAB_HEADER,
            '"Checking","Red","01/15/2025","Transfer : Savings","","","","note","$100.00","$0.00"',
        ].join('\n');
        const r = parseYnabCsv(csv).records[0];
        expect(r.description).toBe('Transfer : Savings');
        expect(r.category).toBe('');
        expect(r.amount).toBe(-100);
        expect(r.memo).toContain('Flag: Red');
    });

    it('parses EU locale outflow/inflow', () => {
        const csv = [
            YNAB_HEADER,
            '"Giro","","15/01/2025","Markt","Alltag: Lebensmittel","Alltag","Lebensmittel","","1.234,56 €","0,00 €"',
        ].join('\n');
        const result = parseYnabCsv(csv, IMPORT_LOCALES.eu);
        expect(result.records[0].date).toBe('2025-01-15');
        expect(result.records[0].amount).toBe(-1234.56);
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseYnabCsv('Date,Amount\n01/01/2025,5');
        expect(result.records).toEqual([]);
        expect(result.errors[0].message).toContain('YNAB');
    });
});

/* ------------------------------------------------------------------ */
/* Monarch                                                              */
/* ------------------------------------------------------------------ */

const MONARCH_HEADER = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags';

describe('parseMonarchCsv', () => {
    it('normalizes rows: signed amounts used as-is', () => {
        const csv = [
            MONARCH_HEADER,
            '2025-01-15,Grocery Store,Groceries,Chase Checking,GROCERY STORE #123,,-54.20,',
            '2025-01-16,Acme Corp,Paychecks,Chase Checking,ACME PAYROLL,,2500.00,',
        ].join('\n');
        const result = parseMonarchCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.records[0]).toMatchObject({
            date: '2025-01-15',
            description: 'Grocery Store',
            amount: -54.2,
            category: 'Groceries',
            account: 'Chase Checking',
        });
        expect(result.records[0].memo).toContain('GROCERY STORE #123');
        expect(result.records[1].amount).toBe(2500);
    });

    it('collects notes and tags into the memo', () => {
        const csv = [
            MONARCH_HEADER,
            '2025-01-15,Dinner Place,Restaurants,Visa,DINNER PLACE,date night,-30.00,"fun,vacation"',
        ].join('\n');
        const r = parseMonarchCsv(csv).records[0];
        expect(r.memo).toContain('date night');
        expect(r.memo).toContain('Tags: fun,vacation');
    });

    it('reports bad rows and keeps good ones', () => {
        const csv = [
            MONARCH_HEADER,
            'garbage,X,C,A,,,5.00,',
            '2025-01-15,X,C,A,,,not-a-number,',
            '2025-01-16,OK,C,A,,,-5.00,',
        ].join('\n');
        const result = parseMonarchCsv(csv);
        expect(result.errors).toHaveLength(2);
        expect(result.records).toHaveLength(1);
    });

    it('parses EU locale numeric dates and comma decimals', () => {
        const csv = [
            MONARCH_HEADER,
            '15/01/2025,Markt,Lebensmittel,Giro,MARKT,,"-1.234,56",',
        ].join('\n');
        const result = parseMonarchCsv(csv, IMPORT_LOCALES.eu);
        expect(result.records[0].date).toBe('2025-01-15');
        expect(result.records[0].amount).toBe(-1234.56);
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseMonarchCsv('foo,bar\n1,2');
        expect(result.records).toEqual([]);
        expect(result.errors[0].message).toContain('Monarch');
    });
});
