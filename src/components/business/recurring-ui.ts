/**
 * Recurring invoice UI helpers — pure, client-safe (no prisma import).
 * Maps the human cadence choices (weekly/monthly/quarterly/yearly) onto the
 * recurrence-engine pattern (periodType + mult) stored on definitions.
 */

import type {
  RecurringInvoiceDef,
  RecurringPeriodType,
  RecurringTemplate,
} from '@/lib/business/recurring-invoices';

export type { RecurringInvoiceDef, RecurringPeriodType, RecurringTemplate };

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const CADENCE_OPTIONS: Array<{ value: Cadence; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

/** Cadence + "every N" -> stored pattern. Quarterly = months x 3. */
export function cadenceToPattern(
  cadence: Cadence,
  every: number,
): { periodType: RecurringPeriodType; mult: number } {
  const n = Number.isInteger(every) && every >= 1 ? every : 1;
  switch (cadence) {
    case 'weekly': return { periodType: 'weekly', mult: n };
    case 'quarterly': return { periodType: 'month', mult: 3 * n };
    case 'yearly': return { periodType: 'year', mult: n };
    case 'monthly':
    default: return { periodType: 'month', mult: n };
  }
}

/** Stored pattern -> closest cadence + "every N" (for the edit form). */
export function patternToCadence(
  periodType: RecurringPeriodType,
  mult: number,
): { cadence: Cadence; every: number } {
  if (periodType === 'weekly') return { cadence: 'weekly', every: mult };
  if (periodType === 'year') return { cadence: 'yearly', every: mult };
  if (periodType === 'month' && mult % 3 === 0) return { cadence: 'quarterly', every: mult / 3 };
  return { cadence: 'monthly', every: mult };
}

/** Human label for a stored pattern, e.g. "Monthly", "Every 2 weeks". */
export function cadenceLabel(periodType: RecurringPeriodType, mult: number): string {
  if (periodType === 'daily') return mult === 1 ? 'Daily' : `Every ${mult} days`;
  if (periodType === 'weekly') return mult === 1 ? 'Weekly' : `Every ${mult} weeks`;
  if (periodType === 'year') return mult === 1 ? 'Yearly' : `Every ${mult} years`;
  if (mult === 1) return 'Monthly';
  if (mult === 3) return 'Quarterly';
  if (mult % 3 === 0) return `Every ${mult / 3} quarters`;
  return `Every ${mult} months`;
}
