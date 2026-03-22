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
  const year = base.getFullYear();
  const month = base.getMonth() + n;
  const day = base.getDate();

  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const clampedDay = clampDay(targetYear, targetMonth, day);

  return new Date(targetYear, targetMonth, clampedDay);
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
      while (true) {
        const d = addMonths(startFrom, step * mult);
        yield d;
        step++;
      }
    }
    case 'end of month': {
      while (true) {
        const d = addMonths(startFrom, step * mult);
        // Force to last day of that month
        const last = lastDayOfMonth(d.getFullYear(), d.getMonth());
        yield new Date(d.getFullYear(), d.getMonth(), last);
        step++;
      }
    }
    case 'semi_monthly': {
      // Generates 1st and 15th of each month (or last day if month < 15 days, which doesn't happen but we handle it)
      // Start from the anchor month and go forward
      const baseYear = startFrom.getFullYear();
      const baseMonth = startFrom.getMonth();
      let monthOffset = 0;
      while (true) {
        const totalMonth = baseMonth + monthOffset * mult;
        const y = baseYear + Math.floor(totalMonth / 12);
        const m = ((totalMonth % 12) + 12) % 12;
        const last = lastDayOfMonth(y, m);

        // 1st of the month
        yield new Date(y, m, 1);
        // 15th (or last day if month is shorter, though all months have >= 28 days)
        yield new Date(y, m, Math.min(15, last));

        monthOffset++;
      }
    }
    case 'year': {
      while (true) {
        const baseYear = startFrom.getFullYear() + step * mult;
        const month = startFrom.getMonth();
        const day = clampDay(baseYear, month, startFrom.getDate());
        yield new Date(baseYear, month, day);
        step++;
      }
    }
    case 'nth weekday':
    case 'last weekday': {
      // Simplified: treat like monthly for now
      while (true) {
        const d = addMonths(startFrom, step * mult);
        yield d;
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
 * Compute the first occurrence after the last known occurrence.
 * This advances by one interval from lastOccur.
 */
function computeFirstAfterLast(pattern: RecurrencePattern, lastOccur: Date): Date {
  const { periodType, mult } = pattern;

  switch (periodType) {
    case 'daily':
      return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), lastOccur.getDate() + mult);

    case 'weekly':
      return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), lastOccur.getDate() + mult * 7);

    case 'month':
    case 'end of month':
    case 'nth weekday':
    case 'last weekday':
      return addMonths(lastOccur, mult);

    case 'semi_monthly': {
      // Advance to next semi-monthly date
      const day = lastOccur.getDate();
      if (day < 15) {
        return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), 15);
      } else {
        // Go to 1st of next month
        const next = addMonths(lastOccur, 1);
        return new Date(next.getFullYear(), next.getMonth(), 1);
      }
    }

    case 'year': {
      const targetYear = lastOccur.getFullYear() + mult;
      const month = lastOccur.getMonth();
      const day = clampDay(targetYear, month, lastOccur.getDate());
      return new Date(targetYear, month, day);
    }

    case 'once':
    default:
      return new Date(lastOccur.getFullYear(), lastOccur.getMonth(), lastOccur.getDate());
  }
}
