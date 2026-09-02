import { describe, it, expect } from 'vitest';
import { buildScaffoldedTree, groupForQboType } from '../qbo-tree';
import { parseQboCoaCsv, resolveAccountTypes } from '../qbo-journal';

/* ------------------------------------------------------------------ */
/* Fixture — a slice of a real QBO "Chart of accounts" report export     */
/* ------------------------------------------------------------------ */

const COA_CSV = [
    'Account name,Account type,Detail type',
    'SMALL BUSINESS CHECKING ACCOUN (4604),Bank,Checking',
    'Petty Cash,Bank,Cash on hand',
    'Accounts Receivable (A/R),Accounts receivable (A/R),Accounts Receivable (A/R)',
    'Employee Loans,Other Current Assets,Loans to Others',
    'Repayment,Other Current Assets,Other Current Assets',
    'Repayment:401(k) Loan Repayment,Other Current Assets,Other Current Assets',
    'Tundra Truck,Fixed Assets,Vehicles',
    'Loan Costs,Other Assets,Other intangible assets',
    'Accounts Payable (A/P),Accounts payable (A/P),Accounts Payable (A/P)',
    'Spark Cash Select 1142,Credit Card,Credit Card',
    'Payroll Liabilities,Other Current Liabilities,Payroll Tax Payable',
    'Payroll Liabilities:CO Income Tax,Other Current Liabilities,Payroll Tax Payable',
    'SBA Loan,Long Term Liabilities,Notes Payable',
    'Retained Earnings,Equity,Retained Earnings',
    'Services,Income,Service/Fee Income',
    'Interest,Other Income,Interest Earned',
    'Cost of Goods Sold,Cost of Goods Sold,Supplies & Materials - COGS',
    'Cost of Goods Sold:Direct Travel,Cost of Goods Sold,Cost of labor - COS',
    'Insurance,Expenses,Insurance',
    'Insurance:Fire,Expenses,Insurance',
    'General & Administrative Expense:Travel:Fuel,Expenses,Travel', // parent rows missing from the export
    'Other Expenses,Other Expense,Other Miscellaneous Expense',
    'Other Expenses:Depreciation Expense,Other Expense,Depreciation',
].join('\n');

const JOURNAL_ACCOUNTS = [
    'SMALL BUSINESS CHECKING ACCOUN (4604)',
    'Payroll Liabilities:CO Income Tax',
    'Services',
    'Cost of Goods Sold',
    'Cost of Goods Sold:Direct Travel',
    'Insurance:Auto (deleted)', //     parent in chart, leaf deleted
    'Spark Card (deleted)', //         nothing in chart → inferred CREDIT
    'Tundra Truck (deleted)', //       "(deleted)" suffix, account still in chart
    'Other Expenses:Interest Paid', // parent is the merged group node
];

function build(overrides: Record<string, string> = {}) {
    const coa = parseQboCoaCsv(COA_CSV);
    const resolved = resolveAccountTypes(JOURNAL_ACCOUNTS, coa, overrides);
    return { coa, resolved, tree: buildScaffoldedTree(resolved, coa) };
}

const nodeMap = (tree: ReturnType<typeof buildScaffoldedTree>) =>
    new Map(tree.nodes.map((n) => [n.path, n]));

/* ------------------------------------------------------------------ */

describe('groupForQboType', () => {
    it('maps QBO account types to scaffold groups with coerced GnuCash types', () => {
        expect(groupForQboType('Bank')).toEqual({ segments: ['Assets', 'Current Assets'], type: 'BANK' });
        expect(groupForQboType('Credit Card')).toEqual({ segments: ['Liabilities', 'Credit Cards'], type: 'CREDIT' });
        expect(groupForQboType('Long Term Liabilities')?.segments).toEqual(['Liabilities', 'Long-Term Liabilities']);
        expect(groupForQboType('Other Expense')?.segments).toEqual(['Expenses', 'Other Expenses']);
    });

    it('reads the innermost section of a statement-derived type path', () => {
        expect(groupForQboType('ASSETS › Current Assets › Bank Accounts')?.type).toBe('BANK');
        expect(groupForQboType('LIABILITIES AND EQUITY › Liabilities › Current Liabilities › Credit Cards')?.type).toBe('CREDIT');
        expect(groupForQboType('nonsense')).toBeNull();
    });
});

describe('buildScaffoldedTree — chart placement', () => {
    const { tree } = build();
    const nodes = nodeMap(tree);

    it('nests every chart account under the GnuCash scaffold for its QBO type', () => {
        expect(nodes.get('Assets:Current Assets:SMALL BUSINESS CHECKING ACCOUN (4604)')?.accountType).toBe('BANK');
        expect(nodes.get('Assets:Current Assets:Accounts Receivable (A/R)')?.accountType).toBe('RECEIVABLE');
        expect(nodes.get('Assets:Current Assets:Employee Loans')?.accountType).toBe('ASSET');
        expect(nodes.get('Assets:Fixed Assets:Tundra Truck')?.accountType).toBe('ASSET');
        expect(nodes.get('Assets:Other Assets:Loan Costs')?.accountType).toBe('ASSET');
        expect(nodes.get('Liabilities:Current Liabilities:Accounts Payable (A/P)')?.accountType).toBe('PAYABLE');
        expect(nodes.get('Liabilities:Credit Cards:Spark Cash Select 1142')?.accountType).toBe('CREDIT');
        expect(nodes.get('Liabilities:Long-Term Liabilities:SBA Loan')?.accountType).toBe('LIABILITY');
        expect(nodes.get('Equity:Retained Earnings')?.accountType).toBe('EQUITY');
        expect(nodes.get('Income:Services')?.accountType).toBe('INCOME');
        expect(nodes.get('Income:Other Income:Interest')?.accountType).toBe('INCOME');
        expect(nodes.get('Expenses:Insurance:Fire')?.accountType).toBe('EXPENSE');
    });

    it('keeps QBO sub-account paths intact under the group and coerces the child type from the group', () => {
        expect(nodes.get('Liabilities:Current Liabilities:Payroll Liabilities')?.accountType).toBe('LIABILITY');
        // "Income" in the name would fool keyword inference; the parent group wins.
        expect(nodes.get('Liabilities:Current Liabilities:Payroll Liabilities:CO Income Tax')?.accountType).toBe('LIABILITY');
        expect(nodes.get('Assets:Current Assets:Repayment:401(k) Loan Repayment')?.accountType).toBe('ASSET');
    });

    it('creates chart accounts the journal never touches', () => {
        expect(nodes.has('Assets:Current Assets:Employee Loans')).toBe(true);
        expect(nodes.get('Assets:Current Assets:Employee Loans')?.placeholder).toBe(false);
        expect(tree.coaAccountCount).toBe(parseQboCoaCsv(COA_CSV).accounts.length);
    });

    it('refines the type from the QBO detail type only within the group', () => {
        expect(nodes.get('Assets:Current Assets:Petty Cash')?.accountType).toBe('CASH');
    });

    it('merges a top-level account named like its group into the group node', () => {
        expect(nodes.has('Expenses:Cost of Goods Sold:Cost of Goods Sold')).toBe(false);
        expect(nodes.get('Expenses:Cost of Goods Sold')?.placeholder).toBe(false);
        expect(nodes.get('Expenses:Cost of Goods Sold:Direct Travel')?.accountType).toBe('EXPENSE');
        expect(nodes.has('Expenses:Other Expenses:Other Expenses')).toBe(false);
        expect(nodes.get('Expenses:Other Expenses:Depreciation Expense')?.accountType).toBe('EXPENSE');
        // A journal line on the merged node lands on the group guid.
        expect(tree.guidByJournalPath.get('Cost of Goods Sold')).toBe(nodes.get('Expenses:Cost of Goods Sold')!.guid);
    });

    it('synthesizes missing intermediate parents for a chart row whose parents were not exported', () => {
        expect(nodes.get('Expenses:General & Administrative Expense')?.accountType).toBe('EXPENSE');
        expect(nodes.get('Expenses:General & Administrative Expense:Travel')?.accountType).toBe('EXPENSE');
        expect(nodes.get('Expenses:General & Administrative Expense:Travel:Fuel')?.accountType).toBe('EXPENSE');
    });

    it('scaffold groups are placeholders, parents precede children, and empty groups are pruned', () => {
        expect(nodes.get('Assets')?.placeholder).toBe(true);
        expect(nodes.get('Liabilities:Credit Cards')?.placeholder).toBe(true);
        const index = new Map(tree.nodes.map((n, i) => [n.path, i]));
        for (const n of tree.nodes) {
            if (n.parentPath) expect(index.get(n.parentPath)!).toBeLessThan(index.get(n.path)!);
        }
        // No Other Income-less pruning here (Interest exists); build a chart with no equity to see pruning.
        const noEquity = buildScaffoldedTree(
            resolveAccountTypes(['Checking'], parseQboCoaCsv('Account name,Account type,Detail type\nChecking,Bank,Checking')),
            parseQboCoaCsv('Account name,Account type,Detail type\nChecking,Bank,Checking')
        );
        const paths = noEquity.nodes.map((n) => n.path);
        expect(paths).toEqual(['Assets', 'Assets:Current Assets', 'Assets:Current Assets:Checking']);
    });
});

describe('buildScaffoldedTree — journal accounts missing from the chart', () => {
    const { tree } = build();
    const nodes = nodeMap(tree);
    const how = Object.fromEntries(tree.unmatched.map((u) => [u.path, u]));

    it('matches "(deleted)" accounts that still exist in the chart', () => {
        expect(how['Tundra Truck (deleted)']).toMatchObject({ placedAs: 'Assets:Fixed Assets:Tundra Truck', how: 'deleted-suffix' });
        expect(tree.guidByJournalPath.get('Tundra Truck (deleted)')).toBe(nodes.get('Assets:Fixed Assets:Tundra Truck')!.guid);
    });

    it('nests a deleted leaf under its chart parent, inheriting the parent type', () => {
        expect(how['Insurance:Auto (deleted)']).toMatchObject({ placedAs: 'Expenses:Insurance:Auto (deleted)', how: 'parent' });
        expect(nodes.get('Expenses:Insurance:Auto (deleted)')?.accountType).toBe('EXPENSE');
        expect(how['Other Expenses:Interest Paid']).toMatchObject({ placedAs: 'Expenses:Other Expenses:Interest Paid', how: 'parent' });
    });

    it('places an unknown account in the group for its resolved type', () => {
        expect(how['Spark Card (deleted)']).toMatchObject({ placedAs: 'Liabilities:Credit Cards:Spark Card (deleted)', how: 'type' });
        expect(nodes.get('Liabilities:Credit Cards:Spark Card (deleted)')?.accountType).toBe('CREDIT');
    });

    it('reports the target path for every journal account', () => {
        expect(tree.targetPathByJournalPath.get('Payroll Liabilities:CO Income Tax')).toBe(
            'Liabilities:Current Liabilities:Payroll Liabilities:CO Income Tax'
        );
        for (const p of JOURNAL_ACCOUNTS) expect(tree.guidByJournalPath.has(p)).toBe(true);
    });

    it('honors a manual type override on a chart account', () => {
        const { tree: t } = build({ 'Services': 'EXPENSE' });
        expect(nodeMap(t).get('Income:Services')?.accountType).toBe('EXPENSE');
    });
});

describe('buildScaffoldedTree — no chart at all', () => {
    it('places every journal account by its resolved type, keeping sub-account paths', () => {
        const resolved = resolveAccountTypes(['Checking', 'Sales:Design', 'Office Expenses:Supplies'], null);
        const tree = buildScaffoldedTree(resolved, null);
        const paths = tree.nodes.map((n) => n.path);
        expect(paths).toContain('Assets:Current Assets:Checking');
        expect(paths).toContain('Income:Sales:Design');
        expect(paths).toContain('Expenses:Office Expenses:Supplies');
        expect(tree.coaAccountCount).toBe(0);
        expect(tree.unmatched).toHaveLength(3);
    });
});
