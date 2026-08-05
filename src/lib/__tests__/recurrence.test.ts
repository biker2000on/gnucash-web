import { describe, it, expect } from 'vitest';
import {
  computeNextOccurrences,
  computeNextOccurrencesForPatterns,
  RecurrencePattern,
} from '../recurrence';

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

  // Month-end drift: re-anchoring on a CLAMPED last_occur pinned a 31st
  // schedule to the 29th forever (Jan 31 → Feb 29 → Mar 29 → Apr 29 → ...).
  it('returns to the anchor day after a clamped month', () => {
    const pattern = mkPattern({
      periodType: 'month',
      periodStart: new Date(2024, 0, 31), // Jan 31, 2024 (leap year)
    });

    const afterJan = computeNextOccurrences(pattern, new Date(2024, 0, 31), null, null, 1, new Date(2024, 0, 31));
    expect(afterJan[0]).toEqual(new Date(2024, 1, 29)); // Feb 29 (clamped)

    const afterFeb = computeNextOccurrences(pattern, new Date(2024, 1, 29), null, null, 3, new Date(2024, 1, 29));
    expect(afterFeb[0]).toEqual(new Date(2024, 2, 31)); // Mar 31, NOT Mar 29
    expect(afterFeb[1]).toEqual(new Date(2024, 3, 30)); // Apr 30 (clamped)
    expect(afterFeb[2]).toEqual(new Date(2024, 4, 31)); // May 31
  });

  it('does not drift when generating a run from a clamped last occurrence', () => {
    const pattern = mkPattern({
      periodType: 'month',
      periodStart: new Date(2025, 0, 31), // Jan 31, 2025
    });

    const results = computeNextOccurrences(pattern, new Date(2025, 1, 28), null, null, 3, new Date(2025, 1, 28));

    expect(results[0]).toEqual(new Date(2025, 2, 31)); // Mar 31
    expect(results[1]).toEqual(new Date(2025, 3, 30)); // Apr 30
    expect(results[2]).toEqual(new Date(2025, 4, 31)); // May 31
  });

  it('yearly does not drift off Feb 29 once clamped', () => {
    const pattern = mkPattern({
      periodType: 'year',
      periodStart: new Date(2024, 1, 29), // Feb 29, 2024
    });

    // Last occurrence was the clamped Feb 28, 2025 → 2026 clamps again, but
    // 2028 (a leap year) must land back on the 29th.
    const results = computeNextOccurrences(pattern, new Date(2025, 1, 28), null, null, 3, new Date(2025, 1, 28));

    expect(results[0]).toEqual(new Date(2026, 1, 28));
    expect(results[1]).toEqual(new Date(2027, 1, 28));
    expect(results[2]).toEqual(new Date(2028, 1, 29));
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

// 'nth weekday' / 'last weekday' used to fall through to plain monthly
// arithmetic, so every occurrence after the first landed on the wrong date.
describe('weekday recurrences', () => {
  it('generates the 3rd Friday of every month for a year', () => {
    const pattern = mkPattern({
      periodType: 'nth weekday',
      periodStart: new Date(2025, 0, 17), // 3rd Friday of Jan 2025
    });

    const results = computeNextOccurrences(pattern, null, null, null, 12, new Date(2025, 0, 16));

    expect(results).toEqual([
      new Date(2025, 0, 17), new Date(2025, 1, 21), new Date(2025, 2, 21),
      new Date(2025, 3, 18), new Date(2025, 4, 16), new Date(2025, 5, 20),
      new Date(2025, 6, 18), new Date(2025, 7, 15), new Date(2025, 8, 19),
      new Date(2025, 9, 17), new Date(2025, 10, 21), new Date(2025, 11, 19),
    ]);
    for (const d of results) expect(d.getDay()).toBe(5);
  });

  it('generates the last Tuesday of every month for a year', () => {
    const pattern = mkPattern({
      periodType: 'last weekday',
      periodStart: new Date(2025, 0, 28), // last Tuesday of Jan 2025
    });

    const results = computeNextOccurrences(pattern, null, null, null, 12, new Date(2025, 0, 27));

    expect(results).toEqual([
      new Date(2025, 0, 28), new Date(2025, 1, 25), new Date(2025, 2, 25),
      new Date(2025, 3, 29), new Date(2025, 4, 27), new Date(2025, 5, 24),
      new Date(2025, 6, 29), new Date(2025, 7, 26), new Date(2025, 8, 30),
      new Date(2025, 9, 28), new Date(2025, 10, 25), new Date(2025, 11, 30),
    ]);
    for (const d of results) {
      expect(d.getDay()).toBe(2); // Tuesday
      // Always within the final week of the month
      expect(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate()).toBeLessThan(7);
    }
  });

  it('falls back to the last weekday in months without an Nth one', () => {
    const pattern = mkPattern({
      periodType: 'nth weekday',
      periodStart: new Date(2025, 3, 29), // 5th Tuesday of April 2025
    });

    const results = computeNextOccurrences(pattern, null, null, null, 6, new Date(2025, 3, 28));

    expect(results).toEqual([
      new Date(2025, 3, 29), // April has a 5th Tuesday
      new Date(2025, 4, 27), // May does not → last Tuesday
      new Date(2025, 5, 24), // June does not → last Tuesday
      new Date(2025, 6, 29), // July has a 5th Tuesday
      new Date(2025, 7, 26), // August does not
      new Date(2025, 8, 30), // September has a 5th Tuesday
    ]);
  });

  it('respects the month multiplier', () => {
    const pattern = mkPattern({
      periodType: 'nth weekday',
      mult: 2,
      periodStart: new Date(2025, 0, 17), // 3rd Friday
    });

    const results = computeNextOccurrences(pattern, null, null, null, 4, new Date(2025, 0, 16));

    expect(results).toEqual([
      new Date(2025, 0, 17), new Date(2025, 2, 21),
      new Date(2025, 4, 16), new Date(2025, 6, 18),
    ]);
  });

  it('advances correctly from a recorded last occurrence', () => {
    const nthPattern = mkPattern({
      periodType: 'nth weekday',
      periodStart: new Date(2025, 0, 17), // 3rd Friday
    });
    const fromFeb = computeNextOccurrences(nthPattern, new Date(2025, 1, 21), null, null, 2, new Date(2025, 1, 21));
    expect(fromFeb[0]).toEqual(new Date(2025, 2, 21));
    expect(fromFeb[1]).toEqual(new Date(2025, 3, 18));

    const lastPattern = mkPattern({
      periodType: 'last weekday',
      periodStart: new Date(2025, 0, 28), // last Tuesday
    });
    const fromJan = computeNextOccurrences(lastPattern, new Date(2025, 0, 28), null, null, 2, new Date(2025, 0, 28));
    expect(fromJan[0]).toEqual(new Date(2025, 1, 25));
    expect(fromJan[1]).toEqual(new Date(2025, 2, 25));
  });
});

describe('ASI recurrence regressions', () => {
  it('does not skip June after a May 30 occurrence adjusts forward to June 1', () => {
    const pattern = mkPattern({
      periodType: 'month',
      periodStart: new Date(2026, 0, 30),
      weekendAdjust: 'forward',
    });

    const results = computeNextOccurrences(
      pattern,
      new Date(2026, 5, 1), // adjusted execution of Sat May 30
      null,
      null,
      2,
      new Date(2026, 5, 1),
    );

    expect(results[0]).toEqual(new Date(2026, 5, 30));
    expect(results[1]).toEqual(new Date(2026, 6, 30));
  });

  it('anchors semi-monthly schedules on periodStart and respects mult', () => {
    const pattern = mkPattern({
      periodType: 'semi_monthly',
      periodStart: new Date(2026, 0, 5),
      mult: 2,
    });

    const results = computeNextOccurrences(pattern, null, null, null, 4, new Date(2026, 0, 4));

    expect(results).toEqual([
      new Date(2026, 0, 5),
      new Date(2026, 0, 20),
      new Date(2026, 2, 5),
      new Date(2026, 2, 20),
    ]);
  });

  it('unions multiple GnuCash recurrence rows for one schedule', () => {
    const results = computeNextOccurrencesForPatterns([
      mkPattern({ periodType: 'month', periodStart: new Date(2026, 0, 1) }),
      mkPattern({ periodType: 'month', periodStart: new Date(2026, 0, 15) }),
    ], null, null, null, 4, new Date(2025, 11, 31));

    expect(results).toEqual([
      new Date(2026, 0, 1),
      new Date(2026, 0, 15),
      new Date(2026, 1, 1),
      new Date(2026, 1, 15),
    ]);
  });

  it('applies remaining occurrences to the composite stream as a whole', () => {
    const results = computeNextOccurrencesForPatterns([
      mkPattern({ periodType: 'month', periodStart: new Date(2026, 0, 1) }),
      mkPattern({ periodType: 'month', periodStart: new Date(2026, 0, 15) }),
    ], null, null, 1, 4, new Date(2025, 11, 31));

    expect(results).toEqual([new Date(2026, 0, 1)]);
  });

  it('does not skip a later composite anchor in the last occurrence month', () => {
    const results = computeNextOccurrencesForPatterns([
      mkPattern({ periodType: 'month', periodStart: new Date(2026, 0, 1) }),
      mkPattern({ periodType: 'month', periodStart: new Date(2026, 0, 15) }),
    ], new Date(2026, 0, 1), null, null, 2, new Date(2026, 0, 1));

    expect(results).toEqual([new Date(2026, 0, 15), new Date(2026, 1, 1)]);
  });
});
