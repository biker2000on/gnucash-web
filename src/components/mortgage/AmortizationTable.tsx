'use client';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AmortizationRow {
  month: number;
  date?: string;           // ISO date string (YYYY-MM-DD) for actual payments
  payment: number;
  principal: number;
  interest: number;
  extra: number;
  balance: number;
  actual?: boolean;        // true = actual payment from GnuCash, false/undefined = projected
}

interface AmortizationTableProps {
  schedule: AmortizationRow[];
  showExtraPayment?: boolean;
  showDates?: boolean;     // show date column instead of month number
}

/* ------------------------------------------------------------------ */
/* Formatter                                                           */
/* ------------------------------------------------------------------ */

const fmtFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const fmtDate = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short' });

export function AmortizationTable({ schedule, showExtraPayment = true, showDates = false }: AmortizationTableProps) {
  if (schedule.length === 0) return null;

  // Totals row
  const totals = schedule.reduce(
    (acc, row) => ({
      payment: acc.payment + row.payment,
      principal: acc.principal + row.principal,
      interest: acc.interest + row.interest,
      extra: acc.extra + row.extra,
    }),
    { payment: 0, principal: 0, interest: 0, extra: 0 },
  );

  const hasExtra = showExtraPayment && schedule.some(r => r.extra > 0);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="max-h-96 overflow-y-auto overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="sticky top-0 bg-background-secondary z-10">
            <tr className="text-foreground-muted text-xs uppercase tracking-wider">
              <th className="text-left py-3 px-4 font-medium sticky left-0 bg-background-secondary z-20">{showDates ? 'Date' : 'Month'}</th>
              <th className="text-right py-3 px-4 font-medium">Payment</th>
              <th className="text-right py-3 px-4 font-medium">Principal</th>
              <th className="text-right py-3 px-4 font-medium">Interest</th>
              {hasExtra && <th className="text-right py-3 px-4 font-medium">Extra</th>}
              <th className="text-right py-3 px-4 font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((row, idx) => {
              const isPayoffMonth = row.balance <= 0 || idx === schedule.length - 1;
              const isActual = row.actual === true;
              const isFirstProjected = !isActual && idx > 0 && schedule[idx - 1]?.actual === true;
              return (
                <tr
                  key={row.month}
                  className={`border-t border-border/50 ${
                    isFirstProjected
                      ? 'border-t-2 border-t-cyan-500/50'
                      : ''
                  } ${
                    isPayoffMonth
                      ? 'bg-primary/10 font-semibold'
                      : isActual
                        ? idx % 2 === 0 ? 'bg-transparent' : 'bg-surface/20'
                        : idx % 2 === 0 ? 'bg-transparent opacity-75' : 'bg-surface/20 opacity-75'
                  }`}
                >
                  <td className="py-2 px-4 text-foreground tabular-nums sticky left-0 bg-inherit">
                    {showDates && row.date
                      ? fmtDate.format(new Date(row.date + 'T00:00:00'))
                      : row.month}
                    {isFirstProjected && (
                      <span className="ml-2 text-[10px] text-cyan-400 uppercase tracking-wider font-medium">projected</span>
                    )}
                  </td>
                  <td className="py-2 px-4 text-right text-foreground tabular-nums">{fmtFull.format(row.payment)}</td>
                  <td className="py-2 px-4 text-right text-emerald-400 tabular-nums">{fmtFull.format(row.principal)}</td>
                  <td className="py-2 px-4 text-right text-rose-400 tabular-nums">{fmtFull.format(row.interest)}</td>
                  {hasExtra && <td className="py-2 px-4 text-right text-primary tabular-nums">{fmtFull.format(row.extra)}</td>}
                  <td className="py-2 px-4 text-right text-foreground tabular-nums">{fmtFull.format(row.balance)}</td>
                </tr>
              );
            })}
            {/* Totals row */}
            <tr className="border-t-2 border-border bg-surface/30 font-bold">
              <td className="py-3 px-4 text-foreground sticky left-0 bg-surface/30">Total</td>
              <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmtFull.format(totals.payment)}</td>
              <td className="py-3 px-4 text-right text-emerald-400 tabular-nums">{fmtFull.format(totals.principal)}</td>
              <td className="py-3 px-4 text-right text-rose-400 tabular-nums">{fmtFull.format(totals.interest)}</td>
              {hasExtra && <td className="py-3 px-4 text-right text-primary tabular-nums">{fmtFull.format(totals.extra)}</td>}
              <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmtFull.format(0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
