import { describe, expect, it } from 'vitest';
import { calculateCalendarAge } from '../age';

const elapsedTimeAge = (birthday: string, asOf: Date) => Math.floor(
  (asOf.getTime() - new Date(`${birthday}T00:00:00`).getTime()) /
  (365.25 * 24 * 60 * 60 * 1000),
);

describe('calculateCalendarAge', () => {
  it('returns null rather than throwing for absent birthdays', () => {
    const asOf = new Date('2026-03-01T00:00:00Z');
    expect(calculateCalendarAge(null, asOf)).toBeNull();
    expect(calculateCalendarAge(undefined, asOf)).toBeNull();
  });

  it('fixes the profile age display regression: elapsed time says 73, calendar age says 74', () => {
    const asOf = new Date('2026-03-01T00:00:00Z');
    expect(elapsedTimeAge('1952-03-01', asOf)).toBe(73);
    expect(calculateCalendarAge('1952-03-01', asOf, 'utc')).toBe(74);
  });

  it('fixes the drawdown prefill regression: elapsed time says 73, calendar age says 74', () => {
    const asOf = new Date('2026-03-01T00:00:00Z');
    expect(elapsedTimeAge('1952-03-01', asOf)).toBe(73);
    expect(calculateCalendarAge('1952-03-01', asOf, 'utc')).toBe(74);
  });

  it.each([
    ['2000-02-29', '2024-02-28T23:59:59Z', 23],
    ['2000-02-29', '2024-02-29T00:00:00Z', 24],
    ['2000-12-31', '2026-12-30T23:59:59Z', 25],
    ['2000-12-31', '2026-12-31T00:00:00Z', 26],
    ['2000-01-01', '2025-12-31T23:59:59Z', 25],
    ['2000-01-01', '2026-01-01T00:00:00Z', 26],
    ['1952-03-01T00:00:00.000Z', '2026-03-01T00:00:00Z', 74],
  ])('returns %i for %s as of %s', (birthday, asOf, expected) => {
    expect(calculateCalendarAge(birthday, new Date(asOf), 'utc')).toBe(expected);
  });

  it('keeps callers using local calendar components self-consistent', () => {
    expect(calculateCalendarAge('2000-12-31T00:00:00.000Z', new Date(2026, 11, 31), 'local')).toBe(26);
  });
});
