'use client';

import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import type { MonthlyDividend } from '@/lib/dividends';

function formatAxisCurrency(value: number): string {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
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

function formatMonthLong(monthStr: string): string {
    const [year, month] = monthStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

interface TooltipProps {
    active?: boolean;
    payload?: Array<{ value: number }>;
    label?: string;
}

function CustomTooltip({ active, payload, label }: TooltipProps) {
    if (!active || !payload || !payload.length || !label) return null;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-1">{formatMonthLong(label)}</p>
            <p
                className="text-sm font-semibold font-mono text-foreground"
                style={{ fontFeatureSettings: "'tnum'" }}
            >
                {formatFullCurrency(payload[0].value)}
            </p>
        </div>
    );
}

interface DividendMonthlyChartProps {
    data: MonthlyDividend[];
    height?: number;
}

export function DividendMonthlyChart({ data, height = 300 }: DividendMonthlyChartProps) {
    if (!data || data.length === 0) {
        return (
            <div className="h-[300px] flex items-center justify-center">
                <p className="text-foreground-muted text-sm">No dividend history available.</p>
            </div>
        );
    }

    return (
        <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                    dataKey="month"
                    tickFormatter={formatMonth}
                    stroke="var(--foreground-secondary)"
                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={{ stroke: 'var(--border)' }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                />
                <YAxis
                    tickFormatter={formatAxisCurrency}
                    stroke="var(--foreground-secondary)"
                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={{ stroke: 'var(--border)' }}
                    width={64}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface-hover)', opacity: 0.4 }} />
                <Bar dataKey="amount" fill="var(--primary)" radius={[2, 2, 0, 0]} name="Dividends" />
            </BarChart>
        </ResponsiveContainer>
    );
}
