'use client';

import { useContext } from 'react';
import {
    PieChart,
    Pie,
    Cell,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import type { PieLabelRenderProps } from 'recharts';
import { ExpandedContext } from '@/components/charts/ExpandableChart';

const COLORS = [
    '#34d399', '#22d3ee', '#818cf8', '#f472b6', '#fb923c',
    '#a3e635', '#2dd4bf', '#c084fc', '#f87171', '#fbbf24',
];

interface CategoryData {
    name: string;
    value: number;
}

interface ExpensePieChartProps {
    data: CategoryData[];
    loading: boolean;
}

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value);
}

function ChartSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-xl p-6 animate-pulse">
            <div className="h-5 w-44 bg-background-secondary rounded mb-6" />
            <div className="h-[300px] bg-background-secondary rounded" />
        </div>
    );
}

interface CustomTooltipProps {
    active?: boolean;
    payload?: Array<{
        name: string;
        value: number;
        payload: CategoryData & { percent: number };
    }>;
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
    if (!active || !payload || payload.length === 0) return null;

    const entry = payload[0];
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-sm font-medium text-foreground">{entry.name}</p>
            <p className="text-sm text-foreground-secondary">{formatCurrency(entry.value)}</p>
        </div>
    );
}

const RADIAN = Math.PI / 180;

function renderCustomLabel(props: PieLabelRenderProps) {
    const cx = Number(props.cx ?? 0);
    const cy = Number(props.cy ?? 0);
    const midAngle = Number(props.midAngle ?? 0);
    const innerRadius = Number(props.innerRadius ?? 0);
    const outerRadius = Number(props.outerRadius ?? 0);
    const percent = Number(props.percent ?? 0);
    const name = String(props.name ?? '');

    if (percent < 0.05) return null;
    const radius = innerRadius + (outerRadius - innerRadius) * 1.4;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
        <text
            x={x}
            y={y}
            fill="var(--foreground-secondary)"
            textAnchor={x > cx ? 'start' : 'end'}
            dominantBaseline="central"
            fontSize={11}
        >
            {name} ({(percent * 100).toFixed(0)}%)
        </text>
    );
}

export default function ExpensePieChart({ data, loading }: ExpensePieChartProps) {
    const expanded = useContext(ExpandedContext);

    if (loading) return <ChartSkeleton />;

    if (!data || data.length === 0) {
        return (
            <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
                <h3 className="text-lg font-semibold text-foreground mb-4">Expenses by Category</h3>
                <div className="h-[300px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No expense data available.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
            <h3 className="text-lg font-semibold text-foreground mb-4">Expenses by Category</h3>
            <ResponsiveContainer width="100%" height={expanded ? "100%" : 300}>
                <PieChart>
                    <Pie
                        data={data}
                        cx="50%"
                        cy="50%"
                        outerRadius={expanded ? "80%" : 90}
                        dataKey="value"
                        label={renderCustomLabel}
                        labelLine={false}
                        stroke="var(--background)"
                        strokeWidth={2}
                    >
                        {data.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}
