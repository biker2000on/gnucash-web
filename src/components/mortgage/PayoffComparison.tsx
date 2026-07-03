'use client';

import type { ReactNode } from 'react';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
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
/* Mobile metric card                                                  */
/* ------------------------------------------------------------------ */

function ComparisonCard({ label, current, plan }: {
  label: string;
  current: ReactNode;
  plan: ReactNode;
}) {
  return (
    <div className="p-4 border-b border-border">
      <p className="text-xs text-foreground-muted uppercase tracking-wider">{label}</p>
      <div className="mt-1.5 flex justify-between items-baseline py-0.5">
        <span className="text-xs text-foreground-muted">Current Plan</span>
        <span className="text-sm text-foreground text-right font-mono tabular-nums">{current}</span>
      </div>
      <div className="flex justify-between items-baseline py-0.5">
        <span className="text-xs text-foreground-muted">Your Plan</span>
        <span className="text-sm text-right font-mono tabular-nums font-semibold">{plan}</span>
      </div>
    </div>
  );
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
  const isMobile = useIsMobile();
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
      {isMobile ? (
        <div>
          <ComparisonCard
            label="Monthly Payment"
            current={fmtFull.format(originalPayment)}
            plan={<span className="text-primary">{fmtFull.format(acceleratedPayment)}</span>}
          />
          <ComparisonCard
            label="Payoff Term"
            current={formatMonthsToYearsMonths(originalSchedule.length)}
            plan={<span className="text-positive">{formatMonthsToYearsMonths(acceleratedSchedule.length)}</span>}
          />
          <ComparisonCard
            label="Total Interest"
            current={fmt.format(originalInterest)}
            plan={<span className="text-positive">{fmt.format(acceleratedInterest)}</span>}
          />
          <ComparisonCard
            label="Total Paid"
            current={fmt.format(originalTotal)}
            plan={<span className="text-positive">{fmt.format(acceleratedTotal)}</span>}
          />
          {/* Savings summary card */}
          <div className="p-4 border-t-2 border-primary/30 bg-primary/10">
            <p className="text-xs text-primary font-semibold uppercase tracking-wider">Savings</p>
            <div className="mt-1.5 space-y-0.5 text-sm text-primary font-semibold">
              <div className="flex justify-between items-baseline py-0.5">
                <span className="text-xs font-normal text-primary/70">Extra per month</span>
                <span className="font-mono tabular-nums text-right">+{fmtFull.format(paymentDelta)}/mo</span>
              </div>
              {monthsDelta > 0 && (
                <div className="flex justify-between items-baseline py-0.5">
                  <span className="text-xs font-normal text-primary/70">Paid off</span>
                  <span className="text-right">{formatMonthsToYearsMonths(monthsDelta)} sooner</span>
                </div>
              )}
              <div className="flex justify-between items-baseline py-0.5">
                <span className="text-xs font-normal text-primary/70">Interest saved</span>
                <span className="font-mono tabular-nums text-right">{fmt.format(interestDelta)}</span>
              </div>
              <div className="flex justify-between items-baseline py-0.5">
                <span className="text-xs font-normal text-primary/70">Total saved</span>
                <span className="font-mono tabular-nums text-right">{fmt.format(totalDelta)}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
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
            <td className="py-3 px-4 text-right text-positive font-semibold">{formatMonthsToYearsMonths(acceleratedSchedule.length)}</td>
          </tr>
          <tr className="border-t border-border/50">
            <td className="py-3 px-4 text-foreground-muted font-medium">Total Interest</td>
            <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmt.format(originalInterest)}</td>
            <td className="py-3 px-4 text-right text-positive font-semibold tabular-nums">{fmt.format(acceleratedInterest)}</td>
          </tr>
          <tr className="border-t border-border/50 bg-surface/20">
            <td className="py-3 px-4 text-foreground-muted font-medium">Total Paid</td>
            <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmt.format(originalTotal)}</td>
            <td className="py-3 px-4 text-right text-positive font-semibold tabular-nums">{fmt.format(acceleratedTotal)}</td>
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
      )}
    </div>
  );
}
