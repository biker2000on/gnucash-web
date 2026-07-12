'use client';

import { useState, useEffect } from 'react';
import type { CustomerSummaryReport } from '@/lib/business/customer-summary';
import type { DateRange } from '@/lib/datePresets';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { StatCard, StatGrid } from '@/components/ui/StatCard';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function Markup({ value }: { value: number | null }) {
    if (value === null) {
        return <span className="font-mono text-foreground-muted" style={TNUM}>—</span>;
    }
    return (
        <span className={`font-mono ${value < 0 ? 'text-negative' : 'text-foreground-secondary'}`} style={TNUM}>
            {value.toFixed(1)}%
        </span>
    );
}

function Profit({ value }: { value: number }) {
    return (
        <span className={`font-mono ${value < -0.005 ? 'text-negative' : 'text-foreground'}`} style={TNUM}>
            {formatCurrency(value)}
        </span>
    );
}

export default function CustomerSummaryPage() {
    const today = new Date().toISOString().slice(0, 10);
    const [startDate, setStartDate] = useState<string | null>(`${today.slice(0, 4)}-01-01`);
    const [endDate, setEndDate] = useState<string | null>(today);
    const [report, setReport] = useState<CustomerSummaryReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // An open-ended range ("All Time") still needs concrete API bounds.
    const effectiveStart = startDate ?? '1900-01-01';
    const effectiveEnd = endDate ?? today;

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(
                    `/api/business/reports/customer-summary?startDate=${effectiveStart}&endDate=${effectiveEnd}`,
                );
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: CustomerSummaryReport = await res.json();
                if (!cancelled) setReport(json);
            } catch {
                if (!cancelled) setError('Failed to load the customer summary.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [effectiveStart, effectiveEnd]);

    const handleRangeChange = (range: DateRange) => {
        setStartDate(range.startDate);
        setEndDate(range.endDate);
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Customer Summary"
                subtitle="Sales, attributable expenses, profit and markup per customer from posted documents."
                toolbar={
                    <FilterBar
                        primary={
                            <DateRangePicker
                                startDate={startDate}
                                endDate={endDate}
                                onChange={handleRangeChange}
                            />
                        }
                    />
                }
            />

            {loading && (
                <div className="flex items-center justify-center py-12">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            )}

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && report && (
                <>
                    <StatGrid cols={3}>
                        <StatCard
                            label="Sales"
                            value={formatCurrency(report.totals.sales)}
                            size="compact"
                        />
                        <StatCard
                            label="Expenses"
                            value={formatCurrency(report.totals.expenses)}
                            size="compact"
                        />
                        <StatCard
                            label="Profit"
                            value={formatCurrency(report.totals.profit)}
                            size="compact"
                        />
                    </StatGrid>

                    {report.rows.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No posted customer activity in this range. Post customer invoices and
                                they will show up here.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[640px] text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                            <th className="px-4 py-3 text-left">Customer</th>
                                            <th className="px-4 py-3 text-right">Sales</th>
                                            <th className="px-4 py-3 text-right">Expenses</th>
                                            <th className="px-4 py-3 text-right">Profit</th>
                                            <th className="px-4 py-3 text-right">Markup %</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {report.rows.map((row) => (
                                            <tr
                                                key={row.customerGuid}
                                                className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors"
                                            >
                                                <td className="px-4 py-2.5 text-foreground">{row.customerName}</td>
                                                <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                                    {formatCurrency(row.sales)}
                                                </td>
                                                <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                                    {formatCurrency(row.expenses)}
                                                </td>
                                                <td className="px-4 py-2.5 text-right">
                                                    <Profit value={row.profit} />
                                                </td>
                                                <td className="px-4 py-2.5 text-right">
                                                    <Markup value={row.markupPercent} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr className="border-t border-border font-medium bg-background-secondary/20">
                                            <td className="px-4 py-3 text-foreground">
                                                Total
                                                <span className="ml-2 text-xs font-normal text-foreground-muted font-mono" style={TNUM}>
                                                    {report.rows.length} customers
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(report.totals.sales)}
                                            </td>
                                            <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(report.totals.expenses)}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <Profit value={report.totals.profit} />
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <Markup value={report.totals.markupPercent} />
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>
                    )}

                    <p className="text-xs text-foreground-muted">
                        Sales are income splits from posted documents owned by the customer (jobs
                        resolve to their customer). Expenses are expense splits from documents owned
                        by — or charged back to (billto) — the customer. Markup % = profit /
                        expenses. Sorted by profit.
                    </p>
                </>
            )}
        </div>
    );
}
