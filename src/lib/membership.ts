/**
 * Membership domain logic — renewal-period computation and dues status.
 * Pure functions over ISO date strings (YYYY-MM-DD); client-safe.
 *
 * Renewal modes (per membership type):
 * - calendar_year: everyone expires 12/31. A payment covers the calendar
 *   year of the paid date — or the next year when the member is already
 *   paid through this year's end (early renewal).
 * - anniversary: rotating annual — one year from the paid date, extending
 *   from the current paid-through date when renewing early.
 * - lifetime: never expires (period_end = null).
 */

export type RenewalMode = 'calendar_year' | 'anniversary' | 'lifetime';

export const RENEWAL_MODES: RenewalMode[] = ['calendar_year', 'anniversary', 'lifetime'];

export const RENEWAL_MODE_LABELS: Record<RenewalMode, string> = {
    calendar_year: 'Calendar year (all expire 12/31)',
    anniversary: 'Anniversary (one year from payment)',
    lifetime: 'Lifetime (never expires)',
};

export type MemberStatus = 'active' | 'honorary' | 'resigned';

export type DuesStatus = 'current' | 'lifetime' | 'lapsed' | 'unpaid' | 'exempt';

export interface MembershipPeriod {
    /** ISO date (YYYY-MM-DD). */
    periodStart: string;
    /** ISO date, or null for lifetime memberships. */
    periodEnd: string | null;
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function toIso(y: number, m: number, d: number): string {
    return `${y}-${pad(m)}-${pad(d)}`;
}

function parseIso(date: string): { y: number; m: number; d: number } {
    const [y, m, d] = date.slice(0, 10).split('-').map(Number);
    return { y, m, d };
}

/** date + n days, all in ISO strings (UTC math, no timezone drift). */
export function addDays(date: string, days: number): string {
    const { y, m, d } = parseIso(date);
    const t = Date.UTC(y, m - 1, d + days);
    const dt = new Date(t);
    return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** date + 1 year − 1 day (annual coverage ending the day before the anniversary). */
function addOneYearMinusDay(date: string): string {
    const { y, m, d } = parseIso(date);
    // Feb 29 → next year's Feb 28 handled by Date.UTC rollover semantics
    const t = Date.UTC(y + 1, m - 1, d - 1);
    const dt = new Date(t);
    return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Compute the coverage period for a payment.
 *
 * @param mode          The membership type's renewal mode.
 * @param paidDate      ISO date the payment was received.
 * @param paidThrough   The member's current paid-through date (max period_end
 *                      across prior payments), or null when never paid.
 */
export function computeMembershipPeriod(
    mode: RenewalMode,
    paidDate: string,
    paidThrough: string | null
): MembershipPeriod {
    if (mode === 'lifetime') {
        return { periodStart: paidDate, periodEnd: null };
    }

    if (mode === 'calendar_year') {
        const { y } = parseIso(paidDate);
        const thisYearEnd = toIso(y, 12, 31);
        // Already covered through this year → the payment renews next year.
        const targetYear = paidThrough && paidThrough >= thisYearEnd
            ? parseIso(paidThrough).y + 1
            : y;
        return { periodStart: toIso(targetYear, 1, 1), periodEnd: toIso(targetYear, 12, 31) };
    }

    // anniversary: extend from paid-through when renewing early
    const start = paidThrough && paidThrough >= paidDate ? addDays(paidThrough, 1) : paidDate;
    return { periodStart: start, periodEnd: addOneYearMinusDay(start) };
}

/**
 * Dues status for display/filters.
 *
 * @param status       The member's standing (active/honorary/resigned).
 * @param paidThrough  Max period_end across payments; null = never paid.
 * @param hasLifetime  True when any payment has period_end = null.
 * @param graceDays    Days past expiry the member still counts as current.
 * @param today        ISO date for "now" (injectable for tests).
 */
export function computeDuesStatus(
    status: MemberStatus | string,
    paidThrough: string | null,
    hasLifetime: boolean,
    graceDays: number,
    today: string
): DuesStatus {
    if (status === 'honorary') return 'exempt';
    if (hasLifetime) return 'lifetime';
    if (!paidThrough) return 'unpaid';
    return addDays(paidThrough, Math.max(0, graceDays)) >= today ? 'current' : 'lapsed';
}

export const DUES_STATUS_LABELS: Record<DuesStatus, string> = {
    current: 'Current',
    lifetime: 'Lifetime',
    lapsed: 'Lapsed',
    unpaid: 'Unpaid',
    exempt: 'Exempt',
};

export type AttendanceStatus = 'present' | 'absent' | 'excused';

export const ATTENDANCE_STATUSES: AttendanceStatus[] = ['present', 'absent', 'excused'];

export const MEMBER_STATUSES: MemberStatus[] = ['active', 'honorary', 'resigned'];

export const PAYMENT_METHODS = ['cash', 'check', 'card', 'zeffy', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
