'use client';

import { useContext } from 'react';
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
import { ExpandedContext } from '@/components/charts/ExpandableChart';

interface MonthlyData {
    month: string;
    income: number;
    expenses: number;
    taxes: number;
    netProfit: number;
}

interface IncomeExpenseBarChartProps {
    data: MonthlyData[];
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

function formatMonth(monthStr: string): string {
    const [year, month] = monthStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function ChartSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-xl p-6 animate-pulse">
            <div className="h-5 w-52 bg-background-secondary rounded mb-6" />
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

export default function IncomeExpenseBarChart({ data, loading }: IncomeExpenseBarChartProps) {
    const expanded = useContext(ExpandedContext);

    if (loading) return <ChartSkeleton />;

    if (!data || data.length === 0) {
        return (
            <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
                <h3 className="text-lg font-semibold text-foreground mb-4">Income vs Expenses</h3>
                <div className="h-[350px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No income/expense data available for this period.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
            <h3 className="text-lg font-semibold text-foreground mb-4">Income vs Expenses</h3>
            <ResponsiveContainer width="100%" height={expanded ? "100%" : 350}>
                <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                        dataKey="month"
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
                        fill="#34d399"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={40}
                    />
                    <Bar
                        dataKey="expenses"
                        fill="#f87171"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={40}
                    />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
