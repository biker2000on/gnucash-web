import { describe, it, expect } from 'vitest';
import { detectStatementKind, parseQboStatementRows, coaFromStatements } from '../qbo-statements';
import { resolveAccountTypes } from '../qbo-journal';

/* ------------------------------------------------------------------ */
/* Fixtures — shaped like the QBO "Export data" workbooks after the      */
/* sheet flattener trimmed every cell (no indentation survives).         */
/* ------------------------------------------------------------------ */

const BALANCE_SHEET: string[][] = [
    ['Industrial Insight Inc', ''],
    ['Balance Sheet', ''],
    ['All Dates', ''],
    ['', ''],
    ['', 'Total'],
    ['ASSETS', ''],
    ['Current Assets', ''],
    ['Bank Accounts', ''],
    ['BUSINESS SAVINGS ACCOUNT (1579)', '0.00'],
    ['US Bank', '12.50'],
    ['Total Bank Accounts', '$12.50'],
    ['Accounts Receivable', ''],
    ['Accounts Receivable (A/R)', '0.00'],
    ['Total Accounts Receivable', '$0.00'],
    ['Other Current Assets', ''],
    ['Repayment', ''], //                       parent account, no own balance
    ['401(k) Loan Repayment', '0.00'],
    ['Conference Repayment', '0.00'],
    ['Total Repayment', '$0.00'],
    ['Undeposited Funds', '0.00'],
    ['Total Other Current Assets', '$0.00'],
    ['Total Current Assets', '$12.50'],
    ['Fixed Assets', ''],
    ['Tundra Truck', '0.00'],
    ['Total Fixed Assets', '$0.00'],
    ['TOTAL ASSETS', '$12.50'],
    ['LIABILITIES AND EQUITY', ''],
    ['Liabilities', ''],
    ['Current Liabilities', ''],
    ['Accounts Payable', ''],
    ['Accounts Payable (A/P)', '0.00'],
    ['Total Accounts Payable', '$0.00'],
    ['Credit Cards', ''],
    ['Spark Cash Select 1142', '0.00'],
    ['Total Credit Cards', '$0.00'],
    ['Other Current Liabilities', ''],
    ['Payroll Liabilities', ''],
    ['401K', '0.00'],
    ['CO Income Tax', '0.00'],
    ['Total Payroll Liabilities', '$0.00'],
    ['Total Other Current Liabilities', '$0.00'],
    ['Total Current Liabilities', '$0.00'],
    ['Long-Term Liabilities', ''],
    ['US Bank LOC', '0.00'],
    ['Total Long-Term Liabilities', '$0.00'],
    ['Total Liabilities', '$0.00'],
    ['Equity', ''],
    ["Owner's Pay & Personal Expenses", '0.00'],
    ['Retained Earnings', '0.00'],
    ['Net Income', '12.50'], //                 computed, not an account
    ['Total Equity', '$12.50'],
    ['TOTAL LIABILITIES AND EQUITY', '$12.50'],
    ['', ''],
    ['Tuesday, Sep 01, 2026 12:20:27 PM GMT-7 - Accrual Basis', ''],
];

const PROFIT_AND_LOSS: string[][] = [
    ['Industrial Insight Inc', ''],
    ['Profit and Loss', ''],
    ['All Dates', ''],
    ['', ''],
    ['', 'Total'],
    ['Income', ''],
    ['Services', '0.00'],
    ['Total Income', '$0.00'],
    ['Cost of Goods Sold', ''], //             section
    ['Cost of Goods Sold', ''], //             account with the SAME name as its section
    ['Direct Travel', '0.00'],
    ['Total Cost of Goods Sold', '$0.00'],
    ['Total Cost of Goods Sold', '$0.00'],
    ['Gross Profit', '$0.00'],
    ['Expenses', ''],
    ['Advertising & Marketing', '0.00'], //    parent account posted to directly
    ['Website', '0.00'],
    ['Total Advertising & Marketing', '$0.00'],
    ['Insurance', '0.00'],
    ['General & Administrative Expense', ''],
    ['Travel', ''], //                          parent whose last child shares its name
    ['Flights', '0.00'],
    ['Fuel', '0.00'],
    ['Travel', '0.00'],
    ['Total Travel', '$0.00'],
    ['Total General & Administrative Expense', '$0.00'],
    ['Total Expenses', '$0.00'],
    ['Net Operating Income', '$0.00'],
    ['Other Income', ''],
    ['CC Cash Back Rewards', '0.00'],
    ['Total Other Income', '$0.00'],
    ['Other Expenses', ''],
    ['Other Expenses', ''],
    ['Depreciation Expense', '0.00'],
    ['Total Other Expenses', '$0.00'],
    ['Total Other Expenses', '$0.00'],
    ['Net Other Income', '$0.00'],
    ['Net Income', '$0.00'],
];

const typeOf = (accounts: Array<{ fullName: string; gnucashType: string | null }>) =>
    Object.fromEntries(accounts.map((a) => [a.fullName, a.gnucashType]));

/* ------------------------------------------------------------------ */
/* Detection                                                            */
/* ------------------------------------------------------------------ */

describe('detectStatementKind', () => {
    it('recognizes a Balance Sheet by title + type sections', () => {
        expect(detectStatementKind(BALANCE_SHEET)).toBe('balance_sheet');
    });

    it('recognizes a Profit and Loss by title + type sections', () => {
        expect(detectStatementKind(PROFIT_AND_LOSS)).toBe('profit_and_loss');
    });

    it('rejects a Trial Balance (no sections) and a Journal', () => {
        expect(
            detectStatementKind([
                ['Co', '', ''],
                ['Trial Balance', '', ''],
                ['', 'Debit', 'Credit'],
                ['Checking', '1.00', ''],
                ['TOTAL', '$1.00', '$1.00'],
            ])
        ).toBeNull();
        expect(
            detectStatementKind([
                ['Co'],
                ['Journal'],
                ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
            ])
        ).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Balance Sheet                                                        */
/* ------------------------------------------------------------------ */

describe('parseQboStatementRows — Balance Sheet', () => {
    const result = parseQboStatementRows(BALANCE_SHEET, 'balance_sheet');
    const types = typeOf(result.accounts);

    it('types accounts from their innermost QBO section', () => {
        expect(types['BUSINESS SAVINGS ACCOUNT (1579)']).toBe('BANK');
        expect(types['US Bank']).toBe('BANK');
        expect(types['Accounts Receivable (A/R)']).toBe('RECEIVABLE');
        expect(types['Undeposited Funds']).toBe('ASSET');
        expect(types['Tundra Truck']).toBe('ASSET');
        expect(types['Accounts Payable (A/P)']).toBe('PAYABLE');
        expect(types['Spark Cash Select 1142']).toBe('CREDIT');
        expect(types['US Bank LOC']).toBe('LIABILITY');
        expect(types["Owner's Pay & Personal Expenses"]).toBe('EQUITY');
        expect(types['Retained Earnings']).toBe('EQUITY');
    });

    it('builds colon paths for sub-accounts and keeps the parent account', () => {
        expect(types['Repayment']).toBe('ASSET');
        expect(types['Repayment:401(k) Loan Repayment']).toBe('ASSET');
        expect(types['Repayment:Conference Repayment']).toBe('ASSET');
        expect(types['Payroll Liabilities']).toBe('LIABILITY');
        expect(types['Payroll Liabilities:401K']).toBe('LIABILITY');
        // "Income" in the name would fool keyword inference; the section wins.
        expect(types['Payroll Liabilities:CO Income Tax']).toBe('LIABILITY');
    });

    it('does not emit sections, computed rows, totals, or the footer as accounts', () => {
        const names = result.accounts.map((a) => a.fullName);
        for (const notAccount of [
            'ASSETS',
            'Current Assets',
            'Bank Accounts',
            'Liabilities',
            'Equity',
            'Net Income',
            'TOTAL ASSETS',
            'Total Bank Accounts',
        ]) {
            expect(names).not.toContain(notAccount);
        }
        expect(names.some((n) => /accrual basis/i.test(n))).toBe(false);
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.derivedFrom).toBe('statements');
    });
});

/* ------------------------------------------------------------------ */
/* Profit and Loss                                                      */
/* ------------------------------------------------------------------ */

describe('parseQboStatementRows — Profit and Loss', () => {
    const result = parseQboStatementRows(PROFIT_AND_LOSS, 'profit_and_loss');
    const types = typeOf(result.accounts);

    it('types income, COGS, expenses, other income/expenses', () => {
        expect(types['Services']).toBe('INCOME');
        expect(types['CC Cash Back Rewards']).toBe('INCOME');
        expect(types['Insurance']).toBe('EXPENSE');
        expect(types['Advertising & Marketing']).toBe('EXPENSE');
        expect(types['Advertising & Marketing:Website']).toBe('EXPENSE');
    });

    it('treats a header repeating its own section name as an account, not a section', () => {
        expect(types['Cost of Goods Sold']).toBe('EXPENSE');
        expect(types['Cost of Goods Sold:Direct Travel']).toBe('EXPENSE');
        expect(types['Other Expenses']).toBe('EXPENSE');
        expect(types['Other Expenses:Depreciation Expense']).toBe('EXPENSE');
    });

    it('matches "Total X" to the parent even when the last child is also named X', () => {
        expect(types['General & Administrative Expense:Travel']).toBe('EXPENSE');
        expect(types['General & Administrative Expense:Travel:Flights']).toBe('EXPENSE');
        expect(types['General & Administrative Expense:Travel:Fuel']).toBe('EXPENSE');
        expect(types['General & Administrative Expense:Travel:Travel']).toBe('EXPENSE');
        expect(types['General & Administrative Expense:Fuel']).toBeUndefined();
    });

    it('skips computed rows', () => {
        const names = result.accounts.map((a) => a.fullName);
        expect(names).not.toContain('Gross Profit');
        expect(names).not.toContain('Net Operating Income');
        expect(names).not.toContain('Net Other Income');
        expect(names).not.toContain('Net Income');
    });
});

/* ------------------------------------------------------------------ */
/* Merge + resolution                                                   */
/* ------------------------------------------------------------------ */

describe('coaFromStatements', () => {
    it('merges both reports and feeds resolveAccountTypes with source "statement"', () => {
        const coa = coaFromStatements([
            { rows: BALANCE_SHEET, kind: 'balance_sheet' },
            { rows: PROFIT_AND_LOSS, kind: 'profit_and_loss' },
        ]);
        expect(coa).not.toBeNull();
        const resolved = resolveAccountTypes(
            ['Services', 'Payroll Liabilities:CO Income Tax', 'Spark Card (deleted)'],
            coa
        );
        expect(resolved).toEqual([
            { path: 'Services', gnucashType: 'INCOME', source: 'statement' },
            { path: 'Payroll Liabilities:CO Income Tax', gnucashType: 'LIABILITY', source: 'statement' },
            // Deleted accounts are absent from the statements → name inference.
            { path: 'Spark Card (deleted)', gnucashType: 'CREDIT', source: 'inferred' },
        ]);
    });

    it('returns null when neither report yields accounts', () => {
        expect(coaFromStatements([{ rows: [['Co'], ['Balance Sheet']], kind: 'balance_sheet' }])).toBeNull();
    });
});
