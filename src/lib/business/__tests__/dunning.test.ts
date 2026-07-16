/**
 * Dunning — pure-logic tests (DB-free).
 *
 * Covers:
 *   - schedule parsing/normalization (dedupe, sort, bad input fallback)
 *   - days-overdue math
 *   - threshold selection + dedupe (nextDunningLevel): one email per
 *     escalation, no stacked catch-up sends, re-runs are no-ops
 *   - template placeholder rendering
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  parseDunningSchedule,
  daysOverdue,
  nextDunningLevel,
  renderDunningTemplate,
  DEFAULT_DUNNING_SCHEDULE,
} from '../dunning';

describe('parseDunningSchedule', () => {
  it('sorts and dedupes valid day lists', () => {
    expect(parseDunningSchedule([30, 7, 14, 7])).toEqual([7, 14, 30]);
  });

  it('accepts numeric strings and drops junk', () => {
    expect(parseDunningSchedule(['7', 14, '30', 'x', -3, 0, 2.5, null])).toEqual([7, 14, 30]);
  });

  it('falls back to the default for empty/invalid input', () => {
    expect(parseDunningSchedule([])).toEqual(DEFAULT_DUNNING_SCHEDULE);
    expect(parseDunningSchedule('nope')).toEqual(DEFAULT_DUNNING_SCHEDULE);
    expect(parseDunningSchedule(undefined)).toEqual(DEFAULT_DUNNING_SCHEDULE);
    expect(parseDunningSchedule([-1, 0])).toEqual(DEFAULT_DUNNING_SCHEDULE);
  });

  it('caps the schedule at 10 thresholds', () => {
    const many = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(parseDunningSchedule(many)).toHaveLength(10);
  });
});

describe('daysOverdue', () => {
  const day = 24 * 60 * 60 * 1000;
  const due = new Date('2026-07-01T12:00:00Z');

  it('is 0 when not yet due or due today', () => {
    expect(daysOverdue(due, new Date(due.getTime() - 5 * day))).toBe(0);
    expect(daysOverdue(due, due)).toBe(0);
  });

  it('counts whole days past due', () => {
    expect(daysOverdue(due, new Date(due.getTime() + 1 * day))).toBe(1);
    expect(daysOverdue(due, new Date(due.getTime() + 7 * day))).toBe(7);
    expect(daysOverdue(due, new Date(due.getTime() + 7.9 * day))).toBe(7);
  });
});

describe('nextDunningLevel', () => {
  const schedule = [7, 14, 30];

  it('sends nothing before the first threshold', () => {
    expect(nextDunningLevel(schedule, 0, [])).toBeNull();
    expect(nextDunningLevel(schedule, 6, [])).toBeNull();
  });

  it('fires each threshold exactly when crossed', () => {
    expect(nextDunningLevel(schedule, 7, [])).toBe(7);
    expect(nextDunningLevel(schedule, 13, [7])).toBeNull();
    expect(nextDunningLevel(schedule, 14, [7])).toBe(14);
    expect(nextDunningLevel(schedule, 30, [7, 14])).toBe(30);
  });

  it('re-runs on the same day are no-ops (already logged)', () => {
    expect(nextDunningLevel(schedule, 7, [7])).toBeNull();
    expect(nextDunningLevel(schedule, 14, [7, 14])).toBeNull();
    expect(nextDunningLevel(schedule, 45, [7, 14, 30])).toBeNull();
  });

  it('sends only the HIGHEST crossed threshold after an outage (no stacking)', () => {
    // Worker was down: invoice is now 31 days overdue, nothing ever sent.
    expect(nextDunningLevel(schedule, 31, [])).toBe(30);
    // After that single send, nothing more until a higher threshold exists.
    expect(nextDunningLevel(schedule, 31, [30])).toBeNull();
  });

  it('skips lower unsent levels once a higher level was logged', () => {
    // 14-day reminder went out; the 7-day one must never back-fill.
    expect(nextDunningLevel(schedule, 20, [14])).toBeNull();
    expect(nextDunningLevel(schedule, 30, [14])).toBe(30);
  });

  it('handles unsorted schedules and empty schedules', () => {
    expect(nextDunningLevel([30, 7, 14], 15, [7])).toBe(14);
    expect(nextDunningLevel([], 100, [])).toBeNull();
  });
});

describe('renderDunningTemplate', () => {
  const vars = {
    customer: 'Acme Corp',
    invoice_no: '000042',
    amount_due: '150.00 USD',
    days_overdue: '14',
    link: 'https://example.com/share/invoice/abc',
  };

  it('substitutes all documented placeholders', () => {
    const out = renderDunningTemplate(
      'Dear {{customer}}, invoice {{invoice_no}} is {{days_overdue}} days overdue ({{amount_due}}). See {{link}}.',
      vars,
    );
    expect(out).toBe(
      'Dear Acme Corp, invoice 000042 is 14 days overdue (150.00 USD). See https://example.com/share/invoice/abc.',
    );
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderDunningTemplate('{{ customer }} / {{invoice_no }}', vars)).toBe('Acme Corp / 000042');
  });

  it('leaves unknown placeholders intact', () => {
    expect(renderDunningTemplate('Hi {{customer}}, ref {{po_number}}', vars)).toBe(
      'Hi Acme Corp, ref {{po_number}}',
    );
  });
});
