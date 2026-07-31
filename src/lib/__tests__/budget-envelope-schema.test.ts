import { describe, expect, it, vi } from 'vitest';

const { executeRawUnsafeMock } = vi.hoisted(() => ({
    executeRawUnsafeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/prisma', () => ({
    default: { $executeRawUnsafe: executeRawUnsafeMock },
}));
vi.mock('@/lib/gnucash', () => ({ toDecimalNumber: vi.fn() }));
vi.mock('@/lib/format', () => ({ formatCurrency: vi.fn() }));
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(), ensureNotificationsTable: vi.fn() }));
vi.mock('@/lib/anomaly-detection', () => ({ loadBookAccountGuids: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn() }));
vi.mock('@/lib/services/budget.service', () => ({ BudgetService: { getById: vi.fn() } }));
vi.mock('@/lib/budget-actuals', () => ({
    computePeriodRanges: vi.fn(),
    findCurrentPeriodNum: vi.fn(),
    computeElapsedFraction: vi.fn(),
    computePacing: vi.fn(),
    signCorrectAmount: vi.fn(),
    loadBudgetActuals: vi.fn(),
}));
vi.mock('@/lib/budget-alert-context', () => ({
    contextualizeBudgetAlert: vi.fn(),
    currentYearActiveBudgetPeriod: vi.fn(),
}));

import { ensureEnvelopesTable } from '@/lib/budget-envelope';

describe('envelope schema lifecycle', () => {
    it('removes legacy orphan rows and installs a cascade budget foreign key', async () => {
        await ensureEnvelopesTable();

        const sql = executeRawUnsafeMock.mock.calls[0]?.[0] as string;
        expect(sql).toContain('DELETE FROM gnucash_web_budget_envelopes');
        expect(sql).toContain('REFERENCES budgets(guid)');
        expect(sql).toContain('ON DELETE CASCADE');
        expect(sql).toContain('fk_budget_envelopes_budget');
    });
});
