'use client';

import type { AmortizationRow } from './AmortizationTable';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatMonthsToYearsMonths(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} month${m !== 1 ? 's' : ''}`;
  if (m === 0) return `${y} year${y !== 1 ? 's' : ''}`;
  return `${y} year${y !== 1 ? 's' : ''}, ${m} month${m !== 1 ? 's' : ''}`;
}

function totalInterestFromSchedule(schedule: AmortizationRow[]): number {
  return schedule.reduce((sum, r) => sum + r.interest, 0);
}

function totalPaidFromSchedule(schedule: AmortizationRow[]): number {
  return schedule.reduce((sum, r) => sum + r.payment, 0);
}

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

interface PayoffComparisonProps {
  originalSchedule: AmortizationRow[];
  acceleratedSchedule: AmortizationRow[];
  originalPayment: number;
  acceleratedPayment: number;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function PayoffComparison({
  originalSchedule,
  acceleratedSchedule,
  originalPayment,
  acceleratedPayment,
}: PayoffComparisonProps) {
  const originalInterest = totalInterestFromSchedule(originalSchedule);
  const acceleratedInterest = totalInterestFromSchedule(acceleratedSchedule);
  const originalTotal = totalPaidFromSchedule(originalSchedule);
  const acceleratedTotal = totalPaidFromSchedule(acceleratedSchedule);

  const monthsDelta = originalSchedule.length - acceleratedSchedule.length;
  const interestDelta = originalInterest - acceleratedInterest;
  const totalDelta = originalTotal - acceleratedTotal;
  const paymentDelta = acceleratedPayment - originalPayment;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-background-secondary">
          <tr className="text-foreground-muted text-xs uppercase tracking-wider">
            <th className="text-left py-3 px-4 font-medium"></th>
            <th className="text-right py-3 px-4 font-medium">Current Plan</th>
            <th className="text-right py-3 px-4 font-medium">Your Plan</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border/50">
            <td className="py-3 px-4 text-foreground-muted font-medium">Monthly Payment</td>
            <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmtFull.format(originalPayment)}</td>
            <td className="py-3 px-4 text-right text-primary font-semibold tabular-nums">{fmtFull.format(acceleratedPayment)}</td>
          </tr>
          <tr className="border-t border-border/50 bg-surface/20">
            <td className="py-3 px-4 text-foreground-muted font-medium">Payoff Term</td>
            <td className="py-3 px-4 text-right text-foreground">{formatMonthsToYearsMonths(originalSchedule.length)}</td>
            <td className="py-3 px-4 text-right text-emerald-400 font-semibold">{formatMonthsToYearsMonths(acceleratedSchedule.length)}</td>
          </tr>
          <tr className="border-t border-border/50">
            <td className="py-3 px-4 text-foreground-muted font-medium">Total Interest</td>
            <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmt.format(originalInterest)}</td>
            <td className="py-3 px-4 text-right text-emerald-400 font-semibold tabular-nums">{fmt.format(acceleratedInterest)}</td>
          </tr>
          <tr className="border-t border-border/50 bg-surface/20">
            <td className="py-3 px-4 text-foreground-muted font-medium">Total Paid</td>
            <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmt.format(originalTotal)}</td>
            <td className="py-3 px-4 text-right text-emerald-400 font-semibold tabular-nums">{fmt.format(acceleratedTotal)}</td>
          </tr>
          {/* Delta row */}
          <tr className="border-t-2 border-primary/30 bg-primary/10">
            <td className="py-3 px-4 text-primary font-semibold">Savings</td>
            <td className="py-3 px-4 text-right text-primary font-semibold tabular-nums">
              +{fmtFull.format(paymentDelta)}/mo
            </td>
            <td className="py-3 px-4 text-right text-primary font-semibold">
              {monthsDelta > 0 && <span className="block">{formatMonthsToYearsMonths(monthsDelta)} sooner</span>}
              <span className="block tabular-nums">{fmt.format(interestDelta)} interest saved</span>
              <span className="block text-xs text-primary/70 tabular-nums">{fmt.format(totalDelta)} total saved</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
