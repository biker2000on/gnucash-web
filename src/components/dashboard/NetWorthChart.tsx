'use client';

import { useContext, useMemo, useState } from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from 'recharts';
import { ExpandedContext } from '@/components/charts/ExpandableChart';
import { clipFuturePoints, fitDomain } from '@/lib/charts/fit-domain';

interface NetWorthDataPoint {
    date: string;
    netWorth: number;
    assets: number;
    liabilities: number;
}

interface NetWorthChartProps {
    data: NetWorthDataPoint[];
    loading: boolean;
}

type SeriesKey = 'netWorth' | 'assets' | 'liabilities';

const SERIES_LABELS: Record<SeriesKey, string> = {
    netWorth: 'Net Worth',
    assets: 'Assets',
    liabilities: 'Liabilities',
};

// All series start visible; the legend hides and restores them.
const DEFAULT_HIDDEN: SeriesKey[] = [];
const HIDDEN_STORAGE_KEY = 'dashboard.netWorthChart.hiddenSeries.v2';
// Liabilities get their own right-hand axis by default. On one shared axis the
// range runs from the liability floor to the asset ceiling, which flattens
// every line's movement over a short period.
const SHARED_SCALE_STORAGE_KEY = 'dashboard.netWorthChart.sharedScale';
const LIABILITY_COLOR = '#f87171';

function loadHidden(): Set<SeriesKey> {
    if (typeof window === 'undefined') return new Set(DEFAULT_HIDDEN);
    try {
        const raw = localStorage.getItem(HIDDEN_STORAGE_KEY);
        if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(parsed.filter((k): k is SeriesKey => k in SERIES_LABELS));
            }
        }
    } catch {
        // Storage unavailable or corrupt: fall back to the default.
    }
    return new Set(DEFAULT_HIDDEN);
}

function saveHidden(hidden: Set<SeriesKey>) {
    try {
        localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify([...hidden]));
    } catch {
        // Non-essential preference; ignore storage failures.
    }
}

function loadSharedScale(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return localStorage.getItem(SHARED_SCALE_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function saveSharedScale(shared: boolean) {
    try {
        localStorage.setItem(SHARED_SCALE_STORAGE_KEY, String(shared));
    } catch {
        // Non-essential preference; ignore storage failures.
    }
}

const compactCurrency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumSignificantDigits: 3,
});

function formatCurrency(value: number): string {
    return compactCurrency.format(value);
}

function formatFullCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function formatDate(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function localToday(): string {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${mm}-${dd}`;
}

function ChartSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-lg p-6 animate-pulse">
            <div className="h-5 w-40 bg-background-secondary rounded mb-6" />
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

    const date = new Date(label + 'T00:00:00');
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
                        <span className="text-foreground-secondary">
                            {SERIES_LABELS[entry.dataKey as SeriesKey] ?? entry.dataKey}
                        </span>
                    </span>
                    <span className="font-medium text-foreground font-mono tabular-nums">
                        {formatFullCurrency(entry.value)}
                    </span>
                </div>
            ))}
        </div>
    );
}

export default function NetWorthChart({ data, loading }: NetWorthChartProps) {
    const expanded = useContext(ExpandedContext);
    // The chart only renders after its data loads on the client (the server
    // pass shows the skeleton), so reading storage here cannot cause a
    // hydration mismatch.
    const [hidden, setHidden] = useState<Set<SeriesKey>>(loadHidden);
    const [sharedScale, setSharedScale] = useState<boolean>(loadSharedScale);

    const points = useMemo(() => clipFuturePoints(data ?? [], localToday()), [data]);

    // A second axis only makes sense when liabilities share the chart with at
    // least one other visible series.
    const canSplit = !hidden.has('liabilities') && (!hidden.has('netWorth') || !hidden.has('assets'));
    const split = canSplit && !sharedScale;

    const { leftAxis, rightAxis } = useMemo(() => {
        const visible = (Object.keys(SERIES_LABELS) as SeriesKey[]).filter((k) => !hidden.has(k));
        const leftKeys = split ? visible.filter((k) => k !== 'liabilities') : visible;
        return {
            leftAxis: fitDomain(points.flatMap((p) => leftKeys.map((k) => p[k]))),
            rightAxis: split ? fitDomain(points.map((p) => p.liabilities)) : null,
        };
    }, [points, hidden, split]);

    const toggleSharedScale = () => {
        setSharedScale((prev) => {
            saveSharedScale(!prev);
            return !prev;
        });
    };

    const toggleSeries = (key: SeriesKey) => {
        setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            // Never hide everything; an empty chart reads as "no data".
            if (next.size === Object.keys(SERIES_LABELS).length) return prev;
            saveHidden(next);
            return next;
        });
    };

    if (loading) return <ChartSkeleton />;

    if (points.length === 0) {
        return (
            <div className={`bg-surface border border-border rounded-lg p-6 ${expanded ? 'h-full' : ''}`}>
                <h3 className="text-lg font-semibold text-foreground mb-4">Net Worth Over Time</h3>
                <div className="h-[350px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No net worth data available for this period.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={`bg-surface border border-border rounded-lg p-6 ${expanded ? 'h-full' : ''}`}>
            {/* pr-6 keeps the chip clear of ExpandableChart's hover-only
                expand button in the card's top-right corner. */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pr-6">
                <h3 className="text-lg font-semibold text-foreground">Net Worth Over Time</h3>
                {canSplit && (
                    <button
                        type="button"
                        onClick={toggleSharedScale}
                        aria-pressed={sharedScale}
                        className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            sharedScale
                                ? 'border-primary/60 bg-primary-light text-primary'
                                : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                        }`}
                    >
                        Same scale
                    </button>
                )}
            </div>
            <ResponsiveContainer width="100%" height={expanded ? '100%' : 350}>
                <LineChart data={points} margin={{ top: 5, right: split ? 10 : 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                        dataKey="date"
                        tickFormatter={formatDate}
                        stroke="var(--foreground-secondary)"
                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                    />
                    <YAxis
                        yAxisId="left"
                        tickFormatter={formatCurrency}
                        domain={leftAxis?.domain ?? ['auto', 'auto']}
                        ticks={leftAxis?.ticks}
                        allowDataOverflow
                        stroke="var(--foreground-secondary)"
                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                        width={70}
                    />
                    {/* Liabilities' own scale, colored to match its line so the
                        pairing is unambiguous. */}
                    <YAxis
                        yAxisId="right"
                        orientation="right"
                        hide={!split}
                        tickFormatter={formatCurrency}
                        domain={rightAxis?.domain ?? ['auto', 'auto']}
                        ticks={rightAxis?.ticks}
                        allowDataOverflow
                        stroke={LIABILITY_COLOR}
                        tick={{ fill: LIABILITY_COLOR, fontSize: 12 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                        width={70}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend
                        wrapperStyle={{ paddingTop: '16px', cursor: 'pointer' }}
                        onClick={(entry) => {
                            const key = entry?.dataKey;
                            if (typeof key === 'string' && key in SERIES_LABELS) toggleSeries(key as SeriesKey);
                        }}
                        formatter={(value: string) => {
                            const key = value as SeriesKey;
                            return (
                                <span
                                    className={`text-sm ${hidden.has(key) ? 'text-foreground-muted line-through' : 'text-foreground-secondary'}`}
                                >
                                    {SERIES_LABELS[key] ?? value}
                                </span>
                            );
                        }}
                    />
                    <Line
                        type="monotone"
                        dataKey="netWorth"
                        yAxisId="left"
                        hide={hidden.has('netWorth')}
                        stroke="#34d399"
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 5, fill: '#34d399', stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                    <Line
                        type="monotone"
                        dataKey="assets"
                        yAxisId="left"
                        hide={hidden.has('assets')}
                        stroke="#22d3ee"
                        strokeWidth={1.5}
                        dot={false}
                        strokeDasharray="4 4"
                        activeDot={{ r: 4, fill: '#22d3ee', stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                    <Line
                        type="monotone"
                        dataKey="liabilities"
                        yAxisId={split ? 'right' : 'left'}
                        hide={hidden.has('liabilities')}
                        stroke={LIABILITY_COLOR}
                        strokeWidth={1.5}
                        dot={false}
                        strokeDasharray="4 4"
                        activeDot={{ r: 4, fill: LIABILITY_COLOR, stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
