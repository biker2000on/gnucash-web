import { describe, it, expect } from 'vitest';
import { computeNextOccurrences, RecurrencePattern } from '../recurrence';

function mkPattern(overrides: Partial<RecurrencePattern> & { periodType: string }): RecurrencePattern {
  return {
    mult: 1,
    periodStart: new Date(2025, 0, 1), // Jan 1, 2025
    weekendAdjust: 'none',
    ...overrides,
  };
}

describe('computeNextOccurrences', () => {
  // T33: Monthly on Jan 31 → Feb 28, Mar 31 (month-end clamping)
  it('clamps monthly dates to last day of shorter months', () => {
    const pattern = mkPattern({
      periodType: 'month',
      periodStart: new Date(2025, 0, 31), // Jan 31
    });

    const results = computeNextOccurrences(
      pattern,
      null,        // no lastOccur
      null,        // no endDate
      null,        // unlimited
      3,           // count
      new Date(2025, 0, 30) // afterDate: Jan 30 (so Jan 31 is included)
    );

    expect(results).toHaveLength(3);
    // Jan 31
    expect(results[0]).toEqual(new Date(2025, 0, 31));
    // Feb 28 (2025 is not a leap year)
    expect(results[1]).toEqual(new Date(2025, 1, 28));
    // Mar 31
    expect(results[2]).toEqual(new Date(2025, 2, 31));
  });

  // T34: Weekly → preserves day of week
  it('weekly recurrence preserves day of week', () => {
    // Wednesday Jan 1, 2025
    const pattern = mkPattern({
      periodType: 'weekly',
      periodStart: new Date(2025, 0, 1), // Wed
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      null,
      null,
      4,
      new Date(2024, 11, 31) // Dec 31, 2024
    );

    expect(results).toHaveLength(4);
    for (const d of results) {
      expect(d.getDay()).toBe(3); // Wednesday
    }
    expect(results[0]).toEqual(new Date(2025, 0, 1));
    expect(results[1]).toEqual(new Date(2025, 0, 8));
    expect(results[2]).toEqual(new Date(2025, 0, 15));
    expect(results[3]).toEqual(new Date(2025, 0, 22));
  });

  // T35: Daily → simple increment
  it('daily recurrence increments by one day', () => {
    const pattern = mkPattern({
      periodType: 'daily',
      periodStart: new Date(2025, 0, 1),
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      null,
      null,
      3,
      new Date(2024, 11, 31)
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(new Date(2025, 0, 1));
    expect(results[1]).toEqual(new Date(2025, 0, 2));
    expect(results[2]).toEqual(new Date(2025, 0, 3));
  });

  // T36: Yearly on Feb 29 → Feb 28 in non-leap years
  it('yearly on Feb 29 clamps to Feb 28 in non-leap years', () => {
    const pattern = mkPattern({
      periodType: 'year',
      periodStart: new Date(2024, 1, 29), // Feb 29, 2024 (leap year)
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      null,
      null,
      3,
      new Date(2024, 1, 28) // after Feb 28
    );

    expect(results).toHaveLength(3);
    // Feb 29, 2024 (leap year)
    expect(results[0]).toEqual(new Date(2024, 1, 29));
    // Feb 28, 2025 (non-leap)
    expect(results[1]).toEqual(new Date(2025, 1, 28));
    // Feb 28, 2026 (non-leap)
    expect(results[2]).toEqual(new Date(2026, 1, 28));
  });

  // T37: Weekend adjust 'back' → Sat/Sun become Friday
  it('weekend adjust back shifts Sat/Sun to previous Friday', () => {
    // Jan 4, 2025 is a Saturday
    const pattern = mkPattern({
      periodType: 'daily',
      periodStart: new Date(2025, 0, 4), // Saturday
      weekendAdjust: 'back',
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      null,
      null,
      2,
      new Date(2025, 0, 2) // after Jan 2
    );

    expect(results).toHaveLength(2);
    // Saturday Jan 4 → Friday Jan 3
    expect(results[0]).toEqual(new Date(2025, 0, 3));
    expect(results[0].getDay()).toBe(5); // Friday

    // Sunday Jan 5 → Friday Jan 3
    expect(results[1]).toEqual(new Date(2025, 0, 3));
    expect(results[1].getDay()).toBe(5); // Friday
  });

  // T38: Multiplier 2 → every other month
  it('multiplier 2 generates every other month', () => {
    const pattern = mkPattern({
      periodType: 'month',
      mult: 2,
      periodStart: new Date(2025, 0, 15), // Jan 15
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      null,
      null,
      4,
      new Date(2025, 0, 14)
    );

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual(new Date(2025, 0, 15)); // Jan
    expect(results[1]).toEqual(new Date(2025, 2, 15)); // Mar
    expect(results[2]).toEqual(new Date(2025, 4, 15)); // May
    expect(results[3]).toEqual(new Date(2025, 6, 15)); // Jul
  });

  // T39: remainingOccurrences = 0 → returns empty
  it('returns empty array when remainingOccurrences is 0', () => {
    const pattern = mkPattern({
      periodType: 'month',
      periodStart: new Date(2025, 0, 1),
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      null,
      0, // no remaining
      10,
      new Date(2024, 11, 31)
    );

    expect(results).toEqual([]);
  });

  // T40: endDate reached → stops
  it('stops generating when endDate is reached', () => {
    const pattern = mkPattern({
      periodType: 'month',
      periodStart: new Date(2025, 0, 1),
    });

    const results = computeNextOccurrences(
      pattern,
      null,
      new Date(2025, 2, 15), // end mid-March
      null,
      12,
      new Date(2024, 11, 31)
    );

    expect(results).toHaveLength(3); // Jan, Feb, Mar 1
    expect(results[0]).toEqual(new Date(2025, 0, 1));
    expect(results[1]).toEqual(new Date(2025, 1, 1));
    expect(results[2]).toEqual(new Date(2025, 2, 1));
  });
});
