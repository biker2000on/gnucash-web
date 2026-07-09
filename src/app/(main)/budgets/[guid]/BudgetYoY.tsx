'use client';

import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import type { YoYAccountDelta, YoYResult, YoYTotals } from '@/lib/budget-actuals';

interface BudgetYoYProps {
    yoy: YoYResult;
    currency: string;
    /** Label describing the compared window, e.g. "Jan 2026 – Jul 2026" */
    windowLabel?: string;
}

/**
 * Delta color: for expense accounts spending MORE than last year is bad
 * (negative tone); for income accounts earning more is good (positive tone).
 */
function deltaClass(row: { type: string; delta: number }): string {
    if (Math.abs(row.delta) < 0.005) return 'text-foreground-secondary';
    const isGood = row.type === 'INCOME' ? row.delta > 0 : row.delta < 0;
    return isGood ? 'text-positive' : 'text-negative';
}

function signed(value: number, currency: string): string {
    return `${value >= 0 ? '+' : '−'}${formatCurrency(Math.abs(value), currency)}`;
}

function signedPct(value: number | null): string {
    if (value === null) return '—';
    return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;
}

function TotalsRow({ label, totals, currency, type }: { label: string; totals: YoYTotals; currency: string; type: string }) {
    return (
        <tr className="bg-background-tertiary/50 font-semibold border-t border-border">
            <td className="px-4 py-2.5 text-sm text-foreground">{label}</td>
            <td className="px-4 py-2.5 text-right font-mono text-sm tabular-nums text-foreground-secondary">
                {formatCurrency(totals.prior, currency)}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-sm tabular-nums text-foreground">
                {formatCurrency(totals.current, currency)}
            </td>
            <td className={`px-4 py-2.5 text-right font-mono text-sm tabular-nums ${deltaClass({ type, delta: totals.delta })}`}>
                {signed(totals.delta, currency)}
            </td>
            <td className={`px-4 py-2.5 text-right font-mono text-sm tabular-nums ${deltaClass({ type, delta: totals.delta })}`}>
                {signedPct(totals.percent)}
            </td>
        </tr>
    );
}

export function BudgetYoY({ yoy, currency, windowLabel }: BudgetYoYProps) {
    if (!yoy.hasPriorData) {
        return (
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6">
                <h2 className="text-base font-semibold text-foreground mb-1">Year over Year</h2>
                <p className="text-sm text-foreground-muted">
                    No activity found in the same period last year — nothing to compare yet.
                </p>
            </div>
        );
    }

    const rows: YoYAccountDelta[] = yoy.accounts;

    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-base font-semibold text-foreground">Year over Year</h2>
                {windowLabel && (
                    <span className="text-xs text-foreground-muted">
                        {windowLabel} vs same window last year
                    </span>
                )}
            </div>
            <div className="overflow-x-auto">
                <table className="w-full">
                    <thead>
                        <tr className="text-foreground-secondary text-xs uppercase tracking-widest bg-background-secondary">
                            <th className="px-4 py-3 text-left font-semibold">Account</th>
                            <th className="px-4 py-3 text-right font-semibold">Last Year</th>
                            <th className="px-4 py-3 text-right font-semibold">This Year</th>
                            <th className="px-4 py-3 text-right font-semibold">Change</th>
                            <th className="px-4 py-3 text-right font-semibold">%</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                        {rows.map(row => (
                            <tr key={row.guid} className="hover:bg-surface-hover/50 transition-colors">
                                <td className="px-4 py-2.5">
                                    <Link
                                        href={`/accounts/${row.guid}`}
                                        className="text-sm text-foreground hover:text-primary transition-colors"
                                    >
                                        {row.name}
                                    </Link>
                                    <span className="ml-2 text-[10px] uppercase tracking-wider text-foreground-muted">
                                        {row.type}
                                    </span>
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-sm tabular-nums text-foreground-secondary">
                                    {formatCurrency(row.prior, currency)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-sm tabular-nums text-foreground">
                                    {formatCurrency(row.current, currency)}
                                </td>
                                <td className={`px-4 py-2.5 text-right font-mono text-sm tabular-nums ${deltaClass(row)}`}>
                                    {signed(row.delta, currency)}
                                </td>
                                <td className={`px-4 py-2.5 text-right font-mono text-sm tabular-nums ${deltaClass(row)}`}>
                                    {signedPct(row.percent)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <TotalsRow label="Total Expenses" totals={yoy.totals.expense} currency={currency} type="EXPENSE" />
                        {yoy.totals.income && (
                            <TotalsRow label="Total Income" totals={yoy.totals.income} currency={currency} type="INCOME" />
                        )}
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
