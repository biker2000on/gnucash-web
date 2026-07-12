'use client';

/**
 * Stacked area chart of end-of-year balances by bucket across the plan
 * horizon, with reference lines for retirement, Social Security start,
 * RMD start, and depletion (if any).
 */

import { useMemo } from 'react';
import {
    Area,
    AreaChart,
    CartesianGrid,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import type { DrawdownYearRow } from '@/lib/drawdown/types';

export const BUCKET_COLORS = {
    taxable: 'var(--color-secondary, #60a5fa)',
    traditional: 'var(--color-warning, #fbbf24)',
    roth: 'var(--color-primary, #2dd4bf)',
    hsa: 'var(--color-positive, #4ade80)',
} as const;

interface ChartRow {
    age: number;
    taxable: number;
    traditional: number;
    roth: number;
    hsa: number;
    total: number;
}

interface DrawdownChartProps {
    rows: DrawdownYearRow[];
    retirementAge: number;
    ssStartAge: number | null;
    rmdStartAge: number;
    depletionAge: number | null;
}

const fmtCompact = (v: number) => {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}k`;
    return `$${Math.round(v)}`;
};

const fmtFull = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
});

interface TooltipEntry {
    payload?: ChartRow;
}

function BalanceTooltip({ active, payload, label }: {
    active?: boolean;
    payload?: TooltipEntry[];
    label?: string | number;
}) {
    if (!active || !payload || payload.length === 0) return null;
    const row = payload[0]?.payload;
    if (!row) return null;
    const lines: Array<{ name: string; value: number; color: string }> = [
        { name: 'Taxable', value: row.taxable, color: BUCKET_COLORS.taxable },
        { name: 'Traditional', value: row.traditional, color: BUCKET_COLORS.traditional },
        { name: 'Roth', value: row.roth, color: BUCKET_COLORS.roth },
        { name: 'HSA', value: row.hsa, color: BUCKET_COLORS.hsa },
    ];
    return (
        <div
            className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
            style={{ fontFeatureSettings: "'tnum'" }}
        >
            <p className="font-semibold text-foreground mb-1.5">Age {label}</p>
            <table className="font-mono">
                <tbody>
                    {lines.map(line => (
                        <tr key={line.name} className="text-foreground-secondary">
                            <td className="pr-1">
                                <span
                                    className="inline-block w-2 h-2 rounded-sm"
                                    style={{ backgroundColor: line.color }}
                                />
                            </td>
                            <td className="pr-3">{line.name}</td>
                            <td className="text-right">{fmtFull.format(line.value)}</td>
                        </tr>
                    ))}
                    <tr className="text-foreground font-semibold">
                        <td />
                        <td className="pr-3 pt-1">Total</td>
                        <td className="text-right pt-1">{fmtFull.format(row.total)}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

export default function DrawdownChart({
    rows,
    retirementAge,
    ssStartAge,
    rmdStartAge,
    depletionAge,
}: DrawdownChartProps) {
    const data = useMemo<ChartRow[]>(
        () => rows.map(r => ({
            age: r.age,
            taxable: Math.round(r.endBalances.taxable),
            traditional: Math.round(r.endBalances.traditional),
            roth: Math.round(r.endBalances.roth),
            hsa: Math.round(r.endBalances.hsa),
            total: Math.round(r.endTotal),
        })),
        [rows],
    );
    const lastAge = rows.length > 0 ? rows[rows.length - 1].age : 0;

    return (
        <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                        dataKey="age"
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                        label={{ value: 'Age', position: 'insideBottomRight', offset: -2, fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                    />
                    <YAxis
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                        tickFormatter={fmtCompact}
                        width={64}
                    />
                    <Tooltip content={<BalanceTooltip />} />
                    <Area
                        type="monotone" dataKey="taxable" stackId="1" name="Taxable"
                        stroke={BUCKET_COLORS.taxable} fill={BUCKET_COLORS.taxable}
                        fillOpacity={0.35} isAnimationActive={false}
                    />
                    <Area
                        type="monotone" dataKey="traditional" stackId="1" name="Traditional"
                        stroke={BUCKET_COLORS.traditional} fill={BUCKET_COLORS.traditional}
                        fillOpacity={0.35} isAnimationActive={false}
                    />
                    <Area
                        type="monotone" dataKey="roth" stackId="1" name="Roth"
                        stroke={BUCKET_COLORS.roth} fill={BUCKET_COLORS.roth}
                        fillOpacity={0.35} isAnimationActive={false}
                    />
                    <Area
                        type="monotone" dataKey="hsa" stackId="1" name="HSA"
                        stroke={BUCKET_COLORS.hsa} fill={BUCKET_COLORS.hsa}
                        fillOpacity={0.35} isAnimationActive={false}
                    />
                    {retirementAge >= (rows[0]?.age ?? 0) && retirementAge <= lastAge && (
                        <ReferenceLine
                            x={retirementAge}
                            stroke="var(--color-foreground-muted)"
                            strokeDasharray="4 4"
                            label={{ value: `Retire ${retirementAge}`, position: 'insideTopLeft', fill: 'var(--color-foreground-muted)', fontSize: 11 }}
                        />
                    )}
                    {ssStartAge !== null && ssStartAge <= lastAge && (
                        <ReferenceLine
                            x={ssStartAge}
                            stroke="var(--color-secondary, #60a5fa)"
                            strokeDasharray="4 4"
                            label={{ value: `SS ${ssStartAge}`, position: 'insideTop', fill: 'var(--color-secondary, #60a5fa)', fontSize: 11 }}
                        />
                    )}
                    {rmdStartAge <= lastAge && (
                        <ReferenceLine
                            x={rmdStartAge}
                            stroke="var(--color-warning, #fbbf24)"
                            strokeDasharray="4 4"
                            label={{ value: `RMD ${rmdStartAge}`, position: 'insideTopRight', fill: 'var(--color-warning, #fbbf24)', fontSize: 11 }}
                        />
                    )}
                    {depletionAge !== null && (
                        <ReferenceLine
                            x={depletionAge}
                            stroke="var(--color-negative, #f87171)"
                            label={{ value: `Depleted ${depletionAge}`, position: 'insideBottomRight', fill: 'var(--color-negative, #f87171)', fontSize: 11 }}
                        />
                    )}
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
