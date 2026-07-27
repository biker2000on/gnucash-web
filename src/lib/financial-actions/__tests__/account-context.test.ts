import { describe, expect, it } from 'vitest';
import type { FinancialAction } from '../types';
import {
  actionAccountGuids,
  enrichActionsWithAccountPaths,
} from '../account-context';

const CASH_GUID = 'a'.repeat(32);
const OTHER_GUID = 'b'.repeat(32);

function action(overrides: Partial<FinancialAction> = {}): FinancialAction {
  return {
    id: 'action',
    stableKey: 'action',
    bookGuid: 'c'.repeat(32),
    lane: 'fix',
    origin: 'statement_reconciliation',
    sourceId: 'source',
    severity: 'warning',
    title: 'Reconcile Cash',
    summary: 'Account needs attention.',
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
    metadata: {},
    state: 'open',
    snoozedUntil: null,
    firstSeenAt: '2026-07-27T00:00:00.000Z',
    lastSeenAt: '2026-07-27T00:00:00.000Z',
    stateChangedAt: '2026-07-27T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

describe('Action Center account context', () => {
  it('finds account GUIDs in metadata, evidence, and account links', () => {
    const value = action({
      metadata: { accountGuid: CASH_GUID },
      operations: [{
        id: 'open',
        label: 'Open',
        kind: 'link',
        href: `/accounts/${OTHER_GUID}/reconcile`,
      }],
      trace: {
        ...action().trace,
        evidence: [{
          kind: 'account',
          id: CASH_GUID,
          label: 'Cash',
          source: 'system',
        }],
      },
    });

    expect(actionAccountGuids(value).sort()).toEqual([CASH_GUID, OTHER_GUID].sort());
  });

  it('adds the complete path when an action resolves to one account', () => {
    const value = action({ metadata: { accountGuid: CASH_GUID } });

    const [enriched] = enrichActionsWithAccountPaths(
      [value],
      new Map([[CASH_GUID, 'Assets:Household:Wallet:Cash']]),
    );

    expect(enriched.metadata?.accountPath).toBe('Assets:Household:Wallet:Cash');
  });

  it('does not imply one account path for a multi-account action', () => {
    const value = action({
      metadata: { accountGuids: [CASH_GUID, OTHER_GUID] },
    });

    const [enriched] = enrichActionsWithAccountPaths(
      [value],
      new Map([
        [CASH_GUID, 'Assets:Household:Wallet:Cash'],
        [OTHER_GUID, 'Assets:Business:Drawer:Cash'],
      ]),
    );

    expect(enriched.metadata?.accountPath).toBeUndefined();
  });
});
