'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ChartReportData, SavedReport, SavedReportInput, ReportType } from '@/lib/reports/types';
import { downloadCSV, escapeCSVField } from '@/lib/reports/csv-export';
import SaveReportDialog from '@/components/reports/SaveReportDialog';
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

interface NetWorthDataPoint {
    date: string;
    assets: number;
    liabilities: number;
    netWorth: number;
}

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(now.getFullYear() - 1);

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

function formatDate(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
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

    const date = new Date(label + 'T00:00:00');
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
                        <span className="text-foreground-secondary capitalize">
                            {entry.dataKey === 'netWorth' ? 'Net Worth' : entry.dataKey}
                        </span>
                    </span>
                    <span className="font-medium text-foreground">
                        {formatFullCurrency(entry.value)}
                    </span>
                </div>
            ))}
        </div>
    );
}

function chartDataToCSV(data: NetWorthDataPoint[]): string {
    const rows: string[] = ['Date,Assets,Liabilities,Net Worth'];
    for (const point of data) {
        rows.push(
            `${escapeCSVField(point.date)},${point.assets.toFixed(2)},${point.liabilities.toFixed(2)},${point.netWorth.toFixed(2)}`
        );
    }
    return rows.join('\n');
}

function NetWorthChartContent() {
    const searchParams = useSearchParams();
    const savedIdParam = searchParams.get('savedId');

    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<ChartReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [savedReportId, setSavedReportId] = useState<number | null>(savedIdParam ? parseInt(savedIdParam, 10) : null);
    const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
    const [currentSavedReport, setCurrentSavedReport] = useState<SavedReport | null>(null);

    // Load saved report config
    useEffect(() => {
        if (!savedIdParam) return;
        const id = parseInt(savedIdParam, 10);
        if (isNaN(id)) return;

        fetch(`/api/reports/saved/${id}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to load saved report');
                return res.json();
            })
            .then((saved: SavedReport) => {
                if (saved.filters) {
                    setFilters(saved.filters);
                }
                setCurrentSavedReport(saved);
                setSavedReportId(saved.id);
            })
            .catch(() => {
                // silently fall back to defaults
            });
    }, [savedIdParam]);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/net-worth-chart?${params}`);
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
            const csv = chartDataToCSV(reportData.dataPoints as unknown as NetWorthDataPoint[]);
            downloadCSV(csv, 'Net_Worth_Chart.csv');
        }
    };

    const handleSaveReport = async (input: SavedReportInput) => {
        const url = currentSavedReport
            ? `/api/reports/saved/${currentSavedReport.id}`
            : '/api/reports/saved';
        const method = currentSavedReport ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error('Failed to save');
        const saved = await res.json();
        setCurrentSavedReport(saved);
        setSavedReportId(saved.id);
    };

    const chartData = reportData?.dataPoints as unknown as NetWorthDataPoint[] | undefined;

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Net Worth Chart"
                description="Assets, liabilities, and net worth over time"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {chartData && chartData.length > 0 && (
                    <>
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-foreground">Net Worth Over Time</h3>
                                <button
                                    onClick={() => setIsSaveDialogOpen(true)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                                    </svg>
                                    Save Configuration
                                </button>
                            </div>
                            <ResponsiveContainer width="100%" height={450}>
                                <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                    <XAxis
                                        dataKey="date"
                                        tickFormatter={formatDate}
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
                                            <span className="text-foreground-secondary text-sm">
                                                {value === 'netWorth' ? 'Net Worth' : value.charAt(0).toUpperCase() + value.slice(1)}
                                            </span>
                                        )}
                                    />
                                    <Line
                                        type="monotone"
                                        dataKey="assets"
                                        stroke="#22d3ee"
                                        strokeWidth={2}
                                        dot={false}
                                        activeDot={{ r: 5, fill: '#22d3ee', stroke: 'var(--background)', strokeWidth: 2 }}
                                    />
                                    <Line
                                        type="monotone"
                                        dataKey="liabilities"
                                        stroke="#f87171"
                                        strokeWidth={2}
                                        dot={false}
                                        activeDot={{ r: 5, fill: '#f87171', stroke: 'var(--background)', strokeWidth: 2 }}
                                    />
                                    <Line
                                        type="monotone"
                                        dataKey="netWorth"
                                        stroke="#34d399"
                                        strokeWidth={2.5}
                                        dot={false}
                                        activeDot={{ r: 6, fill: '#34d399', stroke: 'var(--background)', strokeWidth: 2 }}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>

                        {/* Custom CSV export button */}
                        <div className="border-t border-border p-4 flex justify-end no-print">
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
                    </>
                )}
            </ReportViewer>

            <SaveReportDialog
                isOpen={isSaveDialogOpen}
                onClose={() => setIsSaveDialogOpen(false)}
                onSave={handleSaveReport}
                baseReportType={ReportType.NET_WORTH_CHART}
                existingReport={currentSavedReport}
                currentConfig={{}}
                currentFilters={filters}
            />
        </div>
    );
}

export default function NetWorthChartPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
            <NetWorthChartContent />
        </Suspense>
    );
}
