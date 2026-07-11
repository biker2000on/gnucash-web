'use client';

import { useState, useEffect } from 'react';
import type { SalesTaxReport } from '@/lib/business/business-reports';
import type { DateRange } from '@/lib/datePresets';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { StatCard, StatGrid } from '@/components/ui/StatCard';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function monthLabel(month: string): string {
    const [y, m] = month.split('-').map((v) => parseInt(v, 10));
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

export default function SalesTaxPage() {
    const today = new Date().toISOString().slice(0, 10);
    const [startDate, setStartDate] = useState<string | null>(`${today.slice(0, 4)}-01-01`);
    const [endDate, setEndDate] = useState<string | null>(today);
    const [report, setReport] = useState<SalesTaxReport | null>(null);
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
                    `/api/business/reports/sales-tax?startDate=${effectiveStart}&endDate=${effectiveEnd}`,
                );
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: SalesTaxReport = await res.json();
                if (!cancelled) setReport(json);
            } catch {
                if (!cancelled) setError('Failed to load the sales tax report.');
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
                title="Sales Tax"
                subtitle="Tax collected per tax-table target account from posted customer invoices, with a monthly filing summary."
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
                    {/* Totals */}
                    <StatGrid cols={2}>
                        <StatCard
                            label="Invoiced Sales"
                            value={formatCurrency(report.totals.taxableSales)}
                            size="compact"
                        />
                        <StatCard
                            label="Tax Collected"
                            value={formatCurrency(report.totals.taxCollected)}
                            size="compact"
                        />
                    </StatGrid>

                    {report.accounts.length === 0 && report.monthly.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No tax was collected on posted invoices in this range. Post customer
                                invoices with a tax table applied and they will show up here.
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* Per tax account/table */}
                            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                                <div className="p-4 border-b border-border">
                                    <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                                        By Tax Account
                                    </h3>
                                </div>
                                {report.accounts.length === 0 ? (
                                    <div className="p-8 text-center text-foreground-muted text-sm">
                                        No tax-table splits in this range.
                                    </div>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                                    <th className="px-4 py-3 text-left">Account</th>
                                                    <th className="px-4 py-3 text-left">Tax table / rate</th>
                                                    <th className="px-4 py-3 text-right">Collected</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {report.accounts.map((a) => (
                                                    <tr
                                                        key={a.accountGuid}
                                                        className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors"
                                                    >
                                                        <td className="px-4 py-2.5 text-foreground">{a.accountName}</td>
                                                        <td className="px-4 py-2.5 text-foreground-secondary">
                                                            {a.tables.length === 0
                                                                ? '—'
                                                                : a.tables
                                                                      .map((t) =>
                                                                          t.rateType === 'percent'
                                                                              ? `${t.tableName} (${t.rate}%)`
                                                                              : `${t.tableName} (${formatCurrency(t.rate)} flat)`,
                                                                      )
                                                                      .join(', ')}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                            {formatCurrency(a.taxCollected)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                            {/* Monthly breakdown */}
                            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                                <div className="p-4 border-b border-border">
                                    <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                                        Monthly Filing Summary
                                    </h3>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                                <th className="px-4 py-3 text-left">Month</th>
                                                <th className="px-4 py-3 text-right">Invoiced sales</th>
                                                <th className="px-4 py-3 text-right">Tax collected</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {report.monthly.map((m) => (
                                                <tr
                                                    key={m.month}
                                                    className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors"
                                                >
                                                    <td className="px-4 py-2.5 font-mono text-foreground" style={TNUM}>
                                                        {monthLabel(m.month)}
                                                    </td>
                                                    <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                                        {formatCurrency(m.taxableSales)}
                                                    </td>
                                                    <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                        {formatCurrency(m.taxCollected)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot>
                                            <tr className="border-t border-border font-medium bg-background-secondary/20">
                                                <td className="px-4 py-3 text-foreground">Total</td>
                                                <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                    {formatCurrency(report.totals.taxableSales)}
                                                </td>
                                                <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                    {formatCurrency(report.totals.taxCollected)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            </div>
                        </>
                    )}

                    <p className="text-xs text-foreground-muted">
                        &quot;Invoiced sales&quot; sums all income splits on posted customer-invoice
                        transactions in the range — per-line taxable flags are not consulted. Verify
                        against your jurisdiction&apos;s rules before filing.
                    </p>
                </>
            )}
        </div>
    );
}
