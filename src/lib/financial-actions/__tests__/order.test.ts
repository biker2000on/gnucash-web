import { describe, expect, it } from 'vitest';
import { compareFinancialActions } from '../order';
import type { FinancialAction } from '../types';

function action(overrides: Partial<FinancialAction>): FinancialAction {
  return {
    stableKey: 'base',
    bookGuid: 'book-a',
    id: 'action-a',
    severity: 'warning',
    score: null,
    dueDate: null,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as FinancialAction;
}

describe('compareFinancialActions', () => {
  it('orders by severity, score, due date, recency, then stable key', () => {
    const actions = [
      action({ stableKey: 'z-tie' }),
      action({ stableKey: 'info', severity: 'info' }),
      action({ stableKey: 'a-tie' }),
      action({ stableKey: 'scored', score: { total: 10 } as FinancialAction['score'] }),
      action({ stableKey: 'due', dueDate: '2026-07-02' }),
      action({ stableKey: 'critical', severity: 'critical' }),
      action({ stableKey: 'newer', firstSeenAt: '2026-07-02T00:00:00.000Z' }),
    ];

    expect(actions.sort(compareFinancialActions).map(item => item.stableKey)).toEqual([
      'critical',
      'scored',
      'due',
      'newer',
      'a-tie',
      'z-tie',
      'info',
    ]);
  });

  it('produces the same result regardless of input order', () => {
    const left = [
      action({ stableKey: 'charlie' }),
      action({ stableKey: 'alpha' }),
      action({ stableKey: 'bravo' }),
    ];
    const right = [...left].reverse();

    expect(left.sort(compareFinancialActions).map(item => item.stableKey))
      .toEqual(right.sort(compareFinancialActions).map(item => item.stableKey));
  });

  it('uses book and action IDs to totally order duplicate family stable keys', () => {
    const actions = [
      action({ stableKey: 'same', bookGuid: 'book-b', id: 'action-b' }),
      action({ stableKey: 'same', bookGuid: 'book-a', id: 'action-z' }),
      action({ stableKey: 'same', bookGuid: 'book-a', id: 'action-a' }),
    ];

    expect(actions.sort(compareFinancialActions).map(item => `${item.bookGuid}:${item.id}`))
      .toEqual(['book-a:action-a', 'book-a:action-z', 'book-b:action-b']);
  });
});
