import { describe, expect, it, vi } from 'vitest';
import prisma from '@/lib/prisma';
import {
  loadBudgetNotificationContexts,
  safeActionSource,
  transactionReviewActions,
} from '../sources';
import type { FinancialActionCandidate } from '../types';

vi.mock('@/lib/prisma', () => ({
  default: {
    budgets: { findMany: vi.fn() },
    gnucash_web_budget_ownership: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

describe('transactionReviewActions source gating', () => {
  const queryRaw = vi.mocked(prisma.$queryRaw);

  it('queries only unreviewed, non-manual imports (SQL-level gate)', async () => {
    queryRaw.mockResolvedValueOnce([]);

    await transactionReviewActions(['a'.repeat(32)]);

    expect(queryRaw).toHaveBeenCalledOnce();
    const sql = (queryRaw.mock.calls[0][0] as unknown as TemplateStringsArray).join('?');
    // Reviewed-after-import rows are never re-raised…
    expect(sql).toContain('m.reviewed = FALSE');
    // …and manually entered transactions are never raised at all: authoring
    // the transaction IS the review.
    expect(sql).toContain("m.source <> 'manual'");
    expect(sql).toContain('m.deleted_at IS NULL');
  });

  it('never raises an item for a manual transaction even if the query returns one', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        guid: 'm'.repeat(32),
        description: 'Hand-entered groceries',
        post_date: new Date('2026-07-01T12:00:00Z'),
        confidence: null,
        source: 'manual',
      },
      {
        guid: 's'.repeat(32),
        description: 'HARBOR FREIGHT PAYMENT',
        post_date: new Date('2026-07-02T12:00:00Z'),
        confidence: 'low',
        source: 'simplefin',
      },
    ]);

    const actions = await transactionReviewActions(['a'.repeat(32)]);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      stableKey: `transaction-review:${'s'.repeat(32)}`,
      origin: 'transaction_review',
      severity: 'warning',
      title: 'HARBOR FREIGHT PAYMENT',
    });
  });

  it('raises nothing when every unreviewed row is manual', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        guid: 'm'.repeat(32),
        description: 'Hand-entered groceries',
        post_date: new Date('2026-07-01T12:00:00Z'),
        confidence: null,
        source: 'manual',
      },
    ]);

    await expect(transactionReviewActions(['a'.repeat(32)])).resolves.toEqual([]);
  });
});

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
