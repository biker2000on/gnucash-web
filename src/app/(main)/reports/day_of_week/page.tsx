'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import type { DayOfWeekData, WeekdayBucket } from '@/lib/reports/day-of-week';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from 'recharts';

// Same series colors as the Income & Expense chart report
const INCOME_COLOR = '#10b981';
const EXPENSE_COLOR = '#f43f5e';

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
    if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
}

interface TooltipProps {
    active?: boolean;
    payload?: Array<{ value: number; dataKey: string; color: string; payload: WeekdayBucket }>;
    label?: string;
}

function WeekdayTooltip({ active, payload, label }: TooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    const bucket = payload[0].payload;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-2">
                {label} ({bucket.occurrences} day{bucket.occurrences === 1 ? '' : 's'} in range)
            </p>
            {payload.map(entry => (
                <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-foreground-secondary">
                            {entry.dataKey.startsWith('income') ? 'Income' : 'Expense'}
                        </span>
                    </span>
                    <span className="font-mono tabular-nums text-foreground">{formatFullCurrency(entry.value)}</span>
                </div>
            ))}
        </div>
    );
}

export default function DayOfWeekPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [mode, setMode] = useState<'total' | 'average'>('total');
    const [reportData, setReportData] = useState<DayOfWeekData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/day-of-week?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: DayOfWeekData = await res.json();
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

    const incomeKey = mode === 'total' ? 'income' : 'incomeAvg';
    const expenseKey = mode === 'total' ? 'expense' : 'expenseAvg';

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Income & Expenses by Day of Week"
                description="Which weekdays money comes in and goes out"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {/* Mode toggle */}
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-background-tertiary/30">
                    <div className="inline-flex rounded-lg border border-border overflow-hidden">
                        {(['total', 'average'] as const).map(m => (
                            <button
                                key={m}
                                onClick={() => setMode(m)}
                                className={`px-3 py-1.5 text-xs transition-colors ${
                                    mode === m
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-surface text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {m === 'total' ? 'Totals' : 'Average per day'}
                            </button>
                        ))}
                    </div>
                    <span className="text-xs text-foreground-muted md:ml-auto">
                        Weekday uses the transaction post date in UTC
                    </span>
                </div>

                {reportData && (
                    <div className="p-6">
                        <ResponsiveContainer width="100%" height={380}>
                            <BarChart
                                data={reportData.days}
                                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                <XAxis
                                    dataKey="name"
                                    tickFormatter={(name: string) => name.slice(0, 3)}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                />
                                <YAxis
                                    tickFormatter={formatCompactCurrency}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                    width={70}
                                />
                                <Tooltip content={<WeekdayTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
                                <Legend
                                    wrapperStyle={{ paddingTop: '16px' }}
                                    formatter={(value: string) => (
                                        <span className="text-foreground-secondary text-sm">
                                            {value.startsWith('income') ? 'Income' : 'Expense'}
                                        </span>
                                    )}
                                />
                                <Bar dataKey={incomeKey} fill={INCOME_COLOR} radius={[4, 4, 0, 0]} maxBarSize={32} />
                                <Bar dataKey={expenseKey} fill={EXPENSE_COLOR} radius={[4, 4, 0, 0]} maxBarSize={32} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {reportData && (
                    <div className="border-t border-border overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-background-tertiary/50">
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Weekday</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Days in range</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Income</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Avg income / day</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Expense</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Avg expense / day</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Net</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reportData.days.map(day => {
                                    const net = day.income - day.expense;
                                    return (
                                        <tr key={day.weekday} className="border-b border-border/50">
                                            <td className="px-4 py-2 text-foreground">{day.name}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-muted">{day.occurrences}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">{formatFullCurrency(day.income)}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">{formatFullCurrency(day.incomeAvg)}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">{formatFullCurrency(day.expense)}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">{formatFullCurrency(day.expenseAvg)}</td>
                                            <td className={`px-4 py-2 text-right font-mono tabular-nums ${
                                                net >= 0 ? 'text-positive' : 'text-negative'
                                            }`}>
                                                {formatFullCurrency(net)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border">
                                    <td className="px-4 py-2.5 font-semibold text-foreground">Total</td>
                                    <td />
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-foreground">
                                        {formatFullCurrency(reportData.totals.income)}
                                    </td>
                                    <td />
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-foreground">
                                        {formatFullCurrency(reportData.totals.expense)}
                                    </td>
                                    <td />
                                    <td className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                                        reportData.totals.income - reportData.totals.expense >= 0 ? 'text-positive' : 'text-negative'
                                    }`}>
                                        {formatFullCurrency(reportData.totals.income - reportData.totals.expense)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                        <p className="px-4 py-3 text-xs text-foreground-muted border-t border-border/50">
                            Note: the weekday of each transaction is taken from its post date interpreted in UTC,
                            matching how GnuCash stores post dates. Transactions near midnight in your local
                            timezone may fall on the adjacent weekday.
                        </p>
                    </div>
                )}
            </ReportViewer>
        </div>
    );
}
