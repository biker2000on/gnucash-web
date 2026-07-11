/**
 * Recurring invoices — pure-logic tests (DB-free).
 *
 * Covers:
 *   - next-date advancement anchored at start_date (monthly incl. month-end
 *     clamping without drift, weekly, quarterly-as-month*3, yearly, leap day)
 *   - notification dedupe sourceId format
 *   - input validation
 *   - cadence <-> pattern mapping used by the UI
 */

import { describe, it, expect } from 'vitest';
import {
  nextOccurrenceIso,
  recurringSourceId,
  validateRecurringInput,
  parseIsoLocal,
  toIsoLocal,
  RecurringInvoiceValidationError,
  type CreateRecurringInput,
} from '../recurring-invoices';
import {
  cadenceToPattern,
  patternToCadence,
  cadenceLabel,
} from '@/components/business/recurring-ui';

describe('nextOccurrenceIso', () => {
  it('advances a simple monthly schedule', () => {
    expect(nextOccurrenceIso('month', 1, '2026-01-15', '2026-01-15')).toBe('2026-02-15');
    expect(nextOccurrenceIso('month', 1, '2026-01-15', '2026-02-15')).toBe('2026-03-15');
  });

  it('clamps month-end without permanent drift (anchored at start)', () => {
    // Jan 31 -> Feb 28 (clamped) -> Mar 31 (back to the anchor day)
    expect(nextOccurrenceIso('month', 1, '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrenceIso('month', 1, '2026-01-31', '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrenceIso('month', 1, '2026-01-31', '2026-03-31')).toBe('2026-04-30');
  });

  it('handles leap-year February', () => {
    // 2028 is a leap year
    expect(nextOccurrenceIso('month', 1, '2028-01-31', '2028-01-31')).toBe('2028-02-29');
  });

  it('advances weekly schedules by exact weeks', () => {
    expect(nextOccurrenceIso('weekly', 1, '2026-07-06', '2026-07-06')).toBe('2026-07-13');
    expect(nextOccurrenceIso('weekly', 2, '2026-07-06', '2026-07-06')).toBe('2026-07-20');
  });

  it('advances quarterly (month x3) and yearly schedules', () => {
    expect(nextOccurrenceIso('month', 3, '2026-01-31', '2026-01-31')).toBe('2026-04-30');
    expect(nextOccurrenceIso('year', 1, '2026-03-01', '2026-03-01')).toBe('2027-03-01');
  });

  it('skips forward past multiple missed periods in one step', () => {
    // afterIso far beyond the anchor: returns the FIRST occurrence after it
    expect(nextOccurrenceIso('month', 1, '2026-01-15', '2026-05-20')).toBe('2026-06-15');
    expect(nextOccurrenceIso('weekly', 1, '2026-01-05', '2026-01-26')).toBe('2026-02-02');
  });

  it('daily schedules advance by mult days', () => {
    expect(nextOccurrenceIso('daily', 14, '2026-07-01', '2026-07-01')).toBe('2026-07-15');
  });
});

describe('parseIsoLocal / toIsoLocal', () => {
  it('round-trips ISO dates through local Date objects', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2026-12-31', '2028-02-29']) {
      expect(toIsoLocal(parseIsoLocal(iso))).toBe(iso);
    }
  });
});

describe('recurringSourceId', () => {
  it('produces the documented def:{id}:{date} dedupe key', () => {
    expect(recurringSourceId(7, '2026-07-01')).toBe('def:7:2026-07-01');
  });

  it('is unique per definition and per occurrence date', () => {
    const ids = new Set([
      recurringSourceId(1, '2026-07-01'),
      recurringSourceId(2, '2026-07-01'),
      recurringSourceId(1, '2026-08-01'),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('validateRecurringInput', () => {
  const valid: CreateRecurringInput = {
    name: 'Monthly retainer',
    ownerType: 'customer',
    ownerGuid: 'a'.repeat(32),
    template: { entries: [{ accountGuid: 'b'.repeat(32), quantity: 1, price: 100 }] },
    periodType: 'month',
    mult: 1,
    startDate: '2026-07-01',
  };

  it('accepts a valid input', () => {
    expect(() => validateRecurringInput(valid)).not.toThrow();
  });

  it.each([
    [{ ...valid, name: '  ' }, /name/],
    [{ ...valid, ownerType: 'job' as never }, /ownerType/],
    [{ ...valid, ownerGuid: 'short' }, /ownerGuid/],
    [{ ...valid, periodType: 'fortnight' as never }, /periodType/],
    [{ ...valid, mult: 0 }, /mult/],
    [{ ...valid, mult: 1.5 }, /mult/],
    [{ ...valid, startDate: '07/01/2026' }, /startDate/],
    [{ ...valid, template: { entries: [] } }, /entries/],
    [{ ...valid, template: { entries: [{ accountGuid: '', quantity: 1, price: 1 }] } }, /accountGuid/],
    [{ ...valid, template: { entries: [{ accountGuid: 'b'.repeat(32), quantity: NaN, price: 1 }] } }, /quantity/],
  ])('rejects invalid input %#', (input, pattern) => {
    expect(() => validateRecurringInput(input as CreateRecurringInput))
      .toThrow(RecurringInvoiceValidationError);
    expect(() => validateRecurringInput(input as CreateRecurringInput)).toThrow(pattern);
  });
});

describe('cadence <-> pattern mapping', () => {
  it('maps UI cadences onto recurrence patterns', () => {
    expect(cadenceToPattern('weekly', 1)).toEqual({ periodType: 'weekly', mult: 1 });
    expect(cadenceToPattern('monthly', 2)).toEqual({ periodType: 'month', mult: 2 });
    expect(cadenceToPattern('quarterly', 1)).toEqual({ periodType: 'month', mult: 3 });
    expect(cadenceToPattern('yearly', 1)).toEqual({ periodType: 'year', mult: 1 });
  });

  it('round-trips pattern -> cadence for the edit form', () => {
    expect(patternToCadence('weekly', 2)).toEqual({ cadence: 'weekly', every: 2 });
    expect(patternToCadence('month', 3)).toEqual({ cadence: 'quarterly', every: 1 });
    expect(patternToCadence('month', 2)).toEqual({ cadence: 'monthly', every: 2 });
    expect(patternToCadence('year', 1)).toEqual({ cadence: 'yearly', every: 1 });
  });

  it('labels patterns for the table', () => {
    expect(cadenceLabel('month', 1)).toBe('Monthly');
    expect(cadenceLabel('month', 3)).toBe('Quarterly');
    expect(cadenceLabel('weekly', 2)).toBe('Every 2 weeks');
    expect(cadenceLabel('year', 1)).toBe('Yearly');
  });
});
