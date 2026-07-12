import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}));

import {
    csvEscape,
    contributionSummaryToCSV,
    scheduleCToCSV,
    charitableGivingToCSV,
    buildManifest,
} from '../reports/tax-package';
import { isCharitableAccountName } from '../reports/charitable-giving';
import type { ContributionSummaryData } from '../reports/types';
import { ReportType } from '../reports/types';
import type { ScheduleCReport } from '../business/business-reports';
import type { CharitableGivingReport } from '../reports/charitable-giving';

describe('csvEscape', () => {
    it('passes plain values through', () => {
        expect(csvEscape('hello')).toBe('hello');
        expect(csvEscape(42)).toBe('42');
    });
    it('quotes commas, quotes, and newlines', () => {
        expect(csvEscape('a,b')).toBe('"a,b"');
        expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
        expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    });
    it('renders null/undefined as empty', () => {
        expect(csvEscape(null)).toBe('');
        expect(csvEscape(undefined)).toBe('');
    });
});

describe('contributionSummaryToCSV', () => {
    const data: ContributionSummaryData = {
        type: ReportType.CONTRIBUTION_SUMMARY,
        title: 'Contribution Summary',
        generatedAt: '2026-01-01T00:00:00Z',
        filters: { startDate: null, endDate: null },
        groupBy: 'tax_year',
        periods: [
            {
                year: 2025,
                accounts: [
                    {
                        accountGuid: 'g1',
                        accountName: '401k',
                        accountPath: 'Assets:Retirement:401k',
                        retirementAccountType: '401k',
                        contributions: 23000,
                        employerMatch: 5000,
                        incomeContributions: 100,
                        transfers: 0,
                        withdrawals: 0,
                        fees: 0,
                        netContributions: 28100,
                        irsLimit: { base: 23500, catchUp: 0, total: 23500, percentUsed: 97.9 },
                        transactions: [],
                    },
                ],
                byAccountType: {},
                totalContributions: 23000,
                totalIncomeContributions: 100,
                totalEmployerMatch: 5000,
                totalTransfers: 0,
                totalWithdrawals: 0,
                totalFees: 0,
                totalNetContributions: 28100,
            },
            {
                year: 2024,
                accounts: [],
                byAccountType: {},
                totalContributions: 1,
                totalIncomeContributions: 0,
                totalEmployerMatch: 0,
                totalTransfers: 0,
                totalWithdrawals: 0,
                totalFees: 0,
                totalNetContributions: 1,
            },
        ],
        grandTotalContributions: 23001,
        grandTotalIncomeContributions: 100,
        grandTotalEmployerMatch: 5000,
        grandTotalTransfers: 0,
        grandTotalNetContributions: 28101,
    };

    it('includes only the requested year with account rows and a TOTAL row', () => {
        const csv = contributionSummaryToCSV(data, 2025);
        expect(csv).toContain('Assets:Retirement:401k');
        expect(csv).toContain('23000.00');
        expect(csv).toContain('TOTAL');
        expect(csv).toContain('23500.00'); // IRS limit total
        expect(csv).toContain('98%');      // limit used
        // The 2024 period must not leak in
        const totalRows = csv.split('\r\n').filter(l => l.includes('TOTAL'));
        expect(totalRows).toHaveLength(1);
    });
});

describe('scheduleCToCSV', () => {
    const report: ScheduleCReport = {
        year: 2025,
        grossReceipts: 50000,
        incomeAccounts: [],
        lines: [
            { line: '8', label: 'Advertising', amount: 1200, deductible: 1200, accounts: [] },
            { line: '24b', label: 'Meals', amount: 400, deductible: 200, accounts: [] },
            { line: '22', label: 'Supplies', amount: 0, deductible: 0, accounts: [] },
        ],
        totalExpenses: 1400,
        netProfit: 48600,
        unmappedCount: 0,
        overriddenCount: 1,
    };

    it('renders income, non-zero lines, totals, and skips zero lines', () => {
        const csv = scheduleCToCSV(report);
        expect(csv).toContain('Gross receipts or sales,50000.00');
        expect(csv).toContain('Advertising,1200.00,1200.00');
        expect(csv).toContain('Meals,400.00,200.00'); // 50% meals
        expect(csv).not.toContain('Supplies');
        expect(csv).toContain('Net profit or (loss),48600.00');
    });
});

describe('charitableGivingToCSV', () => {
    const report: CharitableGivingReport = {
        year: 2025,
        accounts: [
            {
                accountGuid: 'g1',
                accountName: 'Donations',
                accountPath: 'Expenses:Donations',
                total: 550,
                donations: [
                    { date: '2025-03-01', payee: 'Red Cross', memo: '', amount: 300 },
                    { date: '2025-06-15', payee: 'Food Bank, Local', memo: 'annual', amount: 250 },
                ],
            },
        ],
        grandTotal: 550,
        largeDonationCount: 2,
    };

    it('renders donation rows and total, escaping commas', () => {
        const csv = charitableGivingToCSV(report);
        expect(csv).toContain('2025-03-01,Red Cross,Expenses:Donations,,300.00');
        expect(csv).toContain('"Food Bank, Local"');
        expect(csv).toContain('TOTAL,550.00');
    });
});

describe('isCharitableAccountName', () => {
    it('matches common charitable account names', () => {
        for (const name of [
            'Expenses:Donations',
            'Expenses:Charity',
            'Expenses:Charitable Giving',
            'Expenses:Tithing',
            'Expenses:Church Offering',
            'Expenses:Non-Profit Support',
        ]) {
            expect(isCharitableAccountName(name)).toBe(true);
        }
    });
    it('does not match ordinary expenses', () => {
        for (const name of ['Expenses:Groceries', 'Expenses:Auto:Gas', 'Expenses:Dining']) {
            expect(isCharitableAccountName(name)).toBe(false);
        }
    });
});

describe('buildManifest', () => {
    it('lists files and notes', () => {
        const text = buildManifest({
            year: 2025,
            generatedAt: '2026-01-15T12:00:00Z',
            files: [{ name: 'a.csv', description: 'the a file' }],
            notes: ['note one'],
        });
        expect(text).toContain('Tax Package for 2025');
        expect(text).toContain('a.csv: the a file');
        expect(text).toContain('* note one');
        expect(text).toContain('Verify against official forms');
    });
});
