'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ChartReportData, ChartDataPoint } from '@/lib/reports/types';
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
import { generateChartCSV, downloadCSV } from '@/lib/reports/csv-export';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    return {
        startDate: oneYearAgo.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function formatCurrency(value: number): string {
    if (Math.abs(value) >= 1_000_000) {
        return `$${(value / 1_000_000).toFixed(1)}M`;
    }
    if (Math.abs(value) >= 1_000) {
        return `$${(value / 1_000).toFixed(0)}k`;
    }
    return `$${value.toFixed(0)}`;
}

function formatFullCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function formatMonth(monthStr: string): string {
    const [year, month] = monthStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

interface CustomTooltipProps {
    active?: boolean;
    payload?: Array<{
        value: number;
        dataKey: string;
        color: string;
    }>;
    label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
    if (!active || !payload || !label) return null;

    const [year, month] = label.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    const formattedDate = date.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
    });

    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-2">{formattedDate}</p>
            {payload.map((entry) => (
                <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2">
                        <span
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: entry.color }}
                        />
                        <span className="text-foreground-secondary capitalize">{entry.dataKey}</span>
                    </span>
                    <span className="font-medium text-foreground">
                        {formatFullCurrency(entry.value)}
                    </span>
                </div>
            ))}
        </div>
    );
}

export default function IncomeExpenseChartPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<ChartReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/income-expense-chart?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: ChartReportData = await res.json();
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

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generateChartCSV(reportData);
            downloadCSV(csv, 'Income_Expense_Chart.csv');
        }
    };

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Income & Expense Chart"
                description="Monthly income and expenses over time"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {reportData && (
                    <div className="p-6">
                        <ResponsiveContainer width="100%" height={400}>
                            <BarChart data={reportData.dataPoints} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                <XAxis
                                    dataKey="date"
                                    tickFormatter={formatMonth}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                />
                                <YAxis
                                    tickFormatter={formatCurrency}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                    width={70}
                                />
                                <Tooltip content={<CustomTooltip />} />
                                <Legend
                                    wrapperStyle={{ paddingTop: '16px' }}
                                    formatter={(value: string) => (
                                        <span className="text-foreground-secondary text-sm capitalize">{value}</span>
                                    )}
                                />
                                <Bar
                                    dataKey="income"
                                    fill="#10b981"
                                    radius={[4, 4, 0, 0]}
                                    maxBarSize={40}
                                />
                                <Bar
                                    dataKey="expense"
                                    fill="#f43f5e"
                                    radius={[4, 4, 0, 0]}
                                    maxBarSize={40}
                                />
                            </BarChart>
                        </ResponsiveContainer>

                        {/* CSV Export Button */}
                        <div className="border-t border-border mt-6 pt-4 flex justify-end no-print">
                            <button
                                onClick={handleExportCSV}
                                className="flex items-center gap-2 px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Export CSV
                            </button>
                        </div>
                    </div>
                )}
            </ReportViewer>
        </div>
    );
}
