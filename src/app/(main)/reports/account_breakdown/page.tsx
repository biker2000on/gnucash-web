'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import type {
    AccountBreakdownData,
    BreakdownAccountType,
    BreakdownSlice,
} from '@/lib/reports/account-breakdown';
import {
    PieChart,
    Pie,
    Cell,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import type { PieLabelRenderProps } from 'recharts';

const OTHER_GUID = '__other__';

// Same categorical palette as the dashboard pie charts
const COLORS = [
    '#34d399', '#22d3ee', '#818cf8', '#f472b6', '#fb923c',
    '#a3e635', '#2dd4bf', '#c084fc', '#f87171', '#fbbf24',
];

const TYPES: Array<{ value: BreakdownAccountType; label: string }> = [
    { value: 'ASSET', label: 'Assets' },
    { value: 'LIABILITY', label: 'Liabilities' },
    { value: 'INCOME', label: 'Income' },
    { value: 'EXPENSE', label: 'Expenses' },
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
    payload?: Array<{ payload: BreakdownSlice & { total: number } }>;
}

function SliceTooltip({ active, payload }: TooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    const slice = payload[0].payload;
    const percent = slice.total > 0 ? (slice.amount / slice.total) * 100 : 0;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-sm font-medium text-foreground">{slice.name}</p>
            <p className="text-xs text-foreground-muted mb-1">{slice.path}</p>
            <p className="text-sm text-foreground-secondary font-mono tabular-nums">
                {formatFullCurrency(slice.amount)} ({percent.toFixed(1)}%)
            </p>
            {slice.hasChildren && (
                <p className="text-xs text-primary mt-1">Click to drill down</p>
            )}
        </div>
    );
}

const RADIAN = Math.PI / 180;

function renderPieLabel(props: PieLabelRenderProps) {
    const cx = Number(props.cx ?? 0);
    const cy = Number(props.cy ?? 0);
    const midAngle = Number(props.midAngle ?? 0);
    const innerRadius = Number(props.innerRadius ?? 0);
    const outerRadius = Number(props.outerRadius ?? 0);
    const percent = Number(props.percent ?? 0);
    const name = String(props.name ?? '');

    if (percent < 0.05) return null;
    const radius = innerRadius + (outerRadius - innerRadius) * 1.35;
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

export default function AccountBreakdownPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [type, setType] = useState<BreakdownAccountType>('EXPENSE');
    const [depth, setDepth] = useState(2);
    const [view, setView] = useState<'pie' | 'bar'>('pie');
    const [stack, setStack] = useState<Array<{ guid: string; name: string }>>([]);
    const [reportData, setReportData] = useState<AccountBreakdownData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const rootGuid = stack.length > 0 ? stack[stack.length - 1].guid : null;

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('type', type);
            params.set('depth', String(depth));
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (rootGuid) params.set('rootGuid', rootGuid);

            const res = await fetch(`/api/reports/account-breakdown?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: AccountBreakdownData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, type, depth, rootGuid]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const selectType = (next: BreakdownAccountType) => {
        setType(next);
        setStack([]);
    };

    const drill = useCallback((slice: BreakdownSlice) => {
        if (!slice.hasChildren || slice.accountGuid === OTHER_GUID) return;
        setStack(prev => [...prev, { guid: slice.accountGuid, name: slice.name }]);
    }, []);

    const popTo = (index: number) => {
        // index -1 = back to the top level
        setStack(prev => prev.slice(0, index + 1));
    };

    const isFlow = type === 'INCOME' || type === 'EXPENSE';
    const typeLabel = TYPES.find(t => t.value === type)?.label ?? type;

    const chartSlices = useMemo(() => {
        if (!reportData) return [];
        const total = reportData.total;
        return reportData.slices.map(s => ({ ...s, total }));
    }, [reportData]);

    // Pie charts can only show positive slices; the bar chart shows everything.
    const pieSlices = useMemo(() => chartSlices.filter(s => s.amount > 0), [chartSlices]);

    const barHeight = Math.max(280, chartSlices.length * 40 + 60);

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Account Breakdown"
                description="Assets, liabilities, income, or expenses grouped by account at a chosen depth"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {/* Type / depth / chart controls */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 border-b border-border bg-background-tertiary/30">
                    <div className="inline-flex rounded-lg border border-border overflow-hidden">
                        {TYPES.map(t => (
                            <button
                                key={t.value}
                                onClick={() => selectType(t.value)}
                                className={`px-3 py-1.5 text-xs transition-colors ${
                                    type === t.value
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-surface text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center gap-2">
                        <label className="text-xs text-foreground-muted uppercase tracking-wider">Depth</label>
                        <div className="inline-flex rounded-lg border border-border overflow-hidden">
                            {[1, 2, 3, 4].map(d => (
                                <button
                                    key={d}
                                    onClick={() => setDepth(d)}
                                    className={`px-3 py-1.5 text-xs transition-colors ${
                                        depth === d
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-surface text-foreground-secondary hover:bg-surface-hover'
                                    }`}
                                >
                                    {d}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="inline-flex rounded-lg border border-border overflow-hidden md:ml-auto">
                        {(['pie', 'bar'] as const).map(v => (
                            <button
                                key={v}
                                onClick={() => setView(v)}
                                className={`px-3 py-1.5 text-xs capitalize transition-colors ${
                                    view === v
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-surface text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {v}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Drill-down breadcrumb */}
                <div className="flex flex-wrap items-center gap-1 px-4 py-2 border-b border-border text-sm">
                    <button
                        onClick={() => popTo(-1)}
                        disabled={stack.length === 0}
                        className={stack.length === 0
                            ? 'text-foreground font-medium cursor-default'
                            : 'text-primary hover:text-primary-hover transition-colors'}
                    >
                        All {typeLabel}
                    </button>
                    {stack.map((crumb, i) => (
                        <span key={crumb.guid} className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5 text-foreground-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                            {i === stack.length - 1 ? (
                                <span className="text-foreground font-medium">{crumb.name}</span>
                            ) : (
                                <button
                                    onClick={() => popTo(i)}
                                    className="text-primary hover:text-primary-hover transition-colors"
                                >
                                    {crumb.name}
                                </button>
                            )}
                        </span>
                    ))}
                    <span className="ml-auto text-xs text-foreground-muted">
                        {isFlow ? 'Flow over the selected range' : 'Balance at the end date'}
                    </span>
                </div>

                {reportData && chartSlices.length === 0 && (
                    <div className="p-12 text-center text-foreground-muted text-sm">
                        No {typeLabel.toLowerCase()} activity for this selection.
                    </div>
                )}

                {reportData && chartSlices.length > 0 && (
                    <div className="p-6 space-y-6">
                        {view === 'pie' ? (
                            <ResponsiveContainer width="100%" height={380}>
                                <PieChart>
                                    <Pie
                                        data={pieSlices}
                                        cx="50%"
                                        cy="50%"
                                        outerRadius={120}
                                        innerRadius={65}
                                        dataKey="amount"
                                        nameKey="name"
                                        label={renderPieLabel}
                                        labelLine={false}
                                        stroke="var(--background)"
                                        strokeWidth={2}
                                        onClick={(_, index) => drill(pieSlices[index])}
                                    >
                                        {pieSlices.map((slice, index) => (
                                            <Cell
                                                key={slice.accountGuid}
                                                fill={COLORS[index % COLORS.length]}
                                                cursor={slice.hasChildren ? 'pointer' : 'default'}
                                            />
                                        ))}
                                    </Pie>
                                    <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central">
                                        <tspan x="50%" dy="-0.5em" fill="var(--foreground-muted)" fontSize={11}>Total</tspan>
                                        <tspan x="50%" dy="1.3em" fill="var(--foreground)" fontSize={14} fontWeight="bold">
                                            {formatCompactCurrency(reportData.total)}
                                        </tspan>
                                    </text>
                                    <Tooltip content={<SliceTooltip />} />
                                </PieChart>
                            </ResponsiveContainer>
                        ) : (
                            <ResponsiveContainer width="100%" height={barHeight}>
                                <BarChart
                                    data={chartSlices}
                                    layout="vertical"
                                    margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                                >
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                                    <XAxis
                                        type="number"
                                        tickFormatter={formatCompactCurrency}
                                        stroke="var(--foreground-secondary)"
                                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                        axisLine={{ stroke: 'var(--border)' }}
                                        tickLine={{ stroke: 'var(--border)' }}
                                    />
                                    <YAxis
                                        type="category"
                                        dataKey="name"
                                        width={170}
                                        stroke="var(--foreground-secondary)"
                                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                        axisLine={{ stroke: 'var(--border)' }}
                                        tickLine={false}
                                    />
                                    <Tooltip content={<SliceTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
                                    <Bar
                                        dataKey="amount"
                                        radius={[0, 4, 4, 0]}
                                        maxBarSize={28}
                                        onClick={(_, index) => drill(chartSlices[index])}
                                    >
                                        {chartSlices.map((slice, index) => (
                                            <Cell
                                                key={slice.accountGuid}
                                                fill={COLORS[index % COLORS.length]}
                                                cursor={slice.hasChildren ? 'pointer' : 'default'}
                                            />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        )}

                        {/* Legend with amounts and percentages */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
                            {chartSlices.map((slice, index) => {
                                const percent = reportData.total > 0
                                    ? (slice.amount / reportData.total) * 100
                                    : 0;
                                return (
                                    <button
                                        key={slice.accountGuid}
                                        onClick={() => drill(slice)}
                                        disabled={!slice.hasChildren}
                                        className={`flex items-center gap-2 text-sm text-left rounded px-1 py-0.5 ${
                                            slice.hasChildren ? 'hover:bg-surface-hover transition-colors' : 'cursor-default'
                                        }`}
                                        title={slice.path}
                                    >
                                        <span
                                            className="w-2.5 h-2.5 rounded-full shrink-0"
                                            style={{ backgroundColor: COLORS[index % COLORS.length] }}
                                        />
                                        <span className="text-foreground-secondary truncate flex-1">{slice.name}</span>
                                        <span className="font-mono tabular-nums text-foreground">{formatFullCurrency(slice.amount)}</span>
                                        <span className="font-mono tabular-nums text-foreground-muted w-14 text-right">{percent.toFixed(1)}%</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Dense table */}
                {reportData && chartSlices.length > 0 && (
                    <div className="border-t border-border overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-background-tertiary/50">
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Account</th>
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium hidden md:table-cell">Path</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Amount</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium w-20">Share</th>
                                </tr>
                            </thead>
                            <tbody>
                                {chartSlices.map(slice => {
                                    const percent = reportData.total > 0
                                        ? (slice.amount / reportData.total) * 100
                                        : 0;
                                    const rows = [
                                        <tr
                                            key={slice.accountGuid}
                                            onClick={() => drill(slice)}
                                            className={`border-b border-border/50 ${
                                                slice.hasChildren ? 'cursor-pointer hover:bg-surface-hover transition-colors' : ''
                                            }`}
                                        >
                                            <td className="px-4 py-2 text-foreground">
                                                <span className="flex items-center gap-1.5">
                                                    {slice.name}
                                                    {slice.hasChildren && (
                                                        <svg className="w-3.5 h-3.5 text-foreground-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                        </svg>
                                                    )}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2 text-foreground-muted text-xs hidden md:table-cell">{slice.path}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">{formatFullCurrency(slice.amount)}</td>
                                            <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">{percent.toFixed(1)}%</td>
                                        </tr>,
                                    ];
                                    if (slice.children) {
                                        for (const child of slice.children) {
                                            const childPercent = reportData.total > 0
                                                ? (child.amount / reportData.total) * 100
                                                : 0;
                                            rows.push(
                                                <tr key={`${slice.accountGuid}-${child.accountGuid}`} className="border-b border-border/50">
                                                    <td className="px-4 py-1.5 pl-10 text-foreground-secondary text-xs">{child.name}</td>
                                                    <td className="px-4 py-1.5 text-foreground-muted text-xs hidden md:table-cell">{child.path}</td>
                                                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-foreground-secondary text-xs">{formatFullCurrency(child.amount)}</td>
                                                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-foreground-muted text-xs">{childPercent.toFixed(1)}%</td>
                                                </tr>
                                            );
                                        }
                                    }
                                    return rows;
                                })}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border">
                                    <td className="px-4 py-2.5 font-semibold text-foreground">Total</td>
                                    <td className="hidden md:table-cell" />
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-foreground">
                                        {formatFullCurrency(reportData.total)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground-muted">100%</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </ReportViewer>
        </div>
    );
}
