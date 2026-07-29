import { describe, expect, it } from 'vitest';
import type { FinancialAction } from '../types';
import { actionMatchesCurrentActiveBudget } from '../budget-context';

function action(metadata: Record<string, unknown>, stableKey = 'notification:1'): FinancialAction {
  return {
    id: 'action',
    stableKey,
    bookGuid: 'b'.repeat(32),
    lane: 'do',
    origin: 'notification',
    sourceId: '1',
    severity: 'warning',
    title: 'Budget warning',
    summary: 'Budget warning.',
    dueDate: null,
    impact: null,
    confidence: 1,
    score: null,
    assignee: null,
    operations: [],
    trace: {
      id: 'trace',
      version: 1,
      title: 'Trace',
      summary: '',
      generatedAt: '2026-07-27T00:00:00.000Z',
      asOfDate: '2026-07-27',
      result: null,
      steps: [],
      evidence: [],
      assumptions: [],
      warnings: [],
    },
    metadata,
    state: 'open',
    snoozedUntil: null,
    firstSeenAt: '2026-07-27T00:00:00.000Z',
    lastSeenAt: '2026-07-27T00:00:00.000Z',
    stateChangedAt: '2026-07-27T00:00:00.000Z',
    resolvedAt: null,
  };
}

describe('Action Center budget eligibility', () => {
  it('keeps only warnings for the current active budget period', () => {
    const current = action({
      notificationType: 'budget_alert',
      budgetGuid: 'current',
      budgetYear: 2026,
      budgetPeriod: {
        periodNum: 6,
        start: '2026-07-01',
        end: '2026-07-31',
        label: 'Jul 2026',
      },
    });

    expect(actionMatchesCurrentActiveBudget(current, '2026-07-27')).toBe(true);
    expect(actionMatchesCurrentActiveBudget(current, '2026-08-01')).toBe(false);
  });

  it('removes legacy and unverified budget warnings', () => {
    const legacy = action({
      notificationType: 'budget_alert',
      budgetGuid: 'legacy',
      budgetYear: 2017,
      budgetPeriod: {
        periodNum: 6,
        start: '2017-07-01',
        end: '2017-07-31',
        label: 'Jul 2017',
      },
    });
    const missingContext = action(
      { opportunityPack: 'budget-gaps' },
      'opportunity:budget-gaps:legacy',
    );

    expect(actionMatchesCurrentActiveBudget(legacy, '2026-07-27')).toBe(false);
    expect(actionMatchesCurrentActiveBudget(missingContext, '2026-07-27')).toBe(false);
  });

  it('does not filter non-budget actions', () => {
    expect(actionMatchesCurrentActiveBudget(action({ notificationType: 'receipt' }), '2026-07-27'))
      .toBe(true);
  });
});
