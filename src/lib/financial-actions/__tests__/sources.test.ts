import { describe, expect, it, vi } from 'vitest';
import prisma from '@/lib/prisma';
import { loadBudgetNotificationContexts, safeActionSource } from '../sources';
import type { FinancialActionCandidate } from '../types';

vi.mock('@/lib/prisma', () => ({
  default: {
    budgets: { findMany: vi.fn() },
    gnucash_web_budget_ownership: { findMany: vi.fn() },
  },
}));

describe('Financial Action source isolation', () => {
  it('returns healthy adapter actions unchanged', async () => {
    const action = { stableKey: 'healthy' } as FinancialActionCandidate;
    const work = vi.fn().mockResolvedValue([action]);

    await expect(safeActionSource('Healthy source', work)).resolves.toEqual([action]);
    expect(work).toHaveBeenCalledOnce();
  });

  it('turns an adapter failure into a visible critical Fix action', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const actions = await safeActionSource(
      'Statement reconciliation',
      async () => { throw new Error('database unavailable'); },
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      stableKey: 'source-adapter-failure:statement-reconciliation',
      lane: 'fix',
      origin: 'failed_job',
      severity: 'critical',
      confidence: 1,
      metadata: {
        adapter: 'Statement reconciliation',
        refreshFailed: true,
      },
    });
    expect(actions[0].summary).not.toContain('database unavailable');
    expect(actions[0].trace.evidence[0]).toMatchObject({
      kind: 'job',
      source: 'system',
      verified: false,
    });
    warn.mockRestore();
  });

  it('omits budget notification contexts for foreign and unowned budgets', async () => {
    const ownership = vi.mocked(prisma.gnucash_web_budget_ownership.findMany);
    const budgets = vi.mocked(prisma.budgets.findMany);
    ownership.mockResolvedValue([]);

    const contexts = await loadBudgetNotificationContexts([
      {
        id: 1,
        userId: 1,
        bookGuid: 'book-a',
        type: 'budget_alert',
        severity: 'warning',
        title: 'Budget threshold reached',
        message: 'Foreign budget notification',
        href: '/budgets',
        source: 'budget-alert',
        sourceId: 'foreign-budget:expense-guid:p0:threshold',
        readAt: null,
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        bookGuid: null,
        type: 'budget_alert',
        severity: 'warning',
        title: 'Budget threshold reached',
        message: 'Global budget notification',
        href: '/budgets',
        source: 'budget-alert',
        sourceId: 'unowned-budget:expense-guid:p0:threshold',
        readAt: null,
        createdAt: new Date(),
      },
    ], 'book-a');

    expect(contexts).toEqual(new Map());
    expect(ownership).toHaveBeenCalledWith({
      where: {
        book_guid: 'book-a',
        budget_guid: { in: ['foreign-budget', 'unowned-budget'] },
      },
      select: { budget_guid: true },
    });
    expect(budgets).not.toHaveBeenCalled();
  });
});
