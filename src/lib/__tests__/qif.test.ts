/**
 * QIF import tests — parser (src/lib/qif/parser.ts) and
 * planner (src/lib/qif/importer.ts, planQifImport). Pure, no database.
 */
import { describe, it, expect } from 'vitest';
import { parseQif, parseQifAmount } from '@/lib/qif/parser';
import {
    planQifImport,
    qifTypeToAccountType,
    type QifPlanContext,
    type QifPlanOptions,
    type ExistingAccountInfo,
} from '@/lib/qif/importer';

/* ------------------------------------------------------------------ */
/* Parser                                                               */
/* ------------------------------------------------------------------ */

describe('parseQif — dates', () => {
    it('parses MM/DD/YY dates (US)', () => {
        const result = parseQif('!Type:Bank\nD01/15/26\nT-10.00\nPTest\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].date).toBe('2026-01-15');
    });

    it('parses MM/DD/YYYY dates', () => {
        const result = parseQif('!Type:Bank\nD03/07/2024\nT-10.00\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].date).toBe('2024-03-07');
    });

    it("parses Quicken MM/DD'YY apostrophe dates as 2000s", () => {
        const result = parseQif("!Type:Bank\nD12/31'05\nT-10.00\n^\n", { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].date).toBe('2005-12-31');
    });

    it('parses DD/MM dates with explicit eu format', () => {
        const result = parseQif('!Type:Bank\nD15/01/2026\nT-10.00\n^\n', { dateFormat: 'eu' });
        expect(result.accounts[0].transactions[0].date).toBe('2026-01-15');
    });

    it('auto-detects DD/MM order when the first component exceeds 12', () => {
        const qif = '!Type:Bank\nD05/03/2026\nT-1.00\n^\nD25/03/2026\nT-2.00\n^\n';
        const result = parseQif(qif, { dateFormat: 'auto' });
        const dates = result.accounts[0].transactions.map((t) => t.date);
        expect(dates).toEqual(['2026-03-05', '2026-03-25']);
    });

    it('auto-detects MM/DD order when the second component exceeds 12', () => {
        const qif = '!Type:Bank\nD03/25/2026\nT-1.00\n^\n';
        const result = parseQif(qif, { dateFormat: 'auto' });
        expect(result.accounts[0].transactions[0].date).toBe('2026-03-25');
    });

    it('treats two-digit years >= 70 as 1900s', () => {
        const result = parseQif('!Type:Bank\nD06/01/95\nT-10.00\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].date).toBe('1995-06-01');
    });

    it('supports dash and dot separators', () => {
        const result = parseQif('!Type:Bank\nD01-15-2026\nT-1.00\n^\nD01.16.2026\nT-2.00\n^\n', {
            dateFormat: 'us',
        });
        const dates = result.accounts[0].transactions.map((t) => t.date);
        expect(dates).toEqual(['2026-01-15', '2026-01-16']);
    });

    it('skips transactions with invalid dates and warns', () => {
        const result = parseQif('!Type:Bank\nD13/45/2026\nT-1.00\n^\nD01/15/2026\nT-2.00\n^\n', {
            dateFormat: 'us',
        });
        expect(result.accounts[0].transactions).toHaveLength(1);
        expect(result.warnings.some((w) => w.includes('Invalid date'))).toBe(true);
    });
});

describe('parseQif — amounts', () => {
    it('parses amounts with comma thousands separators', () => {
        const result = parseQif('!Type:Bank\nD01/15/2026\nT1,234.56\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].amount).toBe(1234.56);
    });

    it('parses negative amounts with leading minus', () => {
        const result = parseQif('!Type:Bank\nD01/15/2026\nT-1,234.56\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].amount).toBe(-1234.56);
    });

    it('prefers T over U when both present', () => {
        const result = parseQif('!Type:Bank\nD01/15/2026\nU-99.00\nT-10.00\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].amount).toBe(-10);
    });

    it('parseQifAmount handles parentheses as negative', () => {
        expect(parseQifAmount('(42.50)')).toBe(-42.5);
        expect(parseQifAmount('1,000')).toBe(1000);
        expect(parseQifAmount('garbage')).toBeNull();
    });
});

describe('parseQif — fields and cleared status', () => {
    const qif = [
        '!Type:Bank',
        'D01/15/2026',
        'T-42.50',
        'PGrocery Store  ', // trailing whitespace tolerance
        'MWeekly shopping',
        'N1234',
        'C*',
        'LFood:Groceries',
        '^',
        'D01/16/2026',
        'T-10.00',
        'PCleared X',
        'CX',
        '^',
        'D01/17/2026',
        'T-11.00',
        'PLowercase c',
        'Cc',
        '^',
        'D01/18/2026',
        'T-12.00',
        'PNot cleared',
        '^',
    ].join('\n');

    it('captures payee, memo, num, category', () => {
        const result = parseQif(qif, { dateFormat: 'us' });
        const t = result.accounts[0].transactions[0];
        expect(t.payee).toBe('Grocery Store');
        expect(t.memo).toBe('Weekly shopping');
        expect(t.num).toBe('1234');
        expect(t.category).toBe('Food:Groceries');
        expect(t.transfer).toBeNull();
    });

    it('maps cleared flags: * and c -> cleared, X -> reconciled, none -> n', () => {
        const result = parseQif(qif, { dateFormat: 'us' });
        const [a, b, c, d] = result.accounts[0].transactions;
        expect(a.cleared).toBe('c');
        expect(b.cleared).toBe('y');
        expect(c.cleared).toBe('c');
        expect(d.cleared).toBe('n');
    });
});

describe('parseQif — category vs [transfer]', () => {
    it('distinguishes [Account] transfers from categories', () => {
        const qif =
            '!Type:Bank\nD01/15/2026\nT-500.00\nPMove money\nL[Savings]\n^\nD01/16/2026\nT-20.00\nLFood:Dining\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        const [xfer, cat] = result.accounts[0].transactions;
        expect(xfer.transfer).toBe('Savings');
        expect(xfer.category).toBeNull();
        expect(cat.category).toBe('Food:Dining');
        expect(cat.transfer).toBeNull();
    });

    it('strips /Class suffixes', () => {
        const qif = '!Type:Bank\nD01/15/2026\nT-20.00\nLFood/Vacation\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].category).toBe('Food');
    });
});

describe('parseQif — splits', () => {
    it('parses S/E/$ split records', () => {
        const qif = [
            '!Type:Bank',
            'D01/15/2026',
            'T-100.00',
            'PBig Store',
            'SFood:Groceries',
            'EFood part',
            '$-60.00',
            'SHousehold',
            'ESupplies',
            '$-40.00',
            '^',
        ].join('\n');
        const result = parseQif(qif, { dateFormat: 'us' });
        const t = result.accounts[0].transactions[0];
        expect(t.splits).toHaveLength(2);
        expect(t.splits[0]).toMatchObject({ category: 'Food:Groceries', memo: 'Food part', amount: -60 });
        expect(t.splits[1]).toMatchObject({ category: 'Household', memo: 'Supplies', amount: -40 });
        expect(result.warnings.filter((w) => w.includes('sum to'))).toHaveLength(0);
    });

    it('warns when splits do not sum to the transaction total', () => {
        const qif = '!Type:Bank\nD01/15/2026\nT-100.00\nSFood\n$-60.00\nSHousehold\n$-30.00\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.warnings.some((w) => w.includes('sum to'))).toBe(true);
    });

    it('parses split-level [transfers]', () => {
        const qif = '!Type:Bank\nD01/15/2026\nT-100.00\nS[Savings]\n$-100.00\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.accounts[0].transactions[0].splits[0].transfer).toBe('Savings');
    });
});

describe('parseQif — multi-account files', () => {
    const qif = [
        '!Option:AutoSwitch',
        '!Account',
        'NChecking',
        'TBank',
        '^',
        'NVisa',
        'TCCard',
        '^',
        '!Clear:AutoSwitch',
        '!Account',
        'NChecking',
        'TBank',
        '^',
        '!Type:Bank',
        'D01/15/2026',
        'T-100.00',
        'PPayment to Visa',
        'L[Visa]',
        '^',
        '!Account',
        'NVisa',
        'TCCard',
        '^',
        '!Type:CCard',
        'D01/15/2026',
        'T100.00',
        'PPayment from Checking',
        'L[Checking]',
        '^',
        'D01/16/2026',
        'T-25.00',
        'PRestaurant',
        'LFood:Dining',
        '^',
    ].join('\r\n');

    it('assigns transactions to the right accounts', () => {
        const result = parseQif(qif, { dateFormat: 'us' });
        const checking = result.accounts.find((a) => a.name === 'Checking')!;
        const visa = result.accounts.find((a) => a.name === 'Visa')!;
        expect(checking.type).toBe('Bank');
        expect(visa.type).toBe('CCard');
        expect(checking.transactions).toHaveLength(1);
        expect(visa.transactions).toHaveLength(2);
    });

    it('tolerates CRLF line endings', () => {
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.accounts).toHaveLength(2);
        expect(result.accounts[1].transactions[1].payee).toBe('Restaurant');
    });
});

describe('parseQif — tolerance and misc', () => {
    it('strips a UTF-8 BOM', () => {
        const result = parseQif('﻿!Type:Bank\nD01/15/2026\nT-1.00\n^\n', { dateFormat: 'us' });
        expect(result.accounts[0].transactions).toHaveLength(1);
    });

    it('parses !Type:Cat category lists', () => {
        const qif = '!Type:Cat\nNSalary\nDMonthly pay\nI\n^\nNFood:Dining\nE\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.categories).toEqual([
            { name: 'Salary', description: 'Monthly pay', isIncome: true },
            { name: 'Food:Dining', description: '', isIncome: false },
        ]);
    });

    it('skips unsupported sections with a warning', () => {
        const qif = '!Type:Invst\nD01/15/2026\nNBuy\n^\n!Type:Bank\nD01/15/2026\nT-1.00\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.warnings.some((w) => w.includes('Invst'))).toBe(true);
        expect(result.accounts[0].transactions).toHaveLength(1);
    });

    it('supports !Type:Oth A and !Type:Oth L sections', () => {
        const qif = '!Type:Oth A\nD01/15/2026\nT500.00\n^\n';
        const result = parseQif(qif, { dateFormat: 'us' });
        expect(result.accounts[0].type).toBe('Oth A');
        expect(result.accounts[0].transactions).toHaveLength(1);
    });
});

/* ------------------------------------------------------------------ */
/* Planner                                                              */
/* ------------------------------------------------------------------ */

const ROOT = 'root0000000000000000000000000000';

function makeContext(
    accounts: ExistingAccountInfo[],
    existingTransactions: QifPlanContext['existingTransactions'] = []
): QifPlanContext {
    return {
        bookRootGuid: ROOT,
        bookAccountGuids: [ROOT, ...accounts.map((a) => a.guid)],
        accounts,
        existingTransactions,
    };
}

function makeOptions(overrides: Partial<QifPlanOptions> = {}): QifPlanOptions {
    return { currencyGuid: 'usd00000000000000000000000000000', currencyMnemonic: 'USD', ...overrides };
}

const CHECKING: ExistingAccountInfo = {
    guid: 'chk00000000000000000000000000000',
    name: 'Checking',
    fullname: 'Assets:Checking',
    accountType: 'BANK',
};
const SAVINGS: ExistingAccountInfo = {
    guid: 'sav00000000000000000000000000000',
    name: 'Savings',
    fullname: 'Assets:Savings',
    accountType: 'BANK',
};
const DINING: ExistingAccountInfo = {
    guid: 'din00000000000000000000000000000',
    name: 'Dining',
    fullname: 'Expenses:Food:Dining',
    accountType: 'EXPENSE',
};

describe('planQifImport — account mapping', () => {
    it('maps QIF accounts to existing accounts by name', () => {
        const parsed = parseQif(
            '!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-20.00\nPX\nLFood:Dining\n^\n',
            { dateFormat: 'us' }
        );
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, SAVINGS, DINING]));
        expect(plan.accountMappings[0]).toMatchObject({
            qifName: 'Checking',
            guid: CHECKING.guid,
            isNew: false,
        });
        expect(plan.accountsToCreate.filter((a) => a.reason === 'account')).toHaveLength(0);
    });

    it('proposes account creation when no name match exists', () => {
        const parsed = parseQif(
            '!Account\nNBrokerage Cash\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-20.00\nLFood:Dining\n^\n',
            { dateFormat: 'us' }
        );
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, DINING]));
        expect(plan.accountMappings[0].isNew).toBe(true);
        const created = plan.accountsToCreate.find((a) => a.reason === 'account');
        expect(created).toMatchObject({ path: 'Brokerage Cash', accountType: 'BANK', anchorGuid: ROOT });
    });

    it('honors explicit account mapping overrides', () => {
        const parsed = parseQif(
            '!Account\nNMy Checking\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-20.00\nLFood:Dining\n^\n',
            { dateFormat: 'us' }
        );
        const plan = planQifImport(
            parsed,
            makeOptions({ accountMappings: { 'My Checking': CHECKING.guid } }),
            makeContext([CHECKING, DINING])
        );
        expect(plan.accountMappings[0]).toMatchObject({ guid: CHECKING.guid, isNew: false });
    });

    it('maps QIF types to GnuCash account types', () => {
        expect(qifTypeToAccountType('Bank')).toBe('BANK');
        expect(qifTypeToAccountType('Cash')).toBe('CASH');
        expect(qifTypeToAccountType('CCard')).toBe('CREDIT');
        expect(qifTypeToAccountType('Oth A')).toBe('ASSET');
        expect(qifTypeToAccountType('Oth L')).toBe('LIABILITY');
    });
});

describe('planQifImport — category mapping', () => {
    it('matches categories to existing accounts by fullname suffix', () => {
        const parsed = parseQif('!Type:Bank\nD01/15/2026\nT-20.00\nPX\nLFood:Dining\n^\n', {
            dateFormat: 'us',
        });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, DINING]));
        expect(plan.categoryMappings[0]).toMatchObject({
            category: 'Food:Dining',
            guid: DINING.guid,
            isNew: false,
        });
    });

    it('proposes expense creation under Expenses: for unmatched spending categories', () => {
        const parsed = parseQif('!Type:Bank\nD01/15/2026\nT-20.00\nLPet Supplies\n^\n', {
            dateFormat: 'us',
        });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING]));
        const created = plan.accountsToCreate.find((a) => a.reason === 'category');
        expect(created).toMatchObject({
            path: 'Expenses:Pet Supplies',
            accountType: 'EXPENSE',
            anchorGuid: ROOT,
        });
    });

    it('proposes income creation under Income: for deposits', () => {
        const parsed = parseQif('!Type:Bank\nD01/15/2026\nT2000.00\nLPaycheck\n^\n', { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING]));
        const created = plan.accountsToCreate.find((a) => a.reason === 'category');
        expect(created).toMatchObject({ path: 'Income:Paycheck', accountType: 'INCOME' });
    });

    it('uses the !Type:Cat income flag over the amount sign', () => {
        const qif = '!Type:Cat\nNRefunds\nI\n^\n!Type:Bank\nD01/15/2026\nT-5.00\nLRefunds\n^\n';
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING]));
        const created = plan.accountsToCreate.find((a) => a.reason === 'category');
        expect(created).toMatchObject({ path: 'Income:Refunds', accountType: 'INCOME' });
    });

    it('honors category mapping overrides', () => {
        const parsed = parseQif('!Type:Bank\nD01/15/2026\nT-20.00\nLTakeout\n^\n', { dateFormat: 'us' });
        const plan = planQifImport(
            parsed,
            makeOptions({ categoryMappings: { Takeout: DINING.guid } }),
            makeContext([CHECKING, DINING])
        );
        expect(plan.categoryMappings[0]).toMatchObject({ guid: DINING.guid, isNew: false });
        expect(plan.accountsToCreate.filter((a) => a.reason === 'category')).toHaveLength(0);
    });
});

describe('planQifImport — balanced split construction', () => {
    it('creates a balanced two-split transaction', () => {
        const parsed = parseQif('!Type:Bank\nD01/15/2026\nT-42.50\nPStore\nC*\nLFood:Dining\n^\n', {
            dateFormat: 'us',
        });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, DINING]));
        expect(plan.transactions).toHaveLength(1);
        const t = plan.transactions[0];
        expect(t.splits).toHaveLength(2);
        expect(t.splits[0].amount).toBe(-42.5);
        expect(t.splits[0].reconcile).toBe('c');
        expect(t.splits[1].amount).toBe(42.5);
        expect(t.splits.reduce((s, x) => s + x.amount, 0)).toBe(0);
    });

    it('builds one split per QIF split record, all balancing', () => {
        const qif =
            '!Type:Bank\nD01/15/2026\nT-100.00\nPBig Store\nSFood:Dining\n$-60.00\nSPet Supplies\n$-40.00\n^\n';
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, DINING]));
        const t = plan.transactions[0];
        expect(t.splits).toHaveLength(3);
        expect(t.splits[0].amount).toBe(-100);
        expect(t.splits.slice(1).map((s) => s.amount).sort()).toEqual([40, 60]);
        expect(t.splits.reduce((s, x) => s + x.amount, 0)).toBe(0);
    });

    it('posts unbalanced split remainders to Imbalance with a warning', () => {
        const qif = '!Type:Bank\nD01/15/2026\nT-100.00\nSFood:Dining\n$-60.00\n^\n';
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, DINING]));
        const t = plan.transactions[0];
        expect(t.splits.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0, 6);
        expect(plan.warnings.some((w) => w.includes('Imbalance'))).toBe(true);
        expect(plan.accountsToCreate.some((a) => a.reason === 'imbalance')).toBe(true);
    });

    it('routes uncategorized transactions to Imbalance', () => {
        const parsed = parseQif('!Type:Bank\nD01/15/2026\nT-9.99\nPMystery\n^\n', { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING]));
        const created = plan.accountsToCreate.find((a) => a.reason === 'imbalance');
        expect(created).toMatchObject({ path: 'Imbalance-USD' });
    });
});

describe('planQifImport — transfer pair dedup', () => {
    const twoAccountTransfer = [
        '!Account',
        'NChecking',
        'TBank',
        '^',
        '!Type:Bank',
        'D01/15/2026',
        'T-500.00',
        'PTransfer to savings',
        'L[Savings]',
        '^',
        '!Account',
        'NSavings',
        'TBank',
        '^',
        '!Type:Bank',
        'D01/15/2026',
        'T500.00',
        'PTransfer to savings',
        'CX',
        'L[Checking]',
        '^',
    ].join('\n');

    it('creates ONE transaction per transfer pair and dedupes the mirror', () => {
        const parsed = parseQif(twoAccountTransfer, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, SAVINGS]));
        expect(plan.transactions).toHaveLength(1);
        expect(plan.transferPairsDeduped).toBe(1);
        const t = plan.transactions[0];
        expect(t.splits).toHaveLength(2);
        expect(t.splits[0]).toMatchObject({ account: { kind: 'existing', guid: CHECKING.guid }, amount: -500 });
        expect(t.splits[1]).toMatchObject({ account: { kind: 'existing', guid: SAVINGS.guid }, amount: 500 });
        // The skipped mirror donates its cleared flag to the counterpart split
        expect(t.splits[1].reconcile).toBe('y');
    });

    it('does not dedupe two same-day same-amount transfers in the same direction', () => {
        const qif = [
            '!Account',
            'NChecking',
            'TBank',
            '^',
            '!Type:Bank',
            'D01/15/2026',
            'T-100.00',
            'L[Savings]',
            '^',
            'D01/15/2026',
            'T-100.00',
            'L[Savings]',
            '^',
            '!Account',
            'NSavings',
            'TBank',
            '^',
            '!Type:Bank',
            'D01/15/2026',
            'T100.00',
            'L[Checking]',
            '^',
            'D01/15/2026',
            'T100.00',
            'L[Checking]',
            '^',
        ].join('\n');
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, SAVINGS]));
        expect(plan.transactions).toHaveLength(2);
        expect(plan.transferPairsDeduped).toBe(2);
    });

    it('keeps one-sided transfers (target not in the file) as normal transactions', () => {
        const qif = '!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-500.00\nL[Savings]\n^\n';
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING, SAVINGS]));
        expect(plan.transactions).toHaveLength(1);
        expect(plan.transferPairsDeduped).toBe(0);
        expect(plan.transactions[0].splits[1].account).toEqual({ kind: 'existing', guid: SAVINGS.guid });
    });

    it('maps self-transfers ([Checking] inside Checking) to Equity:Opening Balances', () => {
        const qif =
            '!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/01/2026\nT1000.00\nPOpening Balance\nL[Checking]\n^\n';
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(parsed, makeOptions(), makeContext([CHECKING]));
        expect(plan.transactions).toHaveLength(1);
        const created = plan.accountsToCreate.find((a) => a.reason === 'equity');
        expect(created).toMatchObject({ path: 'Equity:Opening Balances', accountType: 'EQUITY' });
    });
});

describe('planQifImport — duplicate detection', () => {
    const qif =
        '!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-42.50\nPGrocery Store\nLFood:Dining\n^\nD01/16/2026\nT-10.00\nPCoffee\nLFood:Dining\n^\n';

    it('skips transactions that already exist (same date + amount + description)', () => {
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(
            parsed,
            makeOptions(),
            makeContext(
                [CHECKING, DINING],
                [
                    {
                        accountGuid: CHECKING.guid,
                        date: '2026-01-15',
                        amount: -42.5,
                        description: '  grocery STORE ', // normalized comparison
                    },
                ]
            )
        );
        expect(plan.transactions).toHaveLength(1);
        expect(plan.transactions[0].description).toBe('Coffee');
        expect(plan.skippedDuplicates).toHaveLength(1);
        expect(plan.skippedDuplicates[0]).toMatchObject({ date: '2026-01-15', amount: -42.5 });
    });

    it('does not skip when the amount differs', () => {
        const parsed = parseQif(qif, { dateFormat: 'us' });
        const plan = planQifImport(
            parsed,
            makeOptions(),
            makeContext(
                [CHECKING, DINING],
                [{ accountGuid: CHECKING.guid, date: '2026-01-15', amount: -42.51, description: 'Grocery Store' }]
            )
        );
        expect(plan.transactions).toHaveLength(2);
        expect(plan.skippedDuplicates).toHaveLength(0);
    });

    it('skips only as many duplicates as exist in the ledger', () => {
        const dupQif =
            '!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-5.00\nPTwin\n^\nD01/15/2026\nT-5.00\nPTwin\n^\n';
        const parsed = parseQif(dupQif, { dateFormat: 'us' });
        const plan = planQifImport(
            parsed,
            makeOptions(),
            makeContext(
                [CHECKING],
                [{ accountGuid: CHECKING.guid, date: '2026-01-15', amount: -5, description: 'Twin' }]
            )
        );
        expect(plan.skippedDuplicates).toHaveLength(1);
        expect(plan.transactions).toHaveLength(1);
    });

    it('never dup-checks against accounts that will be created', () => {
        const parsed = parseQif('!Account\nNNew Acct\nTBank\n^\n!Type:Bank\nD01/15/2026\nT-5.00\nPX\n^\n', {
            dateFormat: 'us',
        });
        const plan = planQifImport(
            parsed,
            makeOptions(),
            makeContext([], [{ accountGuid: 'whatever', date: '2026-01-15', amount: -5, description: 'X' }])
        );
        expect(plan.skippedDuplicates).toHaveLength(0);
        expect(plan.transactions).toHaveLength(1);
    });
});
