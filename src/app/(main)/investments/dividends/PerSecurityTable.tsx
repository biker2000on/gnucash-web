'use client';

import { formatCurrency } from '@/lib/format';
import type { PerSecurityDividend } from '@/lib/dividends';

function formatPercent(value: number | null): string {
    if (value == null) return '—';
    return `${value.toFixed(2)}%`;
}

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y.slice(2)}`;
}

interface PerSecurityTableProps {
    rows: PerSecurityDividend[];
    /** When set, show a year column with each security's income for that year. */
    year?: number | null;
}

export function PerSecurityTable({ rows, year }: PerSecurityTableProps) {
    if (rows.length === 0) {
        return (
            <div className="bg-surface border border-border rounded-lg p-8 text-center">
                <p className="text-foreground-secondary">No dividend-paying securities found.</p>
            </div>
        );
    }

    const mono = { fontFeatureSettings: "'tnum'" } as const;

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border text-foreground-secondary">
                            <th className="text-left font-medium px-4 py-2.5">Security</th>
                            {year != null && (
                                <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">{year}</th>
                            )}
                            <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">TTM Income</th>
                            <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">Yield on Cost</th>
                            <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">Current Yield</th>
                            <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">Last Paid</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => (
                            <tr
                                key={row.commodityGuid ?? row.ticker}
                                className="border-b border-border/40 last:border-0 hover:bg-surface-hover transition-colors"
                            >
                                <td className="px-4 py-2.5">
                                    <span className="font-medium text-foreground">{row.ticker}</span>
                                    {row.commodityGuid == null && (
                                        <span className="ml-2 text-xs text-foreground-muted">(cash)</span>
                                    )}
                                </td>
                                {year != null && (
                                    <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={mono}>
                                        {formatCurrency(row.yearIncome ?? 0)}
                                    </td>
                                )}
                                <td className="px-4 py-2.5 text-right font-mono text-foreground" style={mono}>
                                    {formatCurrency(row.ttmIncome)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-positive" style={mono}>
                                    {formatPercent(row.yieldOnCost)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={mono}>
                                    {formatPercent(row.currentYield)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-foreground-muted" style={mono}>
                                    {formatDate(row.lastPaymentDate)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
