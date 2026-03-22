'use client';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AmortizationRow {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  extra: number;
  balance: number;
}

interface AmortizationTableProps {
  schedule: AmortizationRow[];
  showExtraPayment?: boolean;
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

export function AmortizationTable({ schedule, showExtraPayment = true }: AmortizationTableProps) {
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
              <th className="text-left py-3 px-4 font-medium sticky left-0 bg-background-secondary z-20">Month</th>
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
              return (
                <tr
                  key={row.month}
                  className={`border-t border-border/50 ${
                    isPayoffMonth
                      ? 'bg-emerald-500/10 font-semibold'
                      : idx % 2 === 0
                        ? 'bg-transparent'
                        : 'bg-surface/20'
                  }`}
                >
                  <td className="py-2 px-4 text-foreground tabular-nums sticky left-0 bg-inherit">{row.month}</td>
                  <td className="py-2 px-4 text-right text-foreground tabular-nums">{fmtFull.format(row.payment)}</td>
                  <td className="py-2 px-4 text-right text-emerald-400 tabular-nums">{fmtFull.format(row.principal)}</td>
                  <td className="py-2 px-4 text-right text-rose-400 tabular-nums">{fmtFull.format(row.interest)}</td>
                  {hasExtra && <td className="py-2 px-4 text-right text-cyan-400 tabular-nums">{fmtFull.format(row.extra)}</td>}
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
              {hasExtra && <td className="py-3 px-4 text-right text-cyan-400 tabular-nums">{fmtFull.format(totals.extra)}</td>}
              <td className="py-3 px-4 text-right text-foreground tabular-nums">{fmtFull.format(0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
