import { describe, expect, it } from 'vitest';
import { buildMoneyTimeline, detectTimelineConflicts, eventStatus } from '../core';
import type { FinancialEvent } from '../types';

function event(overrides: Partial<FinancialEvent> = {}): FinancialEvent {
  return {
    id: 'book:renewal:1',
    bookGuid: 'book',
    domain: 'renewal',
    title: 'Insurance renewal',
    description: null,
    date: '2026-08-01',
    endDate: null,
    cashImpact: -1_000,
    currency: 'USD',
    confidence: 0.95,
    status: 'needs_action',
    href: '/tools/renewals',
    sourceId: '1',
    actionId: null,
    planId: null,
    evidence: [],
    metadata: {},
    ...overrides,
  };
}

describe('Money Timeline core', () => {
  it('marks unresolved past events overdue', () => {
    expect(eventStatus('2026-07-01', true, new Date('2026-07-23T12:00:00Z'))).toBe('overdue');
    expect(eventStatus('2026-07-24', true, new Date('2026-07-23T12:00:00Z'))).toBe('needs_action');
  });

  it('detects duplicate obligations and one low-cash transition', () => {
    const events = [
      event(),
      event({ id: 'book:scheduled:2', domain: 'scheduled' }),
      event({ id: 'book:goal:3', domain: 'goal', title: 'College goal', date: '2026-08-02', cashImpact: -4_000 }),
    ];
    const conflicts = detectTimelineConflicts(
      events,
      5_500,
      2_000,
      new Date('2026-07-23T12:00:00Z'),
    );
    expect(conflicts.filter(conflict => conflict.kind === 'duplicate')).toHaveLength(1);
    expect(conflicts.filter(conflict => conflict.kind === 'low_cash')).toHaveLength(1);
    expect(conflicts.find(conflict => conflict.kind === 'low_cash')?.projectedCash).toBe(-500);
  });

  it('filters to the requested window and reports domain counts', () => {
    const timeline = buildMoneyTimeline(
      [event(), event({ id: 'old', date: '2025-01-01' })],
      '2026-07-01',
      '2026-12-31',
      'USD',
      10_000,
      0,
      new Date('2026-07-23T12:00:00Z'),
    );
    expect(timeline.events).toHaveLength(1);
    expect(timeline.domains).toEqual([{ domain: 'renewal', count: 1 }]);
  });
});
