'use client';

import { useContext } from 'react';
import {
    ComposedChart,
    Area,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend,
} from 'recharts';
import { ExpandedContext } from './ExpandableChart';

export interface CashFlowData {
    month: string;
    income: number;
    expenses: number;
    netCashFlow: number;
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
            <div className="h-5 w-48 bg-background-secondary rounded mb-6" />
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
            <div className="space-y-1">
                {payload.map((entry, index) => {
                    let label = '';
                    let color = '';

                    if (entry.dataKey === 'income') {
                        label = 'Income';
                        color = '#10b981';
                    } else if (entry.dataKey === 'expenses') {
                        label = 'Expenses';
                        color = '#ef4444';
                    } else if (entry.dataKey === 'netCashFlow') {
                        label = 'Net Cash Flow';
                        color = '#3b82f6';
                    }

                    return (
                        <div key={index} className="flex items-center justify-between gap-4 text-sm">
                            <span className="flex items-center gap-2">
                                <span
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{ backgroundColor: color }}
                                />
                                <span className="text-foreground-secondary">{label}</span>
                            </span>
                            <span className="font-medium text-foreground">
                                {formatFullCurrency(entry.value)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

interface CashFlowChartProps {
    data: CashFlowData[];
    loading: boolean;
}

export default function CashFlowChart({ data, loading }: CashFlowChartProps) {
    const expanded = useContext(ExpandedContext);

    if (loading) return <ChartSkeleton />;

    if (!data || data.length === 0) {
        return (
            <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
                <div className="h-[350px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No cash flow data available for this period.</p>
                </div>
            </div>
        );
    }

    const height = expanded ? 500 : 300;

    return (
        <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
            <ResponsiveContainer width="100%" height={height}>
                <ComposedChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
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
                        iconType="circle"
                        formatter={(value) => (
                            <span className="text-foreground-secondary text-sm">{value}</span>
                        )}
                    />
                    <Area
                        type="monotone"
                        dataKey="income"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.3}
                        baseValue={0}
                        name="Income"
                    />
                    <Area
                        type="monotone"
                        dataKey="expenses"
                        stroke="#ef4444"
                        fill="#ef4444"
                        fillOpacity={0.3}
                        baseValue={0}
                        name="Expenses"
                    />
                    <Line
                        type="monotone"
                        dataKey="netCashFlow"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        dot={{ fill: '#3b82f6', r: 3 }}
                        name="Net Cash Flow"
                    />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}
