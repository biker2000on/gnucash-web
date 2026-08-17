/**
 * Calculate a whole-number age from a birthday using calendar dates, never an
 * elapsed-time approximation. String birthdays are intentionally limited to
 * their ISO date portion so database values with an ISO time suffix work too.
 *
 * Callers that have stricter validation can pass already-validated date parts;
 * those parts are compared as supplied, preserving their existing contract.
 */
export function calculateCalendarAge(
  birthday: string | { year: number; month: number; day: number },
  asOf: Date,
  timeZone: 'utc' | 'local' = 'utc',
): number | null {
  let year: number;
  let month: number;
  let day: number;

  if (typeof birthday === 'string') {
    const suffix = timeZone === 'utc' ? 'Z' : '';
    const parsed = new Date(`${birthday.slice(0, 10)}T00:00:00${suffix}`);
    if (Number.isNaN(parsed.getTime())) return null;
    year = timeZone === 'utc' ? parsed.getUTCFullYear() : parsed.getFullYear();
    month = (timeZone === 'utc' ? parsed.getUTCMonth() : parsed.getMonth()) + 1;
    day = timeZone === 'utc' ? parsed.getUTCDate() : parsed.getDate();
  } else {
    ({ year, month, day } = birthday);
  }

  const asOfYear = timeZone === 'utc' ? asOf.getUTCFullYear() : asOf.getFullYear();
  const asOfMonth = (timeZone === 'utc' ? asOf.getUTCMonth() : asOf.getMonth()) + 1;
  const asOfDay = timeZone === 'utc' ? asOf.getUTCDate() : asOf.getDate();
  let age = asOfYear - year;
  if (asOfMonth < month || (asOfMonth === month && asOfDay < day)) age -= 1;
  return age;
}
