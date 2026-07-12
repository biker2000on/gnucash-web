import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: vi.fn(),
        $queryRawUnsafe: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(async () => 0),
        books: { findUnique: vi.fn() },
        gnucash_web_users: { findUnique: vi.fn() },
        budgets: { findUnique: vi.fn(), findFirst: vi.fn() },
        splits: { findMany: vi.fn() },
        accounts: { findMany: vi.fn(), findFirst: vi.fn() },
    },
}));

vi.mock('@/lib/email', () => ({
    sendEmail: vi.fn(async () => true),
    isEmailConfigured: vi.fn(() => true),
}));

vi.mock('@/lib/reports/saved-reports', () => ({
    getSavedReport: vi.fn(),
}));

vi.mock('@/lib/reports/balance-sheet', () => ({
    generateBalanceSheet: vi.fn(),
}));

import prisma from '@/lib/prisma';
import { sendEmail, isEmailConfigured } from '@/lib/email';
import { getSavedReport } from '@/lib/reports/saved-reports';
import { generateBalanceSheet } from '@/lib/reports/balance-sheet';
import { ReportType, type ReportData } from '@/lib/reports/types';
import {
    clampAnchorDay,
    currentOccurrence,
    reportPeriodFor,
    isScheduleDue,
    dueSchedules,
    runReportSchedule,
    renderScheduleEmail,
    buildScheduleCsv,
    normalizeRecipients,
    type ReportSchedule,
} from '../report-scheduler';

const mockPrisma = vi.mocked(prisma, true);
const mockSendEmail = vi.mocked(sendEmail);
const mockIsEmailConfigured = vi.mocked(isEmailConfigured);
const mockGetSavedReport = vi.mocked(getSavedReport);
const mockGenerateBalanceSheet = vi.mocked(generateBalanceSheet);

function makeSchedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
    return {
        id: 7,
        userId: 1,
        bookGuid: 'book1',
        savedReportId: null,
        baseReportType: 'balance_sheet',
        config: {},
        cadence: 'monthly',
        anchorDay: 1,
        recipients: null,
        enabled: true,
        lastRunAt: null,
        lastRunPeriod: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

const balanceSheetData: ReportData = {
    type: ReportType.BALANCE_SHEET,
    title: 'Balance Sheet',
    generatedAt: '2026-07-12T00:00:00.000Z',
    filters: { startDate: null, endDate: '2026-06-30' },
    sections: [
        {
            title: 'Assets',
            items: [
                {
                    guid: 'a1',
                    name: 'Checking',
                    amount: 1234.56,
                    depth: 0,
                    children: [{ guid: 'a2', name: 'Sub Account', amount: 10, depth: 1 }],
                },
            ],
            total: 1244.56,
        },
        {
            title: 'Liabilities',
            items: [{ guid: 'l1', name: 'Credit Card', amount: 200, depth: 0 }],
            total: 200,
        },
    ],
    grandTotal: 1044.56,
};

function primeSentPath() {
    mockPrisma.books.findUnique.mockResolvedValue({ root_account_guid: 'root' } as never);
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { guid: 'root' },
        { guid: 'a1' },
    ]);
    mockPrisma.gnucash_web_users.findUnique.mockResolvedValue({ email: 'user@example.com' } as never);
    mockGenerateBalanceSheet.mockResolvedValue(balanceSheetData);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(true);
    mockIsEmailConfigured.mockReturnValue(true);
    (mockPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Cadence math
// ---------------------------------------------------------------------------

describe('clampAnchorDay', () => {
    it('clamps weekly to 0-6 and monthly/quarterly to 1-28', () => {
        expect(clampAnchorDay('weekly', -1)).toBe(0);
        expect(clampAnchorDay('weekly', 9)).toBe(6);
        expect(clampAnchorDay('monthly', 0)).toBe(1);
        expect(clampAnchorDay('monthly', 31)).toBe(28);
        expect(clampAnchorDay('quarterly', 15)).toBe(15);
    });
});

describe('currentOccurrence', () => {
    it('weekly: finds the most recent anchor weekday', () => {
        // 2026-07-12 is a Sunday
        expect(currentOccurrence('weekly', 1, new Date('2026-07-12T10:00:00Z'))).toBe('2026-07-06'); // last Monday
        expect(currentOccurrence('weekly', 0, new Date('2026-07-12T10:00:00Z'))).toBe('2026-07-12'); // today (Sunday)
        expect(currentOccurrence('weekly', 1, new Date('2026-07-13T00:30:00Z'))).toBe('2026-07-13'); // Monday itself
    });

    it('monthly: this month once the anchor day has passed, else previous month', () => {
        expect(currentOccurrence('monthly', 1, new Date('2026-07-12T00:00:00Z'))).toBe('2026-07-01');
        expect(currentOccurrence('monthly', 1, new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01');
        expect(currentOccurrence('monthly', 15, new Date('2026-07-12T00:00:00Z'))).toBe('2026-06-15');
        // January rolls back to December of the prior year
        expect(currentOccurrence('monthly', 15, new Date('2026-01-03T00:00:00Z'))).toBe('2025-12-15');
    });

    it('quarterly: anchored to the first month of the quarter', () => {
        expect(currentOccurrence('quarterly', 1, new Date('2026-07-12T00:00:00Z'))).toBe('2026-07-01');
        expect(currentOccurrence('quarterly', 1, new Date('2026-06-30T00:00:00Z'))).toBe('2026-04-01');
        expect(currentOccurrence('quarterly', 5, new Date('2026-01-02T00:00:00Z'))).toBe('2025-10-05');
    });
});

describe('reportPeriodFor', () => {
    it('weekly: the 7 days ending the day before the occurrence', () => {
        expect(reportPeriodFor('weekly', '2026-07-06')).toEqual({
            startDate: '2026-06-29',
            endDate: '2026-07-05',
        });
    });

    it('monthly: the previous calendar month', () => {
        expect(reportPeriodFor('monthly', '2026-07-01')).toEqual({
            startDate: '2026-06-01',
            endDate: '2026-06-30',
        });
        expect(reportPeriodFor('monthly', '2026-01-15')).toEqual({
            startDate: '2025-12-01',
            endDate: '2025-12-31',
        });
    });

    it('quarterly: the previous calendar quarter', () => {
        expect(reportPeriodFor('quarterly', '2026-07-01')).toEqual({
            startDate: '2026-04-01',
            endDate: '2026-06-30',
        });
        expect(reportPeriodFor('quarterly', '2026-01-01')).toEqual({
            startDate: '2025-10-01',
            endDate: '2025-12-31',
        });
    });
});

// ---------------------------------------------------------------------------
// Due-schedule selection
// ---------------------------------------------------------------------------

describe('isScheduleDue', () => {
    const now = new Date('2026-07-12T06:00:00Z');

    it('is due when the current occurrence has not run', () => {
        expect(isScheduleDue(makeSchedule({ lastRunPeriod: null }), now)).toBe(true);
        expect(isScheduleDue(makeSchedule({ lastRunPeriod: '2026-06-01' }), now)).toBe(true);
    });

    it('is idempotent per period: not due once this occurrence ran', () => {
        expect(isScheduleDue(makeSchedule({ lastRunPeriod: '2026-07-01' }), now)).toBe(false);
    });

    it('disabled schedules are never due', () => {
        expect(isScheduleDue(makeSchedule({ enabled: false, lastRunPeriod: null }), now)).toBe(false);
    });
});

describe('dueSchedules', () => {
    it('returns only enabled schedules whose occurrence has not run', async () => {
        const row = (id: number, extra: Record<string, unknown>) => ({
            id,
            user_id: 1,
            book_guid: 'book1',
            saved_report_id: null,
            base_report_type: 'balance_sheet',
            config: {},
            cadence: 'monthly',
            anchor_day: 1,
            recipients: null,
            enabled: true,
            last_run_at: null,
            last_run_period: null,
            created_at: new Date(),
            updated_at: new Date(),
            ...extra,
        });

        (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
            row(1, {}), // due
            row(2, { last_run_period: '2026-07-01' }), // already ran this period
            row(3, { enabled: false }), // disabled (defensive; SQL already filters)
        ]);

        const due = await dueSchedules(new Date('2026-07-12T06:00:00Z'));
        expect(due.map(s => s.id)).toEqual([1]);
    });
});

// ---------------------------------------------------------------------------
// runReportSchedule
// ---------------------------------------------------------------------------

describe('runReportSchedule', () => {
    const now = new Date('2026-07-12T06:00:00Z');

    it('sends the report, stamps last_run_period, and defaults to the owner email', async () => {
        primeSentPath();
        const schedule = makeSchedule();

        const result = await runReportSchedule(schedule, { now });

        expect(result.status).toBe('sent');
        expect(result.occurrence).toBe('2026-07-01');
        expect(result.recipients).toEqual(['user@example.com']);

        // Report generated for the previous calendar month, book-scoped
        expect(mockGenerateBalanceSheet).toHaveBeenCalledWith(
            expect.objectContaining({
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                bookAccountGuids: ['root', 'a1'],
            }),
        );

        // Email sent to the owner's address
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const email = mockSendEmail.mock.calls[0][0];
        expect(email.to).toBe('user@example.com');
        expect(email.subject).toContain('Balance Sheet');
        expect(email.subject).toContain('as of 2026-06-30');

        // last_run stamped with the occurrence key
        const stampCall = (mockPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls
            .find(call => String(call[0]).includes('last_run_period'));
        expect(stampCall).toBeDefined();
        expect(stampCall![1]).toBe(7);
        expect(stampCall![3]).toBe('2026-07-01');
    });

    it('is idempotent per period: skips when the occurrence already ran', async () => {
        primeSentPath();
        const schedule = makeSchedule({ lastRunPeriod: '2026-07-01' });

        const result = await runReportSchedule(schedule, { now });

        expect(result.status).toBe('skipped');
        expect(result.detail).toContain('already ran');
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('force re-runs an already-run period (Run now)', async () => {
        primeSentPath();
        const schedule = makeSchedule({ lastRunPeriod: '2026-07-01' });

        const result = await runReportSchedule(schedule, { now, force: true });

        expect(result.status).toBe('sent');
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });

    it('skips disabled schedules', async () => {
        primeSentPath();
        const result = await runReportSchedule(makeSchedule({ enabled: false }), { now });

        expect(result.status).toBe('skipped');
        expect(result.detail).toBe('disabled');
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('uses explicit recipients without touching the user table', async () => {
        primeSentPath();
        const schedule = makeSchedule({ recipients: 'a@example.com, b@example.com' });

        const result = await runReportSchedule(schedule, { now });

        expect(result.status).toBe('sent');
        expect(result.recipients).toEqual(['a@example.com', 'b@example.com']);
        expect(mockSendEmail.mock.calls[0][0].to).toBe('a@example.com, b@example.com');
        expect(mockPrisma.gnucash_web_users.findUnique).not.toHaveBeenCalled();
    });

    it('skips without stamping when SMTP is not configured', async () => {
        primeSentPath();
        mockIsEmailConfigured.mockReturnValue(false);

        const result = await runReportSchedule(makeSchedule(), { now });

        expect(result.status).toBe('skipped');
        expect(result.detail).toContain('email not configured');
        expect(mockSendEmail).not.toHaveBeenCalled();
        const stampCall = (mockPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls
            .find(call => String(call[0]).includes('last_run_period'));
        expect(stampCall).toBeUndefined();
    });

    it('fails when the targeted saved report no longer exists', async () => {
        primeSentPath();
        mockGetSavedReport.mockResolvedValue(null);

        const result = await runReportSchedule(makeSchedule({ savedReportId: 42, baseReportType: null }), { now });

        expect(result.status).toBe('failed');
        expect(result.detail).toContain('saved report not found');
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('fails on unsupported report types', async () => {
        primeSentPath();
        const result = await runReportSchedule(makeSchedule({ baseReportType: 'tax_harvesting' }), { now });

        expect(result.status).toBe('failed');
        expect(result.detail).toContain('unsupported report type');
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('resolves saved reports to their base type and name', async () => {
        primeSentPath();
        mockGetSavedReport.mockResolvedValue({
            id: 42,
            userId: 1,
            baseReportType: ReportType.BALANCE_SHEET,
            name: 'My Monthly Balance',
            description: null,
            config: {},
            filters: null,
            isStarred: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });

        const result = await runReportSchedule(makeSchedule({ savedReportId: 42, baseReportType: null }), { now });

        expect(result.status).toBe('sent');
        expect(mockGetSavedReport).toHaveBeenCalledWith(42, 1);
        expect(mockSendEmail.mock.calls[0][0].subject).toContain('My Monthly Balance');
    });
});

// ---------------------------------------------------------------------------
// Email rendering + CSV
// ---------------------------------------------------------------------------

describe('renderScheduleEmail', () => {
    const period = { startDate: '2026-06-01', endDate: '2026-06-30' };

    it('renders section rows with mono, right-aligned, thousands-formatted numerics', () => {
        const email = renderScheduleEmail({
            reportName: 'Balance Sheet',
            cadence: 'monthly',
            period,
            generated: { kind: 'sections', data: balanceSheetData },
        });

        expect(email.subject).toBe('[GnuCash Web] Balance Sheet — as of 2026-06-30');
        // Report rows, including nested children
        expect(email.html).toContain('Checking');
        expect(email.html).toContain('Sub Account');
        expect(email.html).toContain('Credit Card');
        // Section headers + totals
        expect(email.html).toContain('Assets');
        expect(email.html).toContain('Total Liabilities');
        // Mono numerics with thousands separators
        expect(email.html).toContain('1,234.56');
        expect(email.html).toContain('1,244.56');
        expect(email.html).toContain('SFMono-Regular');
        expect(email.html).toContain('text-align:right');
        // Grand total accent
        expect(email.html).toContain('1,044.56');
    });

    it('escapes HTML in account names', () => {
        const data: ReportData = {
            ...balanceSheetData,
            sections: [
                {
                    title: 'Assets',
                    items: [{ guid: 'x', name: '<script>alert(1)</script>', amount: 1, depth: 0 }],
                    total: 1,
                },
            ],
        };
        const email = renderScheduleEmail({
            reportName: 'Balance Sheet',
            cadence: 'monthly',
            period,
            generated: { kind: 'sections', data },
        });
        expect(email.html).not.toContain('<script>');
        expect(email.html).toContain('&lt;script&gt;');
    });

    it('labels flow reports with the start → end range', () => {
        const data: ReportData = {
            ...balanceSheetData,
            type: ReportType.INCOME_STATEMENT,
            title: 'Income Statement',
        };
        const email = renderScheduleEmail({
            reportName: 'Income Statement',
            cadence: 'monthly',
            period,
            generated: { kind: 'sections', data },
        });
        expect(email.subject).toContain('2026-06-01 → 2026-06-30');
    });

    it('includes the CSV in the plain-text part with a stable filename', () => {
        const email = renderScheduleEmail({
            reportName: 'Balance Sheet',
            cadence: 'monthly',
            period,
            generated: { kind: 'sections', data: balanceSheetData },
        });

        expect(email.csvFilename).toBe('Balance_Sheet_2026-06-30.csv');
        expect(email.text).toContain(email.csvFilename);
        expect(email.text).toContain(email.csv);
    });
});

describe('buildScheduleCsv', () => {
    it('sections: Section,Item,Amount rows with section totals', () => {
        const csv = buildScheduleCsv({ kind: 'sections', data: balanceSheetData });
        const lines = csv.split('\n');

        expect(lines[0]).toBe('Section,Item,Amount');
        expect(csv).toContain('Assets,,');
        expect(csv).toContain(',"Checking",1234.56');
        expect(csv).toContain('TOTAL: Assets,1244.56');
        expect(csv).toContain(',"GRAND TOTAL",1044.56');
    });

    it('trial balance: Account/Debit/Credit columns and totals', () => {
        const csv = buildScheduleCsv({
            kind: 'trial_balance',
            data: {
                type: ReportType.TRIAL_BALANCE,
                title: 'Trial Balance',
                generatedAt: '2026-07-12T00:00:00.000Z',
                filters: { startDate: null, endDate: '2026-06-30' },
                entries: [
                    { guid: 'a', accountPath: 'Assets:Checking', accountType: 'BANK', debit: 100, credit: 0 },
                    { guid: 'b', accountPath: 'Income:Salary', accountType: 'INCOME', debit: 0, credit: 100 },
                ],
                totalDebits: 100,
                totalCredits: 100,
            },
        });
        const lines = csv.split('\n');
        expect(lines[0]).toBe('Account,Account Type,Debit,Credit');
        expect(csv).toContain('Assets:Checking,BANK,100,');
        expect(csv).toContain(',"TOTALS",100,100');
    });

    it('chart (net worth table): one row per date point with all series', () => {
        const csv = buildScheduleCsv({
            kind: 'chart',
            data: {
                type: ReportType.NET_WORTH_CHART,
                title: 'Net Worth',
                generatedAt: '2026-07-12T00:00:00.000Z',
                filters: { startDate: null, endDate: '2026-06-30' },
                dataPoints: [
                    { date: '2026-05-31', assets: 1000, liabilities: 100, netWorth: 900 },
                    { date: '2026-06-30', assets: 1100, liabilities: 90, netWorth: 1010 },
                ],
                series: ['assets', 'liabilities', 'netWorth'],
            },
        });
        const lines = csv.split('\n');
        expect(lines[0]).toBe('Date,assets,liabilities,netWorth');
        expect(lines[1]).toBe('2026-05-31,1000,100,900');
        expect(lines[2]).toBe('2026-06-30,1100,90,1010');
    });
});

describe('normalizeRecipients', () => {
    it('normalizes separators and trims', () => {
        expect(normalizeRecipients('a@x.com;b@y.com , c@z.com')).toBe('a@x.com, b@y.com, c@z.com');
    });

    it('returns null for empty input', () => {
        expect(normalizeRecipients(null)).toBeNull();
        expect(normalizeRecipients('  ')).toBeNull();
    });

    it('rejects malformed addresses', () => {
        expect(() => normalizeRecipients('not-an-email')).toThrow(/Invalid recipient/);
    });
});
