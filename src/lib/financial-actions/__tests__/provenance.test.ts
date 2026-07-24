import { describe, expect, it } from 'vitest';
import { createCalculationTrace, stableTraceId } from '@/lib/provenance';
import { financialActionId } from '../store';

describe('calculation provenance', () => {
  it('canonicalizes object keys when generating stable trace IDs', () => {
    expect(stableTraceId('metric', { book: 'a', range: { start: 1, end: 2 } }))
      .toBe(stableTraceId('metric', { range: { end: 2, start: 1 }, book: 'a' }));
  });

  it('changes the trace ID when the calculation identity changes', () => {
    expect(stableTraceId('metric', { book: 'a' }))
      .not.toBe(stableTraceId('metric', { book: 'b' }));
    expect(stableTraceId('metric-a', { book: 'a' }))
      .not.toBe(stableTraceId('metric-b', { book: 'a' }));
  });

  it('creates a complete inspectable trace with defaults', () => {
    const trace = createCalculationTrace({
      namespace: 'test',
      identity: { metric: 'net-worth' },
      title: 'Net worth',
      summary: 'Assets less debts.',
      asOfDate: '2026-07-23',
      result: 123,
      unit: 'currency',
    });

    expect(trace.id).toMatch(/^trace_[a-f0-9]{32}$/);
    expect(trace.version).toBe(1);
    expect(trace.asOfDate).toBe('2026-07-23');
    expect(trace.steps).toEqual([]);
    expect(trace.evidence).toEqual([]);
    expect(trace.assumptions).toEqual([]);
    expect(trace.warnings).toEqual([]);
  });

  it('scopes stable action IDs to the user as well as the book', () => {
    const first = financialActionId(1, 'book-a', 'opportunity:debt');
    const same = financialActionId(1, 'book-a', 'opportunity:debt');
    const collaborator = financialActionId(2, 'book-a', 'opportunity:debt');

    expect(first).toBe(same);
    expect(first).not.toBe(collaborator);
    expect(first).toMatch(/^act_[a-f0-9]{32}$/);
  });
});
