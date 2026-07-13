'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import type { FxRevaluationData } from '@/lib/reports/fx-revaluation';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
    };
}

function formatRate(rate: number | null): string {
    if (rate === null || !Number.isFinite(rate)) return '—';
    return rate.toFixed(4);
}

function formatQuantity(qty: number, currency: string): string {
    return `${new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(qty)} ${currency}`;
}

function GainLossCell({ value, baseCurrency }: { value: number | null; baseCurrency: string }) {
    if (value === null) {
        return <span className="text-foreground-muted">—</span>;
    }
    return (
        <span className={value >= 0 ? 'text-positive' : 'text-negative'}>
            {formatCurrency(value, baseCurrency)}
        </span>
    );
}

export default function FxRevaluationPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<FxRevaluationData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/fx-revaluation?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: FxRevaluationData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const base = reportData?.baseCurrency ?? 'USD';
    const hasEstimatedFlows = reportData?.positions.some(p => Math.abs(p.otherQuantity) > 1e-9) ?? false;

    return (
        <div className="space-y-6">
            <ReportViewer
                title="FX Revaluation"
                description="Foreign-currency cash exposure: average acquisition rate vs current rate"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {reportData && !reportData.hasForeignCurrency && (
                    <div className="p-12 text-center">
                        <p className="text-lg text-foreground mb-2">No foreign-currency accounts</p>
                        <p className="text-sm text-foreground-muted">
                            Every account in this book is denominated in {base}. Create an
                            account whose commodity is another currency to track FX exposure here.
                        </p>
                    </div>
                )}

                {reportData && reportData.hasForeignCurrency && (
                    <>
                        <div className="border-b border-border px-4 py-3 bg-background-tertiary/30">
                            <span className="text-xs text-foreground-muted">
                                Base currency: <span className="font-mono text-foreground-secondary">{base}</span>
                                {' · '}Realized gains window: {reportData.periodStart} → {reportData.periodEnd}
                            </span>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-background-tertiary/50">
                                        <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Currency</th>
                                        <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Balance</th>
                                        <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Avg rate</th>
                                        <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Current rate</th>
                                        <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Current value</th>
                                        <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Unrealized G/L</th>
                                        <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Realized G/L (period)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {reportData.positions.map(position => (
                                        <tr key={position.currency} className="border-b border-border/50">
                                            <td className="px-4 py-2 text-foreground font-medium">
                                                {position.currency}
                                                {Math.abs(position.otherQuantity) > 1e-9 && (
                                                    <span className="text-warning ml-1" title="Position includes cross-currency flows with no base-currency valuation; average rate is partly estimated.">*</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                                                {formatQuantity(position.quantity, position.currency)}
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">
                                                {formatRate(position.avgRate)}
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">
                                                {formatRate(position.currentRate)}
                                                {position.currentRateDate && (
                                                    <span className="block text-xs text-foreground-muted">{position.currentRateDate}</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                                                {position.currentValue !== null ? formatCurrency(position.currentValue, base) : '—'}
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                                                <GainLossCell value={position.unrealizedGainLoss} baseCurrency={base} />
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                                                <GainLossCell value={position.realizedGainLoss} baseCurrency={base} />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t border-border">
                                        <td className="px-4 py-2.5 font-semibold text-foreground" colSpan={4}>Total ({base})</td>
                                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-foreground">
                                            {formatCurrency(reportData.totals.currentValue, base)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                                            <GainLossCell value={reportData.totals.unrealizedGainLoss} baseCurrency={base} />
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                                            <GainLossCell value={reportData.totals.realizedGainLoss} baseCurrency={base} />
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>

                        <div className="px-4 py-3 text-xs text-foreground-muted border-t border-border/50 space-y-1">
                            <p>
                                Model: moving-average cost. The average acquisition rate is the
                                base-currency cost of the remaining balance divided by the balance;
                                disposals realize proceeds minus quantity × average rate. Unrealized
                                G/L = balance × (current rate − average rate), using the latest
                                price in the price database. Trading accounts are excluded (they
                                mirror the same flows).
                            </p>
                            {hasEstimatedFlows && (
                                <p>
                                    * Positions marked with an asterisk include cross-currency flows
                                    (transaction currency ≠ {base}) that carry no base-currency
                                    valuation. Those units were carried at the prevailing average
                                    rate; their gains cannot be attributed and appear as unrealized
                                    drift rather than realized G/L.
                                </p>
                            )}
                        </div>
                    </>
                )}
            </ReportViewer>
        </div>
    );
}
