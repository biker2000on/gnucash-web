'use client';

/**
 * Projected balance chart for the Cash Flow Forecast tool.
 * Combined balance as a primary line (with a subtle area fill), optional
 * per-account lines, and a dashed threshold reference line.
 */

import { useMemo } from 'react';
import {
    ComposedChart,
    Area,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine,
    ResponsiveContainer,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import type { ForecastPoint, ForecastAccountSummary } from '@/lib/forecast';

const ACCOUNT_COLORS = [
    'var(--color-secondary, #60a5fa)',
    'var(--color-warning, #fbbf24)',
    'var(--color-positive, #4ade80)',
    '#a78bfa',
    '#f472b6',
    '#fb923c',
    '#38bdf8',
    '#facc15',
];

export function accountColor(index: number): string {
    return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
}

interface ForecastChartProps {
    series: ForecastPoint[];
    accounts: ForecastAccountSummary[];
    threshold: number;
    showPerAccount: boolean;
}

interface ChartRow {
    date: string;
    combined: number;
    [accountGuid: string]: number | string;
}

function formatTick(dateKey: string): string {
    const [y, m, d] = dateKey.split('-').map(s => parseInt(s, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TooltipEntry {
    dataKey?: string | number;
    value?: number | Array<number>;
    color?: string;
    name?: string;
}

function ForecastTooltip({
    active,
    payload,
    label,
}: {
    active?: boolean;
    payload?: TooltipEntry[];
    label?: string;
}) {
    if (!active || !payload || payload.length === 0) return null;
    // De-duplicate the combined series (area + line share a dataKey)
    const seen = new Set<string>();
    const rows = payload.filter(entry => {
        const key = String(entry.dataKey);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return (
        <div
            className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
            style={{ fontFeatureSettings: "'tnum'" }}
        >
            <p className="font-semibold text-foreground mb-1.5">{label ? formatTick(label) : ''}</p>
            <table className="font-mono">
                <tbody>
                    {rows.map(entry => (
                        <tr key={String(entry.dataKey)} style={{ color: entry.color }}>
                            <td className="pr-3">{entry.name}</td>
                            <td className="text-right">
                                {typeof entry.value === 'number' ? formatCurrency(entry.value) : ''}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function ForecastChart({ series, accounts, threshold, showPerAccount }: ForecastChartProps) {
    const data = useMemo<ChartRow[]>(
        () =>
            series.map(point => {
                const row: ChartRow = { date: point.date, combined: point.combined };
                for (const account of accounts) {
                    row[account.guid] = point.balances[account.guid] ?? 0;
                }
                return row;
            }),
        [series, accounts]
    );

    return (
        <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                        dataKey="date"
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                        tickFormatter={formatTick}
                        minTickGap={40}
                    />
                    <YAxis
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                        tickFormatter={(v: number) => formatCurrency(v).replace('.00', '')}
                        width={88}
                    />
                    <Tooltip content={<ForecastTooltip />} />
                    {/* Combined balance */}
                    <Area
                        type="monotone"
                        dataKey="combined"
                        stroke="none"
                        fill="var(--color-primary, #2dd4bf)"
                        fillOpacity={0.08}
                        isAnimationActive={false}
                        name="Combined"
                        activeDot={false}
                    />
                    <Line
                        type="monotone"
                        dataKey="combined"
                        stroke="var(--color-primary, #2dd4bf)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        name="Combined"
                    />
                    {/* Per-account lines */}
                    {showPerAccount &&
                        accounts.map((account, i) => (
                            <Line
                                key={account.guid}
                                type="monotone"
                                dataKey={account.guid}
                                stroke={accountColor(i)}
                                strokeWidth={1.5}
                                strokeDasharray="4 3"
                                dot={false}
                                isAnimationActive={false}
                                name={account.name}
                            />
                        ))}
                    {/* Threshold */}
                    <ReferenceLine
                        y={threshold}
                        stroke="var(--color-negative, #f87171)"
                        strokeDasharray="8 4"
                        label={{
                            value: `Threshold ${formatCurrency(threshold)}`,
                            position: 'insideBottomRight',
                            fill: 'var(--color-negative, #f87171)',
                            fontSize: 11,
                        }}
                    />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}
