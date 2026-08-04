/**
 * Holding-period classification — the SINGLE source of truth for the IRS
 * long-term vs short-term rule.
 *
 * IRS long-term = held MORE than one year. The holding period begins the day
 * after acquisition, so a sale is long-term only if it falls strictly after
 * the same calendar date one year later. This is a CALENDAR-ANNIVERSARY rule,
 * not a day count: a sale on the exact one-year anniversary is short-term even
 * when 366 elapsed days separate the dates (leap years).
 *
 * Both arguments are normalized to their CALENDAR DAY first: post-date times of
 * day vary across a real book (legacy rows carry 05:59-10:59Z clock times,
 * app-written rows are T12:00:00Z) and the time of day must never decide the
 * holding term. Everything is anchored in UTC so the runtime timezone cannot
 * shift a day boundary either.
 *
 * Duplicated 365-day millisecond thresholds previously lived in
 * lot-scrub.ts (classifyHoldingPeriod) and tax/book-income.ts (ONE_YEAR_MS);
 * both now delegate here, as does reports/capital-gains.ts.
 */

export type Term = 'short_term' | 'long_term';

/** Normalize an ISO string / Date to its YYYY-MM-DD day (UTC). */
function toDay(date: string | Date): string {
  const iso = typeof date === 'string' ? date : date.toISOString();
  return iso.slice(0, 10);
}

/**
 * IRS "more than one year" rule, applied strictly on calendar days.
 * Accepts ISO strings or Date objects.
 */
export function isLongTerm(dateAcquired: string | Date, dateSold: string | Date): boolean {
  const acquired = new Date(`${toDay(dateAcquired)}T00:00:00.000Z`);
  const sold = new Date(`${toDay(dateSold)}T00:00:00.000Z`);
  const oneYearLater = new Date(acquired);
  oneYearLater.setUTCFullYear(oneYearLater.getUTCFullYear() + 1);
  return sold.getTime() > oneYearLater.getTime();
}

export function computeTerm(dateAcquired: string | Date, dateSold: string | Date): Term {
  return isLongTerm(dateAcquired, dateSold) ? 'long_term' : 'short_term';
}
