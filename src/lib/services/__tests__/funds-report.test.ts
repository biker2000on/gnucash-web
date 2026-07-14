import { describe, it, expect, vi } from 'vitest';

// funds.service imports prisma + book-scope; buildFundReport is pure.
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => []) }));

import {
    buildFundReport,
    isFundRestriction,
    FundForReport,
    FundAccountActivityRow,
} from '../funds.service';

const DATES = { startDate: '2026-01-01', endDate: '2026-12-31' };

function fund(id: number, name: string, overrides: Partial<FundForReport> = {}): FundForReport {
    return { id, name, restriction: 'unrestricted', active: true, sortOrder: 0, ...overrides };
}

describe('isFundRestriction', () => {
    it('accepts the three valid restriction classes', () => {
        expect(isFundRestriction('unrestricted')).toBe(true);
        expect(isFundRestriction('temporarily_restricted')).toBe(true);
        expect(isFundRestriction('permanently_restricted')).toBe(true);
    });

    it('rejects anything else', () => {
        expect(isFundRestriction('restricted')).toBe(false);
        expect(isFundRestriction('')).toBe(false);
        expect(isFundRestriction(null)).toBe(false);
    });
});

describe('buildFundReport', () => {
    it('sign-corrects income positive and buckets by fund assignment', () => {
        const funds = [fund(1, 'Building Fund', { restriction: 'temporarily_restricted' })];
        const assignments = new Map([
            ['inc-donations', 1],
            ['exp-maintenance', 1],
        ]);
        const activity: FundAccountActivityRow[] = [
            // GnuCash raw: income credits negative, expenses debits positive
            { accountGuid: 'inc-donations', accountType: 'INCOME', periodSum: -5000, toDateSum: -12000 },
            { accountGuid: 'exp-maintenance', accountType: 'EXPENSE', periodSum: 1800, toDateSum: 4000 },
        ];

        const report = buildFundReport(funds, assignments, activity, DATES);
        const row = report.rows.find((r) => r.fundId === 1)!;

        expect(row.income).toBe(5000);
        expect(row.expense).toBe(1800);
        expect(row.net).toBe(3200);
        // Net assets to date: 12000 income - 4000 expense (both negated raw)
        expect(row.netAssets).toBe(8000);
        expect(row.restriction).toBe('temporarily_restricted');
        expect(row.accountCount).toBe(2);
    });

    it('puts unassigned income/expense accounts into the Unassigned bucket', () => {
        const funds = [fund(1, 'Scholarships')];
        const assignments = new Map([['inc-grants', 1]]);
        const activity: FundAccountActivityRow[] = [
            { accountGuid: 'inc-grants', accountType: 'INCOME', periodSum: -1000, toDateSum: -1000 },
            { accountGuid: 'inc-general', accountType: 'INCOME', periodSum: -250, toDateSum: -900 },
            { accountGuid: 'exp-office', accountType: 'EXPENSE', periodSum: 100, toDateSum: 300 },
        ];

        const report = buildFundReport(funds, assignments, activity, DATES);
        const unassigned = report.rows.find((r) => r.fundId === null)!;

        expect(unassigned.name).toBe('Unassigned');
        expect(unassigned.income).toBe(250);
        expect(unassigned.expense).toBe(100);
        expect(unassigned.net).toBe(150);
        expect(unassigned.netAssets).toBe(600);
        expect(unassigned.accountCount).toBe(2);
    });

    it('omits the Unassigned bucket when everything is assigned', () => {
        const funds = [fund(1, 'General')];
        const assignments = new Map([['inc-a', 1]]);
        const activity: FundAccountActivityRow[] = [
            { accountGuid: 'inc-a', accountType: 'INCOME', periodSum: -10, toDateSum: -10 },
        ];
        const report = buildFundReport(funds, assignments, activity, DATES);
        expect(report.rows.some((r) => r.fundId === null)).toBe(false);
    });

    it('uses natural-balance signs for net assets of balance-sheet accounts', () => {
        // A fund tracked via a dedicated bank account (debit-natural, positive)
        // and a small liability (credit-natural raw negative).
        const funds = [fund(1, 'Endowment', { restriction: 'permanently_restricted' })];
        const assignments = new Map([
            ['bank-endowment', 1],
            ['liab-endowment', 1],
        ]);
        const activity: FundAccountActivityRow[] = [
            { accountGuid: 'bank-endowment', accountType: 'BANK', periodSum: 0, toDateSum: 50000 },
            { accountGuid: 'liab-endowment', accountType: 'LIABILITY', periodSum: 0, toDateSum: -2000 },
        ];

        const report = buildFundReport(funds, assignments, activity, DATES);
        const row = report.rows.find((r) => r.fundId === 1)!;
        expect(row.netAssets).toBe(48000);
        // No income/expense accounts assigned → period columns stay zero.
        expect(row.income).toBe(0);
        expect(row.expense).toBe(0);
    });

    it('keeps funds with no activity visible when active, hides dead inactive funds', () => {
        const funds = [
            fund(1, 'Active Empty'),
            fund(2, 'Inactive Empty', { active: false }),
        ];
        const report = buildFundReport(funds, new Map(), [], DATES);
        expect(report.rows.map((r) => r.name)).toEqual(['Active Empty']);
    });

    it('orders funds by sort_order then name and totals across rows', () => {
        const funds = [
            fund(1, 'Zebra', { sortOrder: 1 }),
            fund(2, 'Alpha', { sortOrder: 1 }),
            fund(3, 'First', { sortOrder: 0 }),
        ];
        const assignments = new Map([
            ['inc-1', 1],
            ['inc-2', 2],
            ['inc-3', 3],
        ]);
        const activity: FundAccountActivityRow[] = [
            { accountGuid: 'inc-1', accountType: 'INCOME', periodSum: -1, toDateSum: -1 },
            { accountGuid: 'inc-2', accountType: 'INCOME', periodSum: -2, toDateSum: -2 },
            { accountGuid: 'inc-3', accountType: 'INCOME', periodSum: -3, toDateSum: -3 },
        ];

        const report = buildFundReport(funds, assignments, activity, DATES);
        expect(report.rows.map((r) => r.name)).toEqual(['First', 'Alpha', 'Zebra']);
        expect(report.totals.income).toBe(6);
        expect(report.totals.net).toBe(6);
        expect(report.totals.netAssets).toBe(6);
    });

    it('rounds noisy float sums to cents', () => {
        const funds = [fund(1, 'General')];
        const assignments = new Map([['inc-a', 1]]);
        const activity: FundAccountActivityRow[] = [
            { accountGuid: 'inc-a', accountType: 'INCOME', periodSum: -0.1 - 0.2, toDateSum: -0.1 - 0.2 },
        ];
        const report = buildFundReport(funds, assignments, activity, DATES);
        expect(report.rows[0].income).toBe(0.3);
        expect(report.rows[0].netAssets).toBe(0.3);
    });
});
