import { describe, it, expect } from 'vitest';
import {
    buildPersonalPlan,
    defaultCategoryPath,
    defaultSourceAccountType,
    detectHeaderRow,
    isSimilarDescription,
    normalizeDescription,
    suggestCategoryAccount,
    suggestSourceAccount,
    UNCATEGORIZED,
    type BookAccount,
    type ExistingTransactionKey,
    type PersonalRecord,
} from '../personal-import';

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const ACCOUNTS: BookAccount[] = [
    { guid: 'g-checking', name: 'Chase Checking', fullname: 'Assets:Chase Checking', accountType: 'BANK' },
    { guid: 'g-savings', name: 'Savings', fullname: 'Assets:Savings', accountType: 'BANK' },
    { guid: 'g-visa', name: 'Visa', fullname: 'Liabilities:Visa', accountType: 'CREDIT' },
    { guid: 'g-assets', name: 'Assets', fullname: 'Assets', accountType: 'ASSET', placeholder: true },
    { guid: 'g-groceries', name: 'Groceries', fullname: 'Expenses:Food:Groceries', accountType: 'EXPENSE' },
    { guid: 'g-dining', name: 'Dining', fullname: 'Expenses:Food:Dining', accountType: 'EXPENSE' },
    { guid: 'g-salary', name: 'Salary', fullname: 'Income:Salary', accountType: 'INCOME' },
    { guid: 'g-exp', name: 'Expenses', fullname: 'Expenses', accountType: 'EXPENSE', placeholder: true },
];

function rec(overrides: Partial<PersonalRecord>): PersonalRecord {
    return {
        date: '2025-01-15',
        description: 'Grocery Store',
        memo: '',
        amount: -50,
        category: 'Groceries',
        account: 'Chase Checking',
        row: 2,
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/* detectHeaderRow                                                      */
/* ------------------------------------------------------------------ */

describe('detectHeaderRow', () => {
    const specs = [
        { key: 'date', names: ['date'], required: true },
        { key: 'amount', names: ['amount'], required: true },
        { key: 'notes', names: ['notes'] },
    ];

    it('skips preamble rows and matches case-insensitively', () => {
        const rows = [
            ['My export', ''],
            [''],
            ['DATE', 'Amount (USD)', 'Notes'],
            ['01/01/2025', '5.00', ''],
        ];
        const hit = detectHeaderRow(rows, specs);
        expect(hit).not.toBeNull();
        expect(hit!.headerIdx).toBe(2);
        expect(hit!.cols).toEqual({ date: 0, amount: 1, notes: 2 });
    });

    it('returns null when a required column never appears', () => {
        expect(detectHeaderRow([['date', 'stuff']], specs)).toBeNull();
    });

    it('marks missing optional columns with -1', () => {
        const hit = detectHeaderRow([['date', 'amount']], specs);
        expect(hit!.cols.notes).toBe(-1);
    });
});

/* ------------------------------------------------------------------ */
/* Description similarity                                               */
/* ------------------------------------------------------------------ */

describe('normalizeDescription / isSimilarDescription', () => {
    it('normalizes case, punctuation, and whitespace', () => {
        expect(normalizeDescription('  GROCERY   Store #123! ')).toBe('grocery store 123');
    });

    it('matches equal and containing descriptions', () => {
        expect(isSimilarDescription('Grocery Store', 'GROCERY STORE')).toBe(true);
        expect(isSimilarDescription('Grocery Store', 'Grocery Store #123')).toBe(true);
        expect(isSimilarDescription('POS DEBIT Grocery Store', 'Grocery Store')).toBe(true);
        expect(isSimilarDescription('Rent', 'Groceries')).toBe(false);
    });

    it('requires substance for containment matches', () => {
        expect(isSimilarDescription('a', 'a very long description')).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* Suggestions                                                          */
/* ------------------------------------------------------------------ */

describe('suggestSourceAccount', () => {
    it('matches exact leaf names on bank-type accounts', () => {
        expect(suggestSourceAccount('Chase Checking', ACCOUNTS)?.guid).toBe('g-checking');
        expect(suggestSourceAccount('visa', ACCOUNTS)?.guid).toBe('g-visa');
    });

    it('matches full paths and unique substrings', () => {
        expect(suggestSourceAccount('Assets:Savings', ACCOUNTS)?.guid).toBe('g-savings');
        expect(suggestSourceAccount('Chase Checking (...1234)', ACCOUNTS)?.guid).toBe('g-checking');
    });

    it('never suggests income/expense accounts and returns null when unknown', () => {
        expect(suggestSourceAccount('Groceries', ACCOUNTS)).toBeNull();
        expect(suggestSourceAccount('Some New Bank', ACCOUNTS)).toBeNull();
        expect(suggestSourceAccount('', ACCOUNTS)).toBeNull();
    });
});

describe('suggestCategoryAccount', () => {
    it('matches leaf names among income/expense accounts', () => {
        expect(suggestCategoryAccount('Groceries', ACCOUNTS)?.guid).toBe('g-groceries');
        expect(suggestCategoryAccount('salary', ACCOUNTS)?.guid).toBe('g-salary');
    });

    it('matches path suffixes ("Food: Dining" → Expenses:Food:Dining)', () => {
        expect(suggestCategoryAccount('Food:Dining', ACCOUNTS)?.guid).toBe('g-dining');
        expect(suggestCategoryAccount('Food: Dining', ACCOUNTS)?.guid).toBe('g-dining');
    });

    it('matches the leaf of "Group: Category" labels', () => {
        expect(suggestCategoryAccount('Everyday Expenses: Groceries', ACCOUNTS)?.guid).toBe('g-groceries');
    });

    it('returns null for unknown categories (they default to Imported)', () => {
        expect(suggestCategoryAccount('Underwater Basket Weaving', ACCOUNTS)).toBeNull();
    });
});

describe('defaults', () => {
    it('defaultSourceAccountType detects credit cards', () => {
        expect(defaultSourceAccountType('Chase Freedom Card')).toBe('CREDIT');
        expect(defaultSourceAccountType('Amex Platinum')).toBe('CREDIT');
        expect(defaultSourceAccountType('My Checking')).toBe('BANK');
    });

    it('defaultCategoryPath nests under Imported and honors inflow majority', () => {
        expect(defaultCategoryPath('Coffee Shops', false)).toEqual({
            path: 'Expenses:Imported:Coffee Shops',
            accountType: 'EXPENSE',
        });
        expect(defaultCategoryPath('Paycheck', true)).toEqual({
            path: 'Income:Imported:Paycheck',
            accountType: 'INCOME',
        });
        expect(defaultCategoryPath('Group: Cat', false).path).toBe('Expenses:Imported:Group:Cat');
        expect(defaultCategoryPath('', false).path).toBe(`Expenses:Imported:${UNCATEGORIZED}`);
    });
});

/* ------------------------------------------------------------------ */
/* Plan building                                                        */
/* ------------------------------------------------------------------ */

describe('buildPersonalPlan', () => {
    it('builds two-split transactions with the category split negated', () => {
        const plan = buildPersonalPlan([rec({})], ACCOUNTS, []);
        expect(plan.transactions).toHaveLength(1);
        const [bankSplit, catSplit] = plan.transactions[0].splits;
        expect(bankSplit).toMatchObject({ account: { kind: 'existing', guid: 'g-checking' }, amount: -50 });
        expect(catSplit).toMatchObject({ account: { kind: 'existing', guid: 'g-groceries' }, amount: 50 });
    });

    it('routes income records with positive bank split and negative income split', () => {
        const plan = buildPersonalPlan(
            [rec({ description: 'Paycheck', amount: 2500, category: 'Salary' })],
            ACCOUNTS,
            []
        );
        const [bankSplit, catSplit] = plan.transactions[0].splits;
        expect(bankSplit.amount).toBe(2500);
        expect(catSplit).toMatchObject({ account: { guid: 'g-salary' }, amount: -2500 });
    });

    it('creates new source accounts and Imported categories when nothing matches', () => {
        const plan = buildPersonalPlan(
            [rec({ account: 'Ally Savings 9999', category: 'Basket Weaving' })],
            ACCOUNTS,
            []
        );
        expect(plan.accountsToCreate).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'Ally Savings 9999', accountType: 'BANK', reason: 'source' }),
                expect.objectContaining({
                    path: 'Expenses:Imported:Basket Weaving',
                    accountType: 'EXPENSE',
                    reason: 'category',
                }),
            ])
        );
        expect(plan.sourceAccounts[0].isNew).toBe(true);
        expect(plan.categories[0].isNew).toBe(true);
    });

    it('groups blank categories under Uncategorized', () => {
        const plan = buildPersonalPlan([rec({ category: '' }), rec({ category: '  ', row: 3 })], ACCOUNTS, []);
        expect(plan.categories).toHaveLength(1);
        expect(plan.categories[0].name).toBe(UNCATEGORIZED);
        expect(plan.categories[0].records).toBe(2);
    });

    it('honors explicit account and category mappings', () => {
        const plan = buildPersonalPlan([rec({})], ACCOUNTS, [], {
            accountMappings: { 'Chase Checking': 'g-visa' },
            categoryMappings: { Groceries: 'g-dining' },
        });
        const [bankSplit, catSplit] = plan.transactions[0].splits;
        expect(bankSplit.account).toEqual({ kind: 'existing', guid: 'g-visa' });
        expect(catSplit.account).toEqual({ kind: 'existing', guid: 'g-dining' });
        expect(plan.sourceAccounts[0].mapped).toBe(true);
        expect(plan.categories[0].mapped).toBe(true);
    });

    it('supports forced creation via new:BANK / new:CREDIT / new mappings', () => {
        const plan = buildPersonalPlan([rec({})], ACCOUNTS, [], {
            accountMappings: { 'Chase Checking': 'new:CREDIT' },
            categoryMappings: { Groceries: 'new' },
        });
        expect(plan.sourceAccounts[0]).toMatchObject({ isNew: true, accountType: 'CREDIT' });
        expect(plan.categories[0]).toMatchObject({ isNew: true, path: 'Expenses:Imported:Groceries' });
    });

    it('rejects mappings pointing at the wrong account class with a warning', () => {
        const plan = buildPersonalPlan([rec({})], ACCOUNTS, [], {
            accountMappings: { 'Chase Checking': 'g-groceries' }, // expense as bank target
            categoryMappings: { Groceries: 'g-checking' }, // bank as category target
        });
        expect(plan.warnings).toHaveLength(2);
        // Falls back to auto-suggestion
        expect(plan.sourceAccounts[0].target).toEqual({ kind: 'existing', guid: 'g-checking' });
        expect(plan.categories[0].target).toEqual({ kind: 'existing', guid: 'g-groceries' });
    });

    describe('duplicate detection', () => {
        const existing: ExistingTransactionKey[] = [
            { accountGuid: 'g-checking', date: '2025-01-15', amount: -50, description: 'GROCERY STORE #123' },
        ];

        it('skips records matching account + date + amount + similar description', () => {
            const plan = buildPersonalPlan([rec({})], ACCOUNTS, existing);
            expect(plan.transactions).toHaveLength(0);
            expect(plan.duplicates).toHaveLength(1);
            expect(plan.duplicates[0]).toMatchObject({ date: '2025-01-15', amount: -50 });
        });

        it('does not skip when amount, date, account, or description differ', () => {
            const records = [
                rec({ amount: -51, row: 2 }),
                rec({ date: '2025-01-16', row: 3 }),
                rec({ account: 'Savings', row: 4 }),
                rec({ description: 'Completely Different Payee', row: 5 }),
            ];
            const plan = buildPersonalPlan(records, ACCOUNTS, existing);
            expect(plan.duplicates).toHaveLength(0);
            expect(plan.transactions).toHaveLength(4);
        });

        it('uses multiset semantics: one existing row only absorbs one file row', () => {
            const plan = buildPersonalPlan([rec({}), rec({ row: 3 })], ACCOUNTS, existing);
            expect(plan.duplicates).toHaveLength(1);
            expect(plan.transactions).toHaveLength(1);
        });

        it('keeps duplicates when skipDuplicates is false (still reported)', () => {
            const plan = buildPersonalPlan([rec({})], ACCOUNTS, existing, { skipDuplicates: false });
            expect(plan.duplicates).toHaveLength(1);
            expect(plan.transactions).toHaveLength(1);
        });

        it('never flags records destined for newly created accounts', () => {
            const plan = buildPersonalPlan([rec({ account: 'Brand New Bank' })], ACCOUNTS, existing);
            expect(plan.duplicates).toHaveLength(0);
        });
    });
});
