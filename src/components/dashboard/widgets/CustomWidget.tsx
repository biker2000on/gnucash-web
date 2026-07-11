'use client';

import { useMemo } from 'react';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import {
    CustomWidgetDef,
    DEFAULT_SERIES_MONTHS,
    describeCustomWidget,
    isChartViz,
} from '@/lib/dashboard-widgets';
import { WidgetShell, useWidgetFetch, TNUM } from './WidgetShell';

interface CustomWidgetStatResult {
    value: number;
    accountCount: number;
}

interface SeriesPoint {
    month: string; // 'YYYY-MM'
    value: number;
}

interface CustomWidgetSeriesResult {
    series: SeriesPoint[];
    accountCount: number;
}

/** 'YYYY-MM' → 'Jan' (or "Jan '25" when the window spans years). */
function formatMonthTick(month: string, longWindow: boolean): string {
    const [year, mo] = month.split('-');
    const date = new Date(parseInt(year, 10), parseInt(mo, 10) - 1, 1);
    const name = date.toLocaleDateString('en-US', { month: 'short' });
    return longWindow ? `${name} '${year.slice(2)}` : name;
}

function formatMonthLong(month: string): string {
    const [year, mo] = month.split('-');
    const date = new Date(parseInt(year, 10), parseInt(mo, 10) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

interface SeriesTooltipProps {
    active?: boolean;
    payload?: Array<{ value: number }>;
    label?: string;
}

function SeriesTooltip({ active, payload, label }: SeriesTooltipProps) {
    if (!active || !payload?.length || !label) return null;
    return (
        <div className="bg-surface-elevated border border-border rounded-lg px-2.5 py-1.5 shadow-xl">
            <p className="text-[10px] text-foreground-muted">{formatMonthLong(label)}</p>
            <p className="font-mono tabular-nums text-xs text-foreground" style={TNUM}>
                {formatCurrency(payload[0].value)}
            </p>
        </div>
    );
}

const AXIS_TICK = {
    fill: 'var(--foreground-muted)',
    fontSize: 9,
    fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
} as const;

/** Compact recharts series (~90px tall): flat primary color, mono ticks, no grid/legend. */
function CustomWidgetChart({ def, series }: { def: CustomWidgetDef; series: SeriesPoint[] }) {
    const longWindow = (def.config.months ?? DEFAULT_SERIES_MONTHS) > 12;
    const tickFormatter = (m: string) => formatMonthTick(m, longWindow);
    // First / middle / last ticks only — keeps the axis quiet at this density.
    const tickInterval = Math.max(1, Math.ceil(series.length / 3) - 1);

    const xAxisProps = {
        dataKey: 'month',
        tickFormatter,
        tick: AXIS_TICK,
        axisLine: { stroke: 'var(--border)' },
        tickLine: false as const,
        interval: tickInterval,
        height: 14,
    };

    return (
        <div className="-mx-1">
            <ResponsiveContainer width="100%" height={90}>
                {def.viz === 'bar' ? (
                    <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                        <XAxis {...xAxisProps} />
                        <YAxis hide domain={['auto', 'auto']} />
                        <Tooltip content={<SeriesTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
                        <Bar
                            dataKey="value"
                            fill="var(--primary)"
                            radius={[2, 2, 0, 0]}
                            maxBarSize={18}
                            isAnimationActive={false}
                        />
                    </BarChart>
                ) : (
                    <LineChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                        <XAxis {...xAxisProps} />
                        <YAxis hide domain={['auto', 'auto']} />
                        <Tooltip content={<SeriesTooltip />} cursor={{ stroke: 'var(--border)' }} />
                        <Line
                            type="monotone"
                            dataKey="value"
                            stroke="var(--primary)"
                            strokeWidth={1.5}
                            dot={false}
                            activeDot={{ r: 2.5, fill: 'var(--primary)', strokeWidth: 0 }}
                            isAnimationActive={false}
                        />
                    </LineChart>
                )}
            </ResponsiveContainer>
        </div>
    );
}

/**
 * Renders a user-defined widget by evaluating its definition through
 * GET /api/dashboard/custom-widget (book-scoped, server-computed).
 * viz 'stat' shows a single number; 'spark'/'bar' show a monthly series.
 */
export default function CustomWidget({ def }: { def: CustomWidgetDef }) {
    const chart = isChartViz(def.viz);

    const url = useMemo(() => {
        const params = new URLSearchParams();
        params.set('ids', def.config.accountGuids.join(','));
        params.set('mode', def.config.mode);
        if (chart) {
            params.set('viz', 'series');
            params.set('months', String(def.config.months ?? DEFAULT_SERIES_MONTHS));
        } else if (def.config.mode === 'spend') {
            params.set('days', String(def.config.days ?? 90));
        }
        return `/api/dashboard/custom-widget?${params.toString()}`;
    }, [def, chart]);

    const { data, loading, error } = useWidgetFetch<
        CustomWidgetStatResult & Partial<CustomWidgetSeriesResult>
    >(url);

    const tone = !data || chart
        ? 'text-foreground'
        : def.config.toneBySign
            ? data.value > 0.004
                ? 'text-positive'
                : data.value < -0.004
                    ? 'text-negative'
                    : 'text-foreground'
            : 'text-foreground';

    return (
        <WidgetShell
            title={def.name}
            href="/accounts"
            hrefLabel="Accounts"
            loading={loading}
            error={error}
            empty={!!data && data.accountCount === 0}
            emptyText="None of this widget's accounts exist in the active book."
        >
            {data && (
                chart ? (
                    <div>
                        <CustomWidgetChart def={def} series={data.series ?? []} />
                        <div className="mt-1.5 text-[11px] text-foreground-muted">
                            {describeCustomWidget(def)}
                        </div>
                    </div>
                ) : (
                    <div>
                        <div
                            className={`font-mono font-semibold tabular-nums text-2xl ${tone}`}
                            style={TNUM}
                        >
                            {formatCurrency(data.value)}
                        </div>
                        <div className="mt-1 text-[11px] text-foreground-muted">
                            {describeCustomWidget(def)}
                        </div>
                    </div>
                )
            )}
        </WidgetShell>
    );
}
