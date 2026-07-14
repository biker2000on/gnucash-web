'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import {
    ReportDrilldownTable,
    DrilldownColumn,
    DrilldownGroup,
} from '@/components/reports/ReportDrilldownTable';
import { ReportFilters } from '@/lib/reports/types';
import type {
    NetWorthAttributionData,
    SavingsDrillRow,
    MarketDrillRow,
    DebtDrillRow,
    OtherDrillRow,
} from '@/lib/reports/net-worth-attribution';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ReferenceLine,
    ResponsiveContainer,
} from 'recharts';

/* Solid series colors — no gradients (DESIGN.md) */
const COMPONENT_COLORS: Record<ComponentKey, string> = {
    savings: '#10b981',
    marketGains: '#60a5fa',
    debtPaydown: '#fbbf24',
    other: '#94a3b8',
};

type ComponentKey = 'savings' | 'marketGains' | 'debtPaydown' | 'other';

const COMPONENT_LABELS: Record<ComponentKey, string> = {
    savings: 'Savings (net cash flow)',
    marketGains: 'Market gains/losses',
    debtPaydown: 'Debt paydown',
    other: 'Transfers / equity / other',
};

const COMPONENT_KEYS: ComponentKey[] = ['savings', 'marketGains', 'debtPaydown', 'other'];

function toDateString(d: Date): string {
    return d.toISOString().split('T')[0];
}

type PresetKey = 'month' | 'quarter' | 'year' | 'lastYear';

function presetRange(preset: PresetKey): { startDate: string; endDate: string } {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    switch (preset) {
        case 'month':
            return {
                startDate: toDateString(new Date(Date.UTC(y, m, 1))),
                endDate: toDateString(now),
            };
        case 'quarter': {
            const qStart = Math.floor(m / 3) * 3;
            return {
                startDate: toDateString(new Date(Date.UTC(y, qStart, 1))),
                endDate: toDateString(now),
            };
        }
        case 'year':
            return { startDate: `${y}-01-01`, endDate: toDateString(now) };
        case 'lastYear':
            return { startDate: `${y - 1}-01-01`, endDate: `${y - 1}-12-31` };
    }
}

function formatFullCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function formatSignedCurrency(value: number): string {
    return `${value >= 0 ? '+' : ''}${formatFullCurrency(value)}`;
}

function formatCompactCurrency(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
}

function amountClass(value: number): string {
    if (value > 0) return 'text-positive';
    if (value < 0) return 'text-negative';
    return 'text-foreground-secondary';
}

/* ------------------------------------------------------------------ */
/* Waterfall summary                                                   */
/* ------------------------------------------------------------------ */

function WaterfallSummary({ data }: { data: NetWorthAttributionData }) {
    const components = COMPONENT_KEYS.map(key => ({
        key,
        label: COMPONENT_LABELS[key],
        amount: data.components[key],
        color: COMPONENT_COLORS[key],
    }));

    const maxAbs = Math.max(1, ...components.map(c => Math.abs(c.amount)));
    const totalMagnitude = components.reduce((s, c) => s + Math.abs(c.amount), 0);

    return (
        <div className="p-6 space-y-4">
            {/* Start / change / end headline */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-md border border-border bg-background-tertiary/30 px-4 py-3">
                    <p className="text-xs uppercase tracking-wider text-foreground-muted mb-1">
                        Start net worth · {data.startDate}
                    </p>
                    <p className="font-mono tabular-nums text-xl text-foreground">
                        {formatFullCurrency(data.startNetWorth)}
                    </p>
                </div>
                <div className="rounded-md border border-border bg-background-tertiary/30 px-4 py-3">
                    <p className="text-xs uppercase tracking-wider text-foreground-muted mb-1">
                        Change
                    </p>
                    <p className={`font-mono tabular-nums text-xl ${amountClass(data.totalChange)}`}>
                        {formatSignedCurrency(data.totalChange)}
                    </p>
                </div>
                <div className="rounded-md border border-border bg-background-tertiary/30 px-4 py-3">
                    <p className="text-xs uppercase tracking-wider text-foreground-muted mb-1">
                        End net worth · {data.endDate}
                    </p>
                    <p className="font-mono tabular-nums text-xl text-foreground">
                        {formatFullCurrency(data.endNetWorth)}
                    </p>
                </div>
            </div>

            {/* Horizontal stacked composition strip */}
            {totalMagnitude > 0 && (
                <div>
                    <div className="flex h-3 w-full overflow-hidden rounded-sm border border-border">
                        {components
                            .filter(c => Math.abs(c.amount) > 0)
                            .map(c => (
                                <div
                                    key={c.key}
                                    title={`${c.label}: ${formatSignedCurrency(c.amount)}`}
                                    style={{
                                        width: `${(Math.abs(c.amount) / totalMagnitude) * 100}%`,
                                        backgroundColor: c.color,
                                        opacity: c.amount < 0 ? 0.45 : 1,
                                    }}
                                />
                            ))}
                    </div>
                    <p className="mt-1 text-[11px] text-foreground-muted">
                        Segment width = share of total movement; dimmed = negative contribution
                    </p>
                </div>
            )}

            {/* Component rows with center-axis bars */}
            <div className="space-y-2">
                {components.map(c => (
                    <div key={c.key} className="flex items-center gap-3">
                        <span className="w-52 shrink-0 text-sm text-foreground-secondary flex items-center gap-2">
                            <span
                                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                                style={{ backgroundColor: c.color }}
                            />
                            {c.label}
                        </span>
                        <div className="relative flex-1 h-5 rounded-sm bg-background-tertiary/40 overflow-hidden">
                            <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                            <div
                                className="absolute inset-y-1 rounded-sm"
                                style={{
                                    backgroundColor: c.color,
                                    left: c.amount >= 0 ? '50%' : undefined,
                                    right: c.amount < 0 ? '50%' : undefined,
                                    width: `${(Math.abs(c.amount) / maxAbs) * 50}%`,
                                }}
                            />
                        </div>
                        <span className={`w-36 shrink-0 text-right font-mono tabular-nums text-sm ${amountClass(c.amount)}`}>
                            {formatSignedCurrency(c.amount)}
                        </span>
                    </div>
                ))}
                <div className="flex items-center gap-3 border-t border-border pt-2">
                    <span className="w-52 shrink-0 text-sm font-semibold text-foreground">Total change</span>
                    <div className="flex-1" />
                    <span className={`w-36 shrink-0 text-right font-mono tabular-nums text-sm font-semibold ${amountClass(data.totalChange)}`}>
                        {formatSignedCurrency(data.totalChange)}
                    </span>
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Monthly stacked bar chart                                           */
/* ------------------------------------------------------------------ */

interface MonthTooltipProps {
    active?: boolean;
    payload?: Array<{ value: number; dataKey: string; color: string }>;
    label?: string;
}

function MonthTooltip({ active, payload, label }: MonthTooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    const net = payload.reduce((s, p) => s + p.value, 0);
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-2">{label}</p>
            {payload.map(entry => (
                <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-foreground-secondary">
                            {COMPONENT_LABELS[entry.dataKey as ComponentKey] ?? entry.dataKey}
                        </span>
                    </span>
                    <span className="font-mono tabular-nums text-foreground">
                        {formatSignedCurrency(entry.value)}
                    </span>
                </div>
            ))}
            <div className="flex items-center justify-between gap-4 text-sm border-t border-border mt-2 pt-1.5">
                <span className="text-foreground-secondary">Net change</span>
                <span className={`font-mono tabular-nums ${amountClass(net)}`}>
                    {formatSignedCurrency(net)}
                </span>
            </div>
        </div>
    );
}

function MonthlyChart({ data }: { data: NetWorthAttributionData }) {
    if (data.monthly.length < 2) return null;
    return (
        <div className="px-6 pb-6">
            <h3 className="text-sm font-semibold text-foreground mb-3">Monthly decomposition</h3>
            <ResponsiveContainer width="100%" height={340}>
                <BarChart data={data.monthly} margin={{ top: 5, right: 20, left: 10, bottom: 5 }} stackOffset="sign">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                        dataKey="label"
                        stroke="var(--foreground-secondary)"
                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                    />
                    <YAxis
                        tickFormatter={formatCompactCurrency}
                        stroke="var(--foreground-secondary)"
                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                        width={72}
                    />
                    <Tooltip content={<MonthTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
                    <Legend
                        wrapperStyle={{ paddingTop: '12px' }}
                        formatter={(value: string) => (
                            <span className="text-foreground-secondary text-sm">
                                {COMPONENT_LABELS[value as ComponentKey] ?? value}
                            </span>
                        )}
                    />
                    <ReferenceLine y={0} stroke="var(--border-hover)" />
                    {COMPONENT_KEYS.map(key => (
                        <Bar
                            key={key}
                            dataKey={key}
                            stackId="components"
                            fill={COMPONENT_COLORS[key]}
                            maxBarSize={40}
                        />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Drill-down tables                                                   */
/* ------------------------------------------------------------------ */

/** Signed-amount cell with positive/negative coloring. */
function AmountCell({ value }: { value: number }) {
    return <span className={amountClass(value)}>{formatSignedCurrency(value)}</span>;
}

/** Sort rows by descending magnitude of the given amount. */
function byMagnitude<T>(rows: T[], amount: (r: T) => number): T[] {
    return [...rows].sort((a, b) => Math.abs(amount(b)) - Math.abs(amount(a)));
}

/* ---- Savings: grouped by kind (Income / Spending / Debt service) ---- */
function savingsGroups(rows: SavingsDrillRow[]): DrilldownGroup<SavingsDrillRow>[] {
    const of = (kind: SavingsDrillRow['kind']) => byMagnitude(rows.filter(r => r.kind === kind), r => r.amount);
    return [
        { key: 'income', label: 'Income', rows: of('income') },
        { key: 'expense', label: 'Spending', rows: of('expense') },
        { key: 'debt_service', label: 'Debt service', rows: of('debt_service') },
    ];
}
const savingsColumns: DrilldownColumn<SavingsDrillRow>[] = [
    { header: 'Amount', align: 'right', sortValue: r => r.amount, render: r => <AmountCell value={r.amount} /> },
];

/* ---- Market: grouped by sign of gain (Gains / Losses) ---- */
function marketGroups(rows: MarketDrillRow[]): DrilldownGroup<MarketDrillRow>[] {
    return [
        { key: 'gains', label: 'Gains', rows: byMagnitude(rows.filter(r => r.gain >= 0), r => r.gain) },
        { key: 'losses', label: 'Losses', rows: byMagnitude(rows.filter(r => r.gain < 0), r => r.gain) },
    ];
}
const marketColumns: DrilldownColumn<MarketDrillRow>[] = [
    { header: 'Start value', align: 'right', sortValue: r => r.startValue, render: r => formatFullCurrency(r.startValue) },
    { header: 'End value', align: 'right', sortValue: r => r.endValue, render: r => formatFullCurrency(r.endValue) },
    { header: 'Net invested', align: 'right', sortValue: r => r.netInvested, render: r => <AmountCell value={r.netInvested} /> },
    { header: 'Gain', align: 'right', sortValue: r => r.gain, render: r => <AmountCell value={r.gain} /> },
];

/* ---- Debt: grouped by sign of change (Paydown / Borrowing) ---- */
function debtGroups(rows: DebtDrillRow[]): DrilldownGroup<DebtDrillRow>[] {
    return [
        { key: 'paydown', label: 'Paydown', rows: byMagnitude(rows.filter(r => r.change >= 0), r => r.change) },
        { key: 'borrowing', label: 'Borrowing', rows: byMagnitude(rows.filter(r => r.change < 0), r => r.change) },
    ];
}
const debtColumns: DrilldownColumn<DebtDrillRow>[] = [
    { header: 'Start balance', align: 'right', sortValue: r => r.startBalance, render: r => formatFullCurrency(r.startBalance) },
    { header: 'End balance', align: 'right', sortValue: r => r.endBalance, render: r => formatFullCurrency(r.endBalance) },
    { header: 'Change', align: 'right', sortValue: r => r.change, render: r => <AmountCell value={r.change} /> },
];

/* ---- Other: grouped by sign (Inflows / Outflows) ---- */
function otherGroups(rows: OtherDrillRow[]): DrilldownGroup<OtherDrillRow>[] {
    return [
        { key: 'inflows', label: 'Inflows', rows: byMagnitude(rows.filter(r => r.amount >= 0), r => r.amount) },
        { key: 'outflows', label: 'Outflows', rows: byMagnitude(rows.filter(r => r.amount < 0), r => r.amount) },
    ];
}
const otherColumns: DrilldownColumn<OtherDrillRow>[] = [
    { header: 'Amount', align: 'right', sortValue: r => r.amount, render: r => <AmountCell value={r.amount} /> },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function NetWorthAttributionPage() {
    const [filters, setFilters] = useState<ReportFilters>(() => ({
        ...presetRange('year'),
    }));
    const [reportData, setReportData] = useState<NetWorthAttributionData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/net-worth-attribution?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: NetWorthAttributionData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const activePreset = useMemo<PresetKey | null>(() => {
        const presets: PresetKey[] = ['month', 'quarter', 'year', 'lastYear'];
        for (const p of presets) {
            const range = presetRange(p);
            if (filters.startDate === range.startDate && filters.endDate === range.endDate) {
                return p;
            }
        }
        return null;
    }, [filters]);

    const presetButtons: Array<{ key: PresetKey; label: string }> = [
        { key: 'month', label: 'This month' },
        { key: 'quarter', label: 'This quarter' },
        { key: 'year', label: 'This year' },
        { key: 'lastYear', label: 'Last year' },
    ];

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Net-Worth Attribution"
                description="Where the change in net worth came from: savings, markets, debt paydown, and the rest"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {/* Period presets */}
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-background-tertiary/30">
                    <div className="inline-flex rounded-lg border border-border overflow-hidden">
                        {presetButtons.map(p => (
                            <button
                                key={p.key}
                                onClick={() => setFilters(f => ({ ...f, ...presetRange(p.key) }))}
                                className={`px-3 py-1.5 text-xs transition-colors ${
                                    activePreset === p.key
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-surface text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <span className="text-xs text-foreground-muted md:ml-auto">
                        Components sum exactly to the net-worth change; rounding lands in “other”
                    </span>
                </div>

                {reportData && (
                    <>
                        <WaterfallSummary data={reportData} />
                        <MonthlyChart data={reportData} />

                        <ReportDrilldownTable
                            title="Savings — income, spending, and debt service"
                            nameHeader="Account"
                            columns={savingsColumns}
                            groups={savingsGroups(reportData.drilldown.savings)}
                            getAccount={r => ({ guid: r.guid, name: r.name })}
                            dateRange={{ startDate: reportData.startDate, endDate: reportData.endDate }}
                            emptyText="No income or expense flows in this period."
                        />
                        <ReportDrilldownTable
                            title="Market gains/losses — per holding"
                            nameHeader="Holding"
                            columns={marketColumns}
                            groups={marketGroups(reportData.drilldown.market)}
                            getAccount={r => ({ guid: r.accountGuid, name: r.name })}
                            dateRange={{ startDate: reportData.startDate, endDate: reportData.endDate }}
                            emptyText="No priced holdings in this period."
                        />
                        <ReportDrilldownTable
                            title="Debt paydown — per liability"
                            nameHeader="Liability"
                            columns={debtColumns}
                            groups={debtGroups(reportData.drilldown.debt)}
                            getAccount={r => ({ guid: r.accountGuid, name: r.name })}
                            dateRange={{ startDate: reportData.startDate, endDate: reportData.endDate }}
                            emptyText="No liability activity in this period."
                        />
                        <ReportDrilldownTable
                            title="Transfers / equity / other"
                            nameHeader="Source"
                            columns={otherColumns}
                            groups={otherGroups(reportData.drilldown.other)}
                            getAccount={r => ({ guid: r.guid, name: r.name })}
                            dateRange={{ startDate: reportData.startDate, endDate: reportData.endDate }}
                            emptyText="Nothing here — every dollar is explained by the components above."
                        />

                        <p className="px-4 py-3 text-xs text-foreground-muted border-t border-border/50">
                            Savings nets income against spending and includes principal transferred to
                            liabilities as “debt service” (offset by the debt paydown component). Market
                            gains are per-holding valuation changes not explained by purchases or sales.
                            Foreign-currency balances are carried at accumulated book-currency value.
                        </p>
                    </>
                )}
            </ReportViewer>
        </div>
    );
}
