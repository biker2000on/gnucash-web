import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
        accounts: { findMany: vi.fn() },
    },
}));

import {
    assembleEmergencyPackage,
    EMPTY_SECTIONS,
    type AccountEmergencyInfo,
    type EmergencyAccountRow,
    type BookEmergencySections,
} from '@/lib/emergency-info';

const ASOF = new Date(2026, 6, 12); // 2026-07-12

const ROOT_GUID = 'r'.repeat(32);

function row(over: Partial<EmergencyAccountRow> & { guid: string }): EmergencyAccountRow {
    return {
        name: over.guid.slice(0, 4),
        account_type: 'BANK',
        parent_guid: ROOT_GUID,
        hidden: 0,
        placeholder: 0,
        commodity_mnemonic: 'USD',
        commodity_namespace: 'CURRENCY',
        ...over,
    };
}

function info(accountGuid: string, over: Partial<AccountEmergencyInfo>): AccountEmergencyInfo {
    return {
        accountGuid,
        institution: null,
        beneficiary: null,
        contact: null,
        loginHint: null,
        notes: null,
        ...over,
    };
}

/**
 * Standard fixture: root -> Assets (placeholder) -> {Checking, Brokerage},
 * root -> Liabilities (placeholder) -> Visa.
 */
function fixture() {
    const accounts: EmergencyAccountRow[] = [
        row({ guid: ROOT_GUID, name: 'Root Account', account_type: 'ROOT', parent_guid: null }),
        row({ guid: 'assets'.padEnd(32, '0'), name: 'Assets', account_type: 'ASSET', placeholder: 1 }),
        row({
            guid: 'check1'.padEnd(32, '0'), name: 'Checking', account_type: 'BANK',
            parent_guid: 'assets'.padEnd(32, '0'),
        }),
        row({
            guid: 'broker'.padEnd(32, '0'), name: 'Brokerage', account_type: 'ASSET',
            parent_guid: 'assets'.padEnd(32, '0'),
        }),
        row({ guid: 'liabs1'.padEnd(32, '0'), name: 'Liabilities', account_type: 'LIABILITY', placeholder: 1 }),
        row({
            guid: 'visa11'.padEnd(32, '0'), name: 'Visa', account_type: 'CREDIT',
            parent_guid: 'liabs1'.padEnd(32, '0'),
        }),
    ];
    const values = new Map<string, number>([
        ['check1'.padEnd(32, '0'), 2500],
        ['broker'.padEnd(32, '0'), 41000],
        ['visa11'.padEnd(32, '0'), -1200],
    ]);
    return { accounts, values };
}

describe('assembleEmergencyPackage', () => {
    describe('grouping', () => {
        it('groups by top-level parent name when no metadata institution exists', () => {
            const { accounts, values } = fixture();
            const pkg = assembleEmergencyPackage({
                accounts, values, metadata: new Map(), sections: EMPTY_SECTIONS, asOf: ASOF,
            });

            expect(pkg.institutions.map(g => g.institution)).toEqual(['Assets', 'Liabilities']);
            const assetsGroup = pkg.institutions[0];
            expect(assetsGroup.accounts.map(a => a.name)).toEqual(['Brokerage', 'Checking']);
            expect(assetsGroup.subtotal).toBe(43500);
            expect(assetsGroup.accounts.every(a => a.institutionSource === 'hierarchy')).toBe(true);
        });

        it('metadata institution overrides the hierarchy grouping', () => {
            const { accounts, values } = fixture();
            const metadata = new Map([
                ['broker'.padEnd(32, '0'), info('broker'.padEnd(32, '0'), { institution: 'Fidelity' })],
                ['visa11'.padEnd(32, '0'), info('visa11'.padEnd(32, '0'), { institution: 'Chase' })],
            ]);
            const pkg = assembleEmergencyPackage({
                accounts, values, metadata, sections: EMPTY_SECTIONS, asOf: ASOF,
            });

            expect(pkg.institutions.map(g => g.institution)).toEqual(['Assets', 'Chase', 'Fidelity']);
            const fidelity = pkg.institutions.find(g => g.institution === 'Fidelity')!;
            expect(fidelity.accounts).toHaveLength(1);
            expect(fidelity.accounts[0].name).toBe('Brokerage');
            expect(fidelity.accounts[0].institutionSource).toBe('metadata');
        });
    });

    describe('balance inclusion rules', () => {
        it('excludes hidden, placeholder, and non-emergency account types', () => {
            const { values } = fixture();
            const accounts: EmergencyAccountRow[] = [
                row({ guid: ROOT_GUID, name: 'Root', account_type: 'ROOT', parent_guid: null }),
                row({ guid: 'check1'.padEnd(32, '0'), name: 'Checking' }),
                row({ guid: 'hidden'.padEnd(32, '0'), name: 'Hidden', hidden: 1 }),
                row({ guid: 'placeh'.padEnd(32, '0'), name: 'Placeholder', placeholder: 1 }),
                row({ guid: 'grocer'.padEnd(32, '0'), name: 'Groceries', account_type: 'EXPENSE' }),
                row({ guid: 'salary'.padEnd(32, '0'), name: 'Salary', account_type: 'INCOME' }),
            ];
            const pkg = assembleEmergencyPackage({
                accounts,
                values: new Map([...values, ['hidden'.padEnd(32, '0'), 999], ['grocer'.padEnd(32, '0'), 50]]),
                metadata: new Map(),
                sections: EMPTY_SECTIONS,
                asOf: ASOF,
            });
            expect(pkg.accounts.map(a => a.name)).toEqual(['Checking']);
        });

        it('excludes zero-balance accounts without metadata from the printed package', () => {
            const accounts = [
                row({ guid: ROOT_GUID, name: 'Root', account_type: 'ROOT', parent_guid: null }),
                row({ guid: 'check1'.padEnd(32, '0'), name: 'Checking' }),
                row({ guid: 'closed'.padEnd(32, '0'), name: 'Old Savings' }),
            ];
            const pkg = assembleEmergencyPackage({
                accounts,
                values: new Map([['check1'.padEnd(32, '0'), 100]]),
                metadata: new Map(),
                sections: EMPTY_SECTIONS,
                asOf: ASOF,
            });

            const closed = pkg.accounts.find(a => a.name === 'Old Savings')!;
            expect(closed.included).toBe(false);
            // ...but the account is still available for the edit view.
            expect(pkg.accounts).toHaveLength(2);
            expect(pkg.institutions.flatMap(g => g.accounts).map(a => a.name)).toEqual(['Checking']);
        });

        it('includes zero-balance accounts that carry emergency metadata', () => {
            const guid = 'closed'.padEnd(32, '0');
            const accounts = [
                row({ guid: ROOT_GUID, name: 'Root', account_type: 'ROOT', parent_guid: null }),
                row({ guid, name: 'Old Savings' }),
            ];
            const pkg = assembleEmergencyPackage({
                accounts,
                values: new Map(),
                metadata: new Map([[guid, info(guid, { beneficiary: 'Jane Doe (TOD)' })]]),
                sections: EMPTY_SECTIONS,
                asOf: ASOF,
            });
            expect(pkg.accounts[0].included).toBe(true);
            expect(pkg.institutions.flatMap(g => g.accounts).map(a => a.name)).toEqual(['Old Savings']);
        });

        it('splits totals into assets and liabilities', () => {
            const { accounts, values } = fixture();
            const pkg = assembleEmergencyPackage({
                accounts, values, metadata: new Map(), sections: EMPTY_SECTIONS, asOf: ASOF,
            });
            expect(pkg.totals.assets).toBe(43500);
            expect(pkg.totals.liabilities).toBe(-1200);
            expect(pkg.totals.net).toBe(42300);
        });
    });

    describe('metadata merge', () => {
        it('merges every metadata field onto the account entry', () => {
            const { accounts, values } = fixture();
            const guid = 'check1'.padEnd(32, '0');
            const metadata = new Map([[guid, info(guid, {
                institution: 'Ally Bank',
                beneficiary: 'Jane Doe (POD)',
                contact: 'Support 1-877-247-2559',
                loginHint: '1Password — Shared vault',
                notes: 'Direct deposit lands here.',
            })]]);

            const pkg = assembleEmergencyPackage({
                accounts, values, metadata, sections: EMPTY_SECTIONS, asOf: ASOF,
            });
            const entry = pkg.accounts.find(a => a.guid === guid)!;
            expect(entry.institution).toBe('Ally Bank');
            expect(entry.beneficiary).toBe('Jane Doe (POD)');
            expect(entry.contact).toBe('Support 1-877-247-2559');
            expect(entry.loginHint).toBe('1Password — Shared vault');
            expect(entry.notes).toBe('Direct deposit lands here.');
            expect(entry.balance).toBe(2500);
            expect(entry.currency).toBe('USD');
            expect(entry.path).toBe('Assets:Checking');
        });

        it('leaves metadata fields null for accounts without stored info', () => {
            const { accounts, values } = fixture();
            const pkg = assembleEmergencyPackage({
                accounts, values, metadata: new Map(), sections: EMPTY_SECTIONS, asOf: ASOF,
            });
            const entry = pkg.accounts.find(a => a.name === 'Checking')!;
            expect(entry.beneficiary).toBeNull();
            expect(entry.contact).toBeNull();
            expect(entry.loginHint).toBeNull();
            expect(entry.notes).toBeNull();
        });

        it('passes book-level sections through untouched', () => {
            const { accounts, values } = fixture();
            const sections: BookEmergencySections = {
                executor: 'John Smith, brother',
                attorney: 'Law Office of X',
                insurance: 'Term life: Banner, policy #123',
                instructions: 'Call the executor first.',
            };
            const pkg = assembleEmergencyPackage({
                accounts, values, metadata: new Map(), sections, asOf: ASOF,
            });
            expect(pkg.sections).toEqual(sections);
            expect(pkg.asOf).toBe(ASOF.toISOString());
        });
    });
});
