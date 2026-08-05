/**
 * Recurrence computation utility for GnuCash scheduled transaction patterns.
 *
 * Computes next occurrence dates based on GnuCash recurrence rules,
 * handling month-end clamping, leap years, weekend adjustments, and multipliers.
 */

export interface RecurrencePattern {
  periodType: string;       // 'once' | 'daily' | 'weekly' | 'month' | 'end of month' | 'nth weekday' | 'last weekday' | 'semi_monthly' | 'year'
  mult: number;             // interval multiplier (e.g., 2 = every 2 months)
  periodStart: Date;        // anchor date
  weekendAdjust: string;    // 'none' | 'back' | 'forward'
}

/**
 * Returns the last day of the given month/year.
 */
function lastDayOfMonth(year: number, month: number): number {
  // month is 0-based; Date with day=0 gives last day of previous month
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Clamp a day to the last day of the target month.
 */
function clampDay(year: number, month: number, day: number): number {
  const max = lastDayOfMonth(year, month);
  return Math.min(day, max);
}

/**
 * Apply weekend adjustment: shift Saturday/Sunday to Friday (back) or Monday (forward).
 */
function applyWeekendAdjust(date: Date, adjust: string): Date {
  const dow = date.getDay(); // 0=Sun, 6=Sat
  if (adjust === 'back') {
    if (dow === 0) {
      // Sunday → Friday (-2 days)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 2);
    }
    if (dow === 6) {
      // Saturday → Friday (-1 day)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    }
  } else if (adjust === 'forward') {
    if (dow === 0) {
      // Sunday → Monday (+1 day)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    }
    if (dow === 6) {
      // Saturday → Monday (+2 days)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 2);
    }
  }
  return date;
}

/**
 * Add N months to a date, clamping day to the last day of the target month.
 */
function addMonths(base: Date, n: number): Date {
  return monthDay(base.getFullYear(), base.getMonth() + n, base.getDate());
}

/**
 * Build a date from a possibly out-of-range month index, clamping the day to
 * the target month's length.
 */
function monthDay(year: number, month: number, day: number): Date {
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  return new Date(targetYear, targetMonth, clampDay(targetYear, targetMonth, day));
}

/**
 * The Nth occurrence of `weekday` (0=Sun) in the given month.
 *
 * Months without an Nth such weekday — a 5th Friday, say — fall back to the
 * last one, matching GnuCash desktop and the month-end clamping used above.
 */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
  const firstDow = new Date(year, month, 1).getDay();
  const last = lastDayOfMonth(year, month);
  let day = 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  while (day > last) day -= 7;
  return new Date(year, month, day);
}

/** The final occurrence of `weekday` (0=Sun) in the given month. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = lastDayOfMonth(year, month);
  const lastDow = new Date(year, month, last).getDay();
  return new Date(year, month, last - ((lastDow - weekday + 7) % 7));
}

/**
 * Weekday and ordinal ("3rd Friday") that a nth/last-weekday recurrence is
 * anchored on — both derived from the pattern's start date, as GnuCash does.
 */
function weekdayAnchor(periodStart: Date): { weekday: number; ordinal: number } {
  return {
    weekday: periodStart.getDay(),
    ordinal: Math.floor((periodStart.getDate() - 1) / 7) + 1,
  };
}

function weekdayOccurrence(
  periodType: string,
  periodStart: Date,
  year: number,
  month: number,
): Date {
  const { weekday, ordinal } = weekdayAnchor(periodStart);
  const base = monthDay(year, month, 1);
  return periodType === 'last weekday'
    ? lastWeekdayOfMonth(base.getFullYear(), base.getMonth(), weekday)
    : nthWeekdayOfMonth(base.getFullYear(), base.getMonth(), weekday, ordinal);
}

/** Last day of the month containing the given (possibly out-of-range) month index. */
function endOfMonth(year: number, month: number): Date {
  const base = monthDay(year, month, 1);
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    lastDayOfMonth(base.getFullYear(), base.getMonth()),
  );
}

/** Two user-anchored days for the app's semi-monthly shorthand (e.g. 5/20). */
function semiMonthlyAnchorDays(periodStart: Date, year: number, month: number): number[] {
  const first = clampDay(year, month, periodStart.getDate());
  const second = clampDay(year, month, periodStart.getDate() + 15);
  return first === second ? [first] : [first, second];
}

/**
 * Generate raw (unadjusted) occurrences for the pattern starting from a reference date.
 * Yields dates in chronological order indefinitely (caller must limit).
 */
function* generateRawDates(
  pattern: RecurrencePattern,
  startFrom: Date
): Generator<Date> {
  const { periodType, mult, periodStart } = pattern;
  let step = 0;

  switch (periodType) {
    case 'once': {
      yield new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
      return;
    }

    case 'daily': {
      // First occurrence: startFrom, then increment by mult days
      const base = new Date(startFrom.getFullYear(), startFrom.getMonth(), startFrom.getDate());
      while (true) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + step * mult);
        yield d;
        step++;
      }
    }
    case 'weekly': {
      const base = new Date(startFrom.getFullYear(), startFrom.getMonth(), startFrom.getDate());
      while (true) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + step * mult * 7);
        yield d;
        step++;
      }
    }
    case 'month': {
      // The day-of-month is anchored on periodStart, never on the date we
      // start from: a schedule on the 31st that was clamped to Feb 29 must
      // return to the 31st in March rather than stay pinned to the 29th.
      const anchorDay = periodStart.getDate();
      while (true) {
        yield monthDay(startFrom.getFullYear(), startFrom.getMonth() + step * mult, anchorDay);
        step++;
      }
    }
    case 'end of month': {
      while (true) {
        yield endOfMonth(startFrom.getFullYear(), startFrom.getMonth() + step * mult);
        step++;
      }
    }
    case 'semi_monthly': {
      // The first anchor comes from periodStart and the second is 15 days
      // later (5th/20th, for example). mult controls the month interval.
      const baseYear = startFrom.getFullYear();
      const baseMonth = startFrom.getMonth();
      let monthOffset = 0;
      while (true) {
        const totalMonth = baseMonth + monthOffset * mult;
        const y = baseYear + Math.floor(totalMonth / 12);
        const m = ((totalMonth % 12) + 12) % 12;
        for (const day of semiMonthlyAnchorDays(periodStart, y, m)) {
          yield new Date(y, m, day);
        }

        monthOffset++;
      }
    }
    case 'year': {
      // Month and day come from periodStart for the same reason as 'month':
      // a Feb 29 schedule clamped to Feb 28 must not stay on the 28th.
      const anchorMonth = periodStart.getMonth();
      const anchorDay = periodStart.getDate();
      while (true) {
        const year = startFrom.getFullYear() + step * mult;
        yield new Date(year, anchorMonth, clampDay(year, anchorMonth, anchorDay));
        step++;
      }
    }
    case 'nth weekday':
    case 'last weekday': {
      while (true) {
        yield weekdayOccurrence(
          periodType,
          periodStart,
          startFrom.getFullYear(),
          startFrom.getMonth() + step * mult,
        );
        step++;
      }
    }
    default: {
      // Unknown period type — yield nothing
      return;
    }
  }
}

/**
 * Compute next occurrence dates from a GnuCash recurrence pattern.
 *
 * @param pattern - The recurrence pattern definition
 * @param lastOccur - Date of last occurrence (null if none yet)
 * @param endDate - Stop generating after this date (null = no end)
 * @param remainingOccurrences - Max remaining occurrences (null = unlimited)
 * @param count - How many dates to generate
 * @param afterDate - Only return dates strictly after this date
 * @returns Array of computed occurrence dates
 */
export function computeNextOccurrences(
  pattern: RecurrencePattern,
  lastOccur: Date | null,
  endDate: Date | null,
  remainingOccurrences: number | null,
  count: number,
  afterDate: Date
): Date[] {
  if (remainingOccurrences !== null && remainingOccurrences <= 0) {
    return [];
  }
  if (count <= 0) {
    return [];
  }

  // Determine starting point: lastOccur or periodStart
  const startFrom = lastOccur
    ? computeFirstAfterLast(pattern, lastOccur)
    : new Date(pattern.periodStart.getFullYear(), pattern.periodStart.getMonth(), pattern.periodStart.getDate());

  const results: Date[] = [];
  let remaining = remainingOccurrences;
  const gen = generateRawDates(pattern, startFrom);

  // Safety limit to prevent infinite loops
  const maxIterations = 10000;
  let iterations = 0;

  for (const rawDate of gen) {
    if (iterations++ > maxIterations) break;

    // Apply weekend adjustment
    const adjusted = applyWeekendAdjust(rawDate, pattern.weekendAdjust);

    // Check end date
    if (endDate !== null && adjusted > endDate) {
      break;
    }

    // Only include dates strictly after afterDate
    if (adjusted <= afterDate) {
      continue;
    }

    results.push(adjusted);

    if (remaining !== null) {
      remaining--;
      if (remaining <= 0) break;
    }

    if (results.length >= count) break;
  }

  return results;
}

/**
 * Union the occurrence streams for a composite GnuCash schedule. Desktop
 * GnuCash represents patterns such as the 1st + 15th as two recurrence rows.
 */
export function computeNextOccurrencesForPatterns(
  patterns: RecurrencePattern[],
  lastOccur: Date | null,
  endDate: Date | null,
  remainingOccurrences: number | null,
  count: number,
  afterDate: Date,
): Date[] {
  if (patterns.length === 0 || count <= 0) return [];
  const byTime = new Map<number, Date>();
  for (const pattern of patterns) {
    // lastOccur belongs to the composite schedule, not necessarily this row.
    // Advancing every row from it would skip a later anchor in the same month
    // (last overall = Jan 1, second row = Jan 15).
    const rowLastOccur = lastOccur && occurrenceBelongsToMonthlyPattern(pattern, lastOccur)
      ? lastOccur
      : null;
    for (const date of computeNextOccurrences(
      pattern,
      rowLastOccur,
      endDate,
      remainingOccurrences,
      count,
      afterDate,
    )) {
      byTime.set(date.getTime(), date);
    }
  }
  return [...byTime.values()]
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(0, Math.min(count, remainingOccurrences ?? count));
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function matchesMonthlyAnchor(pattern: RecurrencePattern, candidate: Date): boolean {
  const { periodType, periodStart } = pattern;
  const year = candidate.getFullYear();
  const month = candidate.getMonth();
  switch (periodType) {
    case 'month':
      return candidate.getDate() === clampDay(year, month, periodStart.getDate());
    case 'end of month':
      return candidate.getDate() === lastDayOfMonth(year, month);
    case 'nth weekday':
    case 'last weekday':
      return sameCalendarDay(candidate, weekdayOccurrence(periodType, periodStart, year, month));
    case 'semi_monthly':
      return semiMonthlyAnchorDays(periodStart, year, month).includes(candidate.getDate());
    default:
      return false;
  }
}

function occurrenceBelongsToMonthlyPattern(
  pattern: RecurrencePattern,
  occurrence: Date,
): boolean {
  if (!['month', 'end of month', 'nth weekday', 'last weekday', 'semi_monthly']
    .includes(pattern.periodType)) return true;
  const raw = rawMonthlyOccurrence(pattern, occurrence);
  if (!matchesMonthlyAnchor(pattern, raw)) return false;
  const monthDelta = (raw.getFullYear() - pattern.periodStart.getFullYear()) * 12
    + raw.getMonth() - pattern.periodStart.getMonth();
  return monthDelta >= 0 && monthDelta % pattern.mult === 0;
}

/**
 * Recover a raw monthly occurrence from a stored weekend-adjusted date. A
 * forward-adjusted May 30 can be stored as June 1; advancing from June would
 * skip June's occurrence. The adjustment is at most two days, so the search is
 * small and deterministic.
 */
function rawMonthlyOccurrence(pattern: RecurrencePattern, lastOccur: Date): Date {
  if (pattern.weekendAdjust === 'none') return lastOccur;
  const candidates: Date[] = [];
  for (let delta = -2; delta <= 2; delta++) {
    const candidate = new Date(
      lastOccur.getFullYear(),
      lastOccur.getMonth(),
      lastOccur.getDate() + delta,
    );
    if (
      matchesMonthlyAnchor(pattern, candidate)
      && sameCalendarDay(applyWeekendAdjust(candidate, pattern.weekendAdjust), lastOccur)
    ) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return lastOccur;
  return candidates.sort((a, b) =>
    Math.abs(a.getTime() - lastOccur.getTime()) - Math.abs(b.getTime() - lastOccur.getTime())
  )[0];
}

/**
 * Compute the first occurrence after the last known occurrence.
 * This advances by one interval from lastOccur.
 *
 * Only the MONTH is taken from lastOccur for the monthly family; the
 * day-of-month (or weekday/ordinal) comes from periodStart. Re-deriving the
 * day from a previous occurrence would make every clamped month permanent —
 * a rent SX on the 31st went Jan 31 → Feb 29 → Mar 29 and never recovered.
 */
function computeFirstAfterLast(pattern: RecurrencePattern, lastOccur: Date): Date {
  const { periodType, mult, periodStart } = pattern;
  const rawLast = ['month', 'end of month', 'nth weekday', 'last weekday', 'semi_monthly']
    .includes(periodType)
    ? rawMonthlyOccurrence(pattern, lastOccur)
    : lastOccur;

  switch (periodType) {
    case 'daily':
      return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), lastOccur.getDate() + mult);

    case 'weekly':
      return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), lastOccur.getDate() + mult * 7);

    case 'month':
      return monthDay(rawLast.getFullYear(), rawLast.getMonth() + mult, periodStart.getDate());

    case 'end of month':
      return endOfMonth(rawLast.getFullYear(), rawLast.getMonth() + mult);

    case 'nth weekday':
    case 'last weekday':
      return weekdayOccurrence(
        periodType,
        periodStart,
        rawLast.getFullYear(),
        rawLast.getMonth() + mult,
      );

    case 'semi_monthly': {
      const anchors = semiMonthlyAnchorDays(periodStart, rawLast.getFullYear(), rawLast.getMonth());
      const nextAnchor = anchors.find(day => day > rawLast.getDate());
      if (nextAnchor !== undefined) {
        return new Date(rawLast.getFullYear(), rawLast.getMonth(), nextAnchor);
      }
      const next = addMonths(rawLast, mult);
      const [firstAnchor] = semiMonthlyAnchorDays(periodStart, next.getFullYear(), next.getMonth());
      return new Date(next.getFullYear(), next.getMonth(), firstAnchor);
    }

    case 'year': {
      const targetYear = lastOccur.getFullYear() + mult;
      const month = periodStart.getMonth();
      const day = clampDay(targetYear, month, periodStart.getDate());
      return new Date(targetYear, month, day);
    }

    case 'once':
    default:
      return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), lastOccur.getDate());
  }
}
