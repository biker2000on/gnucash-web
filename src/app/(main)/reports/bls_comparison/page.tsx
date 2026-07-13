'use client';

import { useState, useEffect, useCallback } from 'react';
import type { BlsComparisonData, BlsComparisonRow } from '@/lib/bls-comparison';
import { formatCurrency } from '@/lib/format';
import {
    BarChart,
    Bar,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine,
    ResponsiveContainer,
} from 'recharts';

// Solid series colors (match existing income/expense report charts)
const ABOVE_AVERAGE_COLOR = '#f43f5e'; // spending more than average
const BELOW_AVERAGE_COLOR = '#10b981'; // spending less than average

const HOUSEHOLD_SIZES = [
    { value: 1, label: '1 person' },
    { value: 2, label: '2 people' },
    { value: 3, label: '3 people' },
    { value: 4, label: '4 people' },
    { value: 5, label: '5+ people' },
];

function formatCompactCurrency(value: number): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    return `${sign}$${abs.toFixed(0)}`;
}

interface TooltipProps {
    active?: boolean;
    payload?: Array<{ payload: BlsComparisonRow }>;
}

function DeltaTooltip({ active, payload }: TooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    const row = payload[0].payload;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl text-sm">
            <p className="text-foreground font-medium mb-1">{row.label}</p>
            <div className="space-y-0.5 text-xs">
                <p className="text-foreground-secondary">
                    You: <span className="font-mono tabular-nums text-foreground">{formatCurrency(row.yourSpend)}</span>
                </p>
                <p className="text-foreground-secondary">
                    BLS avg: <span className="font-mono tabular-nums text-foreground">{formatCurrency(row.blsAverage)}</span>
                </p>
                <p className={row.delta >= 0 ? 'text-negative' : 'text-positive'}>
                    {row.delta >= 0 ? 'Above average by ' : 'Below average by '}
                    <span className="font-mono tabular-nums">{formatCurrency(Math.abs(row.delta))}</span>
                </p>
            </div>
        </div>
    );
}

export default function BlsComparisonPage() {
    const currentYear = new Date().getFullYear();
    const [year, setYear] = useState(currentYear - 1);
    const [householdSize, setHouseholdSize] = useState(2);
    const [reportData, setReportData] = useState<BlsComparisonData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({
                year: String(year),
                householdSize: String(householdSize),
            });
            const res = await fetch(`/api/reports/bls-comparison?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: BlsComparisonData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [year, householdSize]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const years = Array.from({ length: 10 }, (_, i) => currentYear - i);
    const selectClass =
        'px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary transition-colors';

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Spending vs National Averages</h1>
                <p className="text-sm text-foreground-secondary mt-1">
                    Your annual spending by category compared to BLS Consumer Expenditure Survey averages
                </p>
            </div>

            {/* Controls */}
            <div className="bg-surface border border-border rounded-lg p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                    Year
                    <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectClass}>
                        {years.map((y) => (
                            <option key={y} value={y}>{y}</option>
                        ))}
                    </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                    Household size
                    <select
                        value={householdSize}
                        onChange={(e) => setHouseholdSize(Number(e.target.value))}
                        className={selectClass}
                    >
                        {HOUSEHOLD_SIZES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                </label>
                {isLoading && <span className="text-xs text-foreground-muted">Loading…</span>}
            </div>

            {error && (
                <div className="px-4 py-3 border border-error/40 bg-error/10 rounded-lg text-sm text-error">
                    {error}
                </div>
            )}

            {reportData && (
                <>
                    {/* Diverging bar chart: delta vs BLS average */}
                    <div className="bg-surface border border-border rounded-lg">
                        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
                            <h2 className="text-sm font-medium text-foreground">Difference from average ({reportData.year})</h2>
                            <span className="text-xs text-foreground-muted md:ml-auto">
                                <span style={{ color: BELOW_AVERAGE_COLOR }}>■</span> below average
                                <span className="ml-3" style={{ color: ABOVE_AVERAGE_COLOR }}>■</span> above average
                            </span>
                        </div>
                        <div className="p-4">
                            <ResponsiveContainer width="100%" height={420}>
                                <BarChart
                                    data={reportData.rows}
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
                                        dataKey="label"
                                        width={190}
                                        stroke="var(--foreground-secondary)"
                                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                        axisLine={{ stroke: 'var(--border)' }}
                                        tickLine={false}
                                    />
                                    <Tooltip content={<DeltaTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
                                    <ReferenceLine x={0} stroke="var(--foreground-muted)" />
                                    <Bar dataKey="delta" maxBarSize={18} radius={[0, 3, 3, 0]}>
                                        {reportData.rows.map((row) => (
                                            <Cell
                                                key={row.category}
                                                fill={row.delta >= 0 ? ABOVE_AVERAGE_COLOR : BELOW_AVERAGE_COLOR}
                                            />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Table */}
                    <div className="bg-surface border border-border rounded-lg overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-background-tertiary/50">
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Category</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Your spend ({reportData.year})</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">BLS average</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Ratio</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Difference</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reportData.rows.map((row) => (
                                    <tr key={row.category} className="border-b border-border/50">
                                        <td className="px-4 py-2 text-foreground">{row.label}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                                            {formatCurrency(row.yourSpend)}
                                        </td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">
                                            {formatCurrency(row.blsAverage)}
                                        </td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">
                                            {row.ratio === null ? '—' : `${(row.ratio * 100).toFixed(0)}%`}
                                        </td>
                                        <td className={`px-4 py-2 text-right font-mono tabular-nums ${
                                            row.delta >= 0 ? 'text-negative' : 'text-positive'
                                        }`}>
                                            {row.delta >= 0 ? '+' : ''}{formatCurrency(row.delta)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border">
                                    <td className="px-4 py-2.5 font-semibold text-foreground">Total (mapped categories)</td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-foreground">
                                        {formatCurrency(reportData.totals.yourSpend)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-foreground-secondary">
                                        {formatCurrency(reportData.totals.blsAverage)}
                                    </td>
                                    <td />
                                    <td className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                                        reportData.totals.delta >= 0 ? 'text-negative' : 'text-positive'
                                    }`}>
                                        {reportData.totals.delta >= 0 ? '+' : ''}{formatCurrency(reportData.totals.delta)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    {/* Unmapped spending */}
                    {reportData.unmapped.total !== 0 && (
                        <div className="bg-surface border border-border rounded-lg px-4 py-3">
                            <p className="text-sm text-foreground">
                                Not compared: <span className="font-mono tabular-nums">{formatCurrency(reportData.unmapped.total)}</span>{' '}
                                <span className="text-foreground-muted">
                                    in expense accounts that did not match any BLS category
                                    {reportData.unmapped.accounts.length > 0 && (
                                        <> (largest: {reportData.unmapped.accounts.slice(0, 3).map(a => a.path).join(', ')})</>
                                    )}
                                </span>
                            </p>
                        </div>
                    )}

                    {/* Methodology footnote */}
                    <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 space-y-1">
                        <p className="text-sm font-medium text-foreground">Methodology &amp; caveats</p>
                        <p className="text-xs text-foreground-secondary">
                            Averages are an approximate embedded snapshot of the {reportData.vintage}.
                            They are national means per consumer unit — not adjusted for region, income,
                            or cost of living — and household-size figures are derived with coarse
                            multipliers. Your accounts are mapped to BLS categories with a keyword
                            heuristic over account names, which can misfile spending; unmapped expense
                            accounts are excluded and listed above. Treat this as directional, not exact.
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}
