'use client';

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
    netWorth: number;
    assets: number;
    liabilities: number;
}

interface NetWorthChartProps {
    data: NetWorthDataPoint[];
    loading: boolean;
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

function ChartSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-xl p-6 animate-pulse">
            <div className="h-5 w-40 bg-background-secondary rounded mb-6" />
            <div className="h-[350px] bg-background-secondary rounded" />
        </div>
    );
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

export default function NetWorthChart({ data, loading }: NetWorthChartProps) {
    if (loading) return <ChartSkeleton />;

    if (!data || data.length === 0) {
        return (
            <div className="bg-surface border border-border rounded-xl p-6">
                <h3 className="text-lg font-semibold text-foreground mb-4">Net Worth Over Time</h3>
                <div className="h-[350px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No net worth data available for this period.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-surface border border-border rounded-xl p-6">
            <h3 className="text-lg font-semibold text-foreground mb-4">Net Worth Over Time</h3>
            <ResponsiveContainer width="100%" height={350}>
                <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
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
                        dataKey="netWorth"
                        stroke="#34d399"
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 5, fill: '#34d399', stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                    <Line
                        type="monotone"
                        dataKey="assets"
                        stroke="#22d3ee"
                        strokeWidth={1.5}
                        dot={false}
                        strokeDasharray="4 4"
                        activeDot={{ r: 4, fill: '#22d3ee', stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                    <Line
                        type="monotone"
                        dataKey="liabilities"
                        stroke="#f87171"
                        strokeWidth={1.5}
                        dot={false}
                        strokeDasharray="4 4"
                        activeDot={{ r: 4, fill: '#f87171', stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
