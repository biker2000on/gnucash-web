'use client';

/**
 * Scenario Sandbox charts — baseline vs scenario comparison lines.
 * Cash flow: projected liquid balance by month (5 yr) with negative months
 * highlighted. Net worth: projected net worth by year (30 yr).
 */

import { useMemo } from 'react';
import {
    CartesianGrid,
    Line,
    LineChart,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import type { CashFlowMonthPoint, NetWorthYearPoint } from '@/lib/scenario/types';

export const SERIES_COLORS = {
    baseline: 'var(--color-secondary, #60a5fa)',
    scenario: 'var(--color-primary, #2dd4bf)',
    negative: 'var(--color-negative, #f87171)',
} as const;

const fmtCompact = (v: number) => {
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
    return `${sign}$${Math.round(abs)}`;
};

const fmtFull = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
});

function ComparisonTooltip({ active, payload, label, baselineName, scenarioName }: {
    active?: boolean;
    payload?: Array<{ dataKey?: string | number; value?: number | string }>;
    label?: string | number;
    baselineName: string;
    scenarioName: string;
}) {
    if (!active || !payload || payload.length === 0) return null;
    const get = (key: string) => {
        const entry = payload.find(p => p.dataKey === key);
        const v = typeof entry?.value === 'number' ? entry.value : null;
        return v;
    };
    const baseline = get('baseline');
    const scenario = get('scenario');
    if (baseline === null && scenario === null) return null;
    const delta = baseline !== null && scenario !== null ? scenario - baseline : null;
    return (
        <div
            className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
            style={{ fontFeatureSettings: "'tnum'" }}
        >
            <p className="font-semibold text-foreground mb-1.5">{label}</p>
            <table className="font-mono">
                <tbody>
                    {baseline !== null && (
                        <tr className="text-foreground-secondary">
                            <td className="pr-1">
                                <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: SERIES_COLORS.baseline }} />
                            </td>
                            <td className="pr-3">{baselineName}</td>
                            <td className="text-right">{fmtFull.format(baseline)}</td>
                        </tr>
                    )}
                    {scenario !== null && (
                        <tr className="text-foreground-secondary">
                            <td className="pr-1">
                                <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: SERIES_COLORS.scenario }} />
                            </td>
                            <td className="pr-3">{scenarioName}</td>
                            <td className="text-right">{fmtFull.format(scenario)}</td>
                        </tr>
                    )}
                    {delta !== null && (
                        <tr className={delta >= 0 ? 'text-positive font-semibold' : 'text-negative font-semibold'}>
                            <td />
                            <td className="pr-3 pt-1">Delta</td>
                            <td className="text-right pt-1">
                                {delta >= 0 ? '+' : ''}{fmtFull.format(delta)}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

export function ChartLegend() {
    return (
        <div className="flex items-center gap-4 text-xs text-foreground-muted">
            <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5" style={{ backgroundColor: SERIES_COLORS.baseline }} />
                Baseline
            </span>
            <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5" style={{ backgroundColor: SERIES_COLORS.scenario }} />
                Scenario
            </span>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Cash flow                                                           */
/* ------------------------------------------------------------------ */

export function CashFlowChart({ months, firstNegativeMonth }: {
    months: CashFlowMonthPoint[];
    firstNegativeMonth: string | null;
}) {
    const data = useMemo(
        () => months.map(m => ({
            month: m.month,
            baseline: m.baselineBalance,
            scenario: m.scenarioBalance,
        })),
        [months],
    );

    return (
        <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                        dataKey="month"
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 11 }}
                        interval={Math.max(0, Math.floor(data.length / 10) - 1)}
                    />
                    <YAxis
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                        tickFormatter={fmtCompact}
                        width={64}
                    />
                    <Tooltip content={
                        <ComparisonTooltip baselineName="Baseline balance" scenarioName="Scenario balance" />
                    } />
                    <ReferenceLine y={0} stroke={SERIES_COLORS.negative} strokeDasharray="4 4" />
                    {firstNegativeMonth !== null && (
                        <ReferenceLine
                            x={firstNegativeMonth}
                            stroke={SERIES_COLORS.negative}
                            label={{
                                value: `Negative ${firstNegativeMonth}`,
                                position: 'insideTopRight',
                                fill: SERIES_COLORS.negative,
                                fontSize: 11,
                            }}
                        />
                    )}
                    <Line
                        type="monotone" dataKey="baseline" name="Baseline"
                        stroke={SERIES_COLORS.baseline} strokeWidth={1.5}
                        dot={false} isAnimationActive={false}
                    />
                    <Line
                        type="monotone" dataKey="scenario" name="Scenario"
                        stroke={SERIES_COLORS.scenario} strokeWidth={2}
                        dot={false} isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Net worth                                                           */
/* ------------------------------------------------------------------ */

export function NetWorthChart({ points }: { points: NetWorthYearPoint[] }) {
    const data = useMemo(
        () => points.map(p => ({
            year: p.year,
            baseline: p.baseline,
            scenario: p.scenario,
        })),
        [points],
    );

    return (
        <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                        dataKey="year"
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                    />
                    <YAxis
                        stroke="var(--color-foreground-muted)"
                        tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                        tickFormatter={fmtCompact}
                        width={72}
                    />
                    <Tooltip content={
                        <ComparisonTooltip baselineName="Baseline net worth" scenarioName="Scenario net worth" />
                    } />
                    <ReferenceLine y={0} stroke="var(--color-border)" />
                    <Line
                        type="monotone" dataKey="baseline" name="Baseline"
                        stroke={SERIES_COLORS.baseline} strokeWidth={1.5}
                        dot={false} isAnimationActive={false}
                    />
                    <Line
                        type="monotone" dataKey="scenario" name="Scenario"
                        stroke={SERIES_COLORS.scenario} strokeWidth={2}
                        dot={false} isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
