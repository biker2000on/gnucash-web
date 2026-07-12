'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import type { AverageBalanceData } from '@/lib/reports/average-balance';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from 'recharts';

const SERIES: Array<{ key: 'average' | 'min' | 'max' | 'ending'; label: string; color: string }> = [
    { key: 'average', label: 'Average', color: '#2dd4bf' },
    { key: 'min', label: 'Minimum', color: '#fb923c' },
    { key: 'max', label: 'Maximum', color: '#34d399' },
    { key: 'ending', label: 'Ending', color: '#818cf8' },
];

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
    };
}

function formatFullCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function formatCompactCurrency(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
    return `$${value.toFixed(0)}`;
}

interface TooltipProps {
    active?: boolean;
    payload?: Array<{ value: number; dataKey: string; color: string }>;
    label?: string;
}

function BucketTooltip({ active, payload, label }: TooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-2">{label}</p>
            {payload.map(entry => {
                const series = SERIES.find(s => s.key === entry.dataKey);
                return (
                    <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
                        <span className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="text-foreground-secondary">{series?.label ?? entry.dataKey}</span>
                        </span>
                        <span className="font-mono tabular-nums text-foreground">{formatFullCurrency(entry.value)}</span>
                    </div>
                );
            })}
        </div>
    );
}

export default function AverageBalancePage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    // null = server default (all candidate accounts)
    const [accountGuids, setAccountGuids] = useState<string[] | null>(null);
    const [reportData, setReportData] = useState<AverageBalanceData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
                setPickerOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (accountGuids && accountGuids.length > 0) params.set('accounts', accountGuids.join(','));

            const res = await fetch(`/api/reports/average-balance?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: AverageBalanceData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, accountGuids]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const selectedCount = useMemo(
        () => reportData?.accounts.filter(a => a.selected).length ?? 0,
        [reportData]
    );

    const toggleAccount = (guid: string) => {
        if (!reportData) return;
        const current = reportData.accounts.filter(a => a.selected).map(a => a.guid);
        const next = current.includes(guid)
            ? current.filter(g => g !== guid)
            : [...current, guid];
        if (next.length === 0) return; // keep at least one account selected
        setAccountGuids(next);
    };

    const selectAll = () => setAccountGuids(null);

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Average Balance"
                description="Average daily balance per month for selected cash accounts"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {/* Account picker */}
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-background-tertiary/30">
                    <label className="text-xs text-foreground-muted uppercase tracking-wider">Accounts</label>
                    <div className="relative" ref={pickerRef}>
                        <button
                            onClick={() => setPickerOpen(o => !o)}
                            className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5 text-sm text-foreground hover:border-primary/50 transition-colors"
                        >
                            <span>
                                {reportData
                                    ? `${selectedCount} of ${reportData.accounts.length} accounts`
                                    : 'Accounts'}
                            </span>
                            <svg className={`w-4 h-4 text-foreground-secondary transition-transform ${pickerOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>

                        {pickerOpen && reportData && (
                            <div className="absolute top-full left-0 mt-2 w-96 max-w-[calc(100vw-2rem)] bg-surface-elevated border border-border rounded-lg shadow-xl z-50">
                                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                                    <span className="text-xs text-foreground-muted uppercase tracking-wider">Bank / Cash / Asset accounts</span>
                                    <button
                                        onClick={selectAll}
                                        className="text-xs text-primary hover:text-primary-hover transition-colors"
                                    >
                                        Select all
                                    </button>
                                </div>
                                <div className="max-h-72 overflow-y-auto py-1">
                                    {reportData.accounts.length === 0 && (
                                        <div className="px-3 py-2 text-sm text-foreground-muted">No candidate accounts.</div>
                                    )}
                                    {reportData.accounts.map(account => (
                                        <label
                                            key={account.guid}
                                            className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-surface-hover transition-colors"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={account.selected}
                                                onChange={() => toggleAccount(account.guid)}
                                                className="w-3.5 h-3.5 rounded border-border-hover bg-background-tertiary text-primary"
                                            />
                                            <span className="text-foreground truncate">{account.name}</span>
                                            <span className="ml-auto text-xs text-foreground-muted truncate max-w-[180px]">{account.path}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    {reportData && (
                        <span className="text-xs text-foreground-muted md:ml-auto font-mono tabular-nums">
                            Opening balance: {formatFullCurrency(reportData.openingBalance)}
                        </span>
                    )}
                </div>

                {reportData && reportData.buckets.length === 0 && (
                    <div className="p-12 text-center text-foreground-muted text-sm">
                        No data for this selection.
                    </div>
                )}

                {reportData && reportData.buckets.length > 0 && (
                    <div className="p-6">
                        <ResponsiveContainer width="100%" height={380}>
                            <LineChart data={reportData.buckets} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                <XAxis
                                    dataKey="label"
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                    minTickGap={30}
                                />
                                <YAxis
                                    tickFormatter={formatCompactCurrency}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                    width={80}
                                    domain={['auto', 'auto']}
                                />
                                <Tooltip content={<BucketTooltip />} />
                                <Legend
                                    wrapperStyle={{ paddingTop: '16px' }}
                                    formatter={(value: string) => (
                                        <span className="text-foreground-secondary text-sm">
                                            {SERIES.find(s => s.key === value)?.label ?? value}
                                        </span>
                                    )}
                                />
                                {SERIES.map(series => (
                                    <Line
                                        key={series.key}
                                        type="monotone"
                                        dataKey={series.key}
                                        stroke={series.color}
                                        strokeWidth={series.key === 'average' ? 2.5 : 1.5}
                                        strokeDasharray={series.key === 'min' || series.key === 'max' ? '4 3' : undefined}
                                        dot={reportData.buckets.length <= 24 ? { r: 3, strokeWidth: 0, fill: series.color } : false}
                                        activeDot={{ r: 4 }}
                                    />
                                ))}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {reportData && reportData.buckets.length > 0 && (
                    <div className="border-t border-border overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-background-tertiary/50">
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Month</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Days</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Average</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Minimum</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Maximum</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Ending</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reportData.buckets.map(bucket => (
                                    <tr key={bucket.month} className="border-b border-border/50">
                                        <td className="px-4 py-2 text-foreground">{bucket.label}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-muted">{bucket.days}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">{formatFullCurrency(bucket.average)}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">{formatFullCurrency(bucket.min)}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">{formatFullCurrency(bucket.max)}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">{formatFullCurrency(bucket.ending)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p className="px-4 py-3 text-xs text-foreground-muted border-t border-border/50">
                            Balances are end-of-day values walked daily from split activity (UTC calendar days).
                            The starting balance is the sum of all splits posted before the range start.
                        </p>
                    </div>
                )}
            </ReportViewer>
        </div>
    );
}
