'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
    BudgetIncomeStatementData,
    BudgetStatementRow,
    BudgetBarchartSeriesData,
    BarchartScope,
    VarianceCell,
} from '@/lib/reports/budget-statements';
import { escapeCSVField, downloadCSV } from '@/lib/reports/csv-export';
import { formatCurrency } from '@/lib/format';
import { pickCurrentBudget, type BudgetRecurrenceLike } from '@/lib/budget-select';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from 'recharts';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface BudgetListItem {
    guid: string;
    name: string;
    num_periods: number;
    recurrences?: BudgetRecurrenceLike[] | null;
}

type RangeMode = 'all' | 'ytd' | 'single' | 'custom';

function formatPct(pct: number | null): string {
    return pct === null ? '—' : `${pct.toFixed(1)}%`;
}

function formatAxisCurrency(value: number): string {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
    return `$${value.toFixed(0)}`;
}

function generateStatementCSV(data: BudgetIncomeStatementData): string {
    const rows: string[] = ['Section,Account,Budgeted,Actual,Variance,% of Budget'];
    const line = (section: string, name: string, cell: VarianceCell, depth = 0) => [
        escapeCSVField(section),
        escapeCSVField('  '.repeat(depth) + name),
        cell.budgeted.toFixed(2),
        cell.actual.toFixed(2),
        cell.variance.toFixed(2),
        cell.pctOfBudget === null ? '' : cell.pctOfBudget.toFixed(1),
    ].join(',');

    for (const section of [data.income, data.expense]) {
        for (const row of section.rows) {
            rows.push(line(section.title, row.name, row, row.depth));
        }
        rows.push(line(section.title, `Total ${section.title}`, section.total));
        rows.push('');
    }
    rows.push(line('', 'Net Income', data.net));
    return rows.join('\n');
}

interface ChartTooltipProps {
    active?: boolean;
    payload?: Array<{ value: number; dataKey: string; color: string }>;
    label?: string;
}

function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    return (
        <div className="bg-surface-elevated border border-border rounded-md p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-2">{label}</p>
            {payload.map(entry => (
                <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-foreground-secondary capitalize">{entry.dataKey}</span>
                    </span>
                    <span className="font-mono font-medium text-foreground" style={TNUM}>
                        {formatCurrency(entry.value)}
                    </span>
                </div>
            ))}
        </div>
    );
}

function VarianceValue({ cell, currency }: { cell: VarianceCell; currency: string }) {
    return (
        <span className={cell.favorable ? 'text-positive' : 'text-negative'}>
            {formatCurrency(cell.variance, currency)}
        </span>
    );
}

function StatementSection({
    section,
    currency,
}: {
    section: BudgetIncomeStatementData['income'];
    currency: string;
}) {
    const cellBase = 'py-1.5 px-4 text-sm text-right font-mono';
    const renderRow = (row: BudgetStatementRow) => (
        <tr key={row.guid} className="hover:bg-surface-hover/40 transition-colors">
            <td
                className={`py-1.5 px-4 text-sm ${row.isSubtotal ? 'font-semibold text-foreground' : 'text-foreground-secondary'}`}
                style={{ paddingLeft: `${16 + row.depth * 20}px` }}
            >
                {row.name}
            </td>
            <td className={`${cellBase} text-foreground-secondary ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                {formatCurrency(row.budgeted, currency)}
            </td>
            <td className={`${cellBase} text-foreground ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                {formatCurrency(row.actual, currency)}
            </td>
            <td className={`${cellBase} ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                <VarianceValue cell={row} currency={currency} />
            </td>
            <td className={`${cellBase} text-foreground-secondary ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                {formatPct(row.pctOfBudget)}
            </td>
        </tr>
    );

    return (
        <div className="mb-6">
            <div className="bg-background-tertiary py-2.5 px-4 border-b border-border-hover">
                <h3 className="text-base font-semibold text-foreground">{section.title}</h3>
            </div>
            <table className="w-full">
                <thead>
                    <tr className="border-b border-border-hover text-foreground-secondary text-xs uppercase tracking-wider">
                        <th className="py-2 px-4 text-left font-medium">Account</th>
                        <th className="py-2 px-4 text-right font-medium">Budgeted</th>
                        <th className="py-2 px-4 text-right font-medium">Actual</th>
                        <th className="py-2 px-4 text-right font-medium">Variance</th>
                        <th className="py-2 px-4 text-right font-medium">% of Budget</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                    {section.rows.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="py-4 px-4 text-center text-sm text-foreground-muted">
                                No budgeted {section.title.toLowerCase()} accounts in the selected periods.
                            </td>
                        </tr>
                    ) : (
                        section.rows.map(renderRow)
                    )}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-border-hover bg-background-tertiary">
                        <td className="py-2.5 px-4 font-semibold text-foreground">Total {section.title}</td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                            {formatCurrency(section.total.budgeted, currency)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                            {formatCurrency(section.total.actual, currency)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold" style={TNUM}>
                            <VarianceValue cell={section.total} currency={currency} />
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                            {formatPct(section.total.pctOfBudget)}
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

export default function BudgetIncomeStatementPage() {
    const [budgets, setBudgets] = useState<BudgetListItem[] | null>(null);
    const [selectedBudgetGuid, setSelectedBudgetGuid] = useState<string | null>(null);
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [periodStart, setPeriodStart] = useState<number>(0);
    const [periodEnd, setPeriodEnd] = useState<number>(0);
    const [chartScope, setChartScope] = useState<BarchartScope>('expense');

    const [reportData, setReportData] = useState<BudgetIncomeStatementData | null>(null);
    const [series, setSeries] = useState<BudgetBarchartSeriesData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Load budgets; auto-select the first.
    useEffect(() => {
        fetch('/api/budgets')
            .then(res => {
                if (!res.ok) throw new Error('Failed to load budgets');
                return res.json();
            })
            .then((list: BudgetListItem[]) => {
                setBudgets(list);
                // Default to the budget covering today (falls back to the most
                // recently ended, then soonest upcoming) — never "2014" just
                // because it sorts first alphabetically.
                setSelectedBudgetGuid(prev => prev ?? pickCurrentBudget(list)?.guid ?? null);
                if (list.length === 0) setIsLoading(false);
            })
            .catch(() => {
                setBudgets([]);
                setIsLoading(false);
                setError('Failed to load budgets');
            });
    }, []);

    // Resolve the selected range mode into inclusive period indices. 'ytd'
    // and 'single' need the period calendar, which comes from the last
    // response's allPeriods (defaulting to the full budget until loaded).
    const rangeParams = useMemo((): { periodStart?: number; periodEnd?: number } => {
        if (rangeMode === 'all') return {};
        const allPeriods = reportData?.allPeriods ?? [];
        if (rangeMode === 'custom') return { periodStart, periodEnd };
        if (allPeriods.length === 0) return {};
        const today = new Date().toISOString().slice(0, 10);
        let current = allPeriods.findIndex(p => today >= p.start && today <= p.end);
        if (current < 0) current = today < allPeriods[0].start ? 0 : allPeriods.length - 1;
        if (rangeMode === 'ytd') return { periodStart: 0, periodEnd: current };
        return { periodStart: periodStart, periodEnd: periodStart }; // single
    }, [rangeMode, periodStart, periodEnd, reportData?.allPeriods]);

    const fetchReport = useCallback(async () => {
        if (!selectedBudgetGuid) return;
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('budget', selectedBudgetGuid);
            if (rangeParams.periodStart !== undefined) params.set('periodStart', String(rangeParams.periodStart));
            if (rangeParams.periodEnd !== undefined) params.set('periodEnd', String(rangeParams.periodEnd));
            const res = await fetch(`/api/reports/budget-income-statement?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            setReportData(await res.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
        // Depend on the resolved primitive range values, not the rangeParams
        // object identity. rangeParams is recomputed from reportData.allPeriods,
        // which fetchReport itself replaces on every call — depending on the
        // object reference creates an infinite fetch→setState→recompute loop.
    }, [selectedBudgetGuid, rangeParams.periodStart, rangeParams.periodEnd]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    // Barchart series for the selected scope + range.
    useEffect(() => {
        if (!selectedBudgetGuid) return;
        const params = new URLSearchParams();
        params.set('budget', selectedBudgetGuid);
        params.set('series', '1');
        params.set('scope', chartScope);
        if (rangeParams.periodStart !== undefined) params.set('periodStart', String(rangeParams.periodStart));
        if (rangeParams.periodEnd !== undefined) params.set('periodEnd', String(rangeParams.periodEnd));
        let cancelled = false;
        fetch(`/api/reports/budget-income-statement?${params}`)
            .then(res => (res.ok ? res.json() : null))
            .then(data => {
                if (!cancelled) setSeries(data);
            })
            .catch(() => {
                if (!cancelled) setSeries(null);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedBudgetGuid, chartScope, rangeParams.periodStart, rangeParams.periodEnd]);

    const handleExportCSV = () => {
        if (reportData) {
            downloadCSV(generateStatementCSV(reportData), 'Budget_Income_Statement.csv');
        }
    };

    const currency = reportData?.currency ?? 'USD';
    const allPeriods = reportData?.allPeriods ?? [];
    const periodSummary = reportData && reportData.periods.length > 0
        ? reportData.periods.length === 1
            ? reportData.periods[0].label
            : `${reportData.periods[0].label} – ${reportData.periods[reportData.periods.length - 1].label}`
        : null;

    const selectClass =
        'bg-input-bg border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50';

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Budget Income Statement</h1>
                <p className="text-foreground-muted mt-1">
                    Budgeted vs actual profit &amp; loss with favorable/unfavorable variances per account
                </p>
            </header>

            {/* Controls */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">Budget</label>
                        {budgets !== null && budgets.length === 0 ? (
                            <p className="text-sm text-foreground-secondary py-2">
                                No budgets found. Create a budget first to use this report.
                            </p>
                        ) : (
                            <select
                                value={selectedBudgetGuid ?? ''}
                                onChange={e => {
                                    setSelectedBudgetGuid(e.target.value || null);
                                    setRangeMode('all');
                                    setPeriodStart(0);
                                    setPeriodEnd(0);
                                }}
                                className={`${selectClass} min-w-52`}
                            >
                                {(budgets ?? []).map(budget => (
                                    <option key={budget.guid} value={budget.guid}>{budget.name}</option>
                                ))}
                            </select>
                        )}
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">Period Range</label>
                        <select
                            value={rangeMode}
                            onChange={e => {
                                const mode = e.target.value as RangeMode;
                                setRangeMode(mode);
                                if (mode === 'custom' && allPeriods.length > 0) {
                                    setPeriodStart(0);
                                    setPeriodEnd(allPeriods.length - 1);
                                }
                            }}
                            className={selectClass}
                        >
                            <option value="all">Full budget</option>
                            <option value="ytd">Year to date</option>
                            <option value="single">Single period</option>
                            <option value="custom">Custom range</option>
                        </select>
                    </div>

                    {rangeMode === 'single' && (
                        <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">Period</label>
                            <select
                                value={periodStart}
                                onChange={e => setPeriodStart(parseInt(e.target.value, 10))}
                                className={selectClass}
                            >
                                {allPeriods.map(p => (
                                    <option key={p.periodNum} value={p.periodNum}>{p.label}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {rangeMode === 'custom' && (
                        <>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">From</label>
                                <select
                                    value={periodStart}
                                    onChange={e => setPeriodStart(parseInt(e.target.value, 10))}
                                    className={selectClass}
                                >
                                    {allPeriods.map(p => (
                                        <option key={p.periodNum} value={p.periodNum}>{p.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">To</label>
                                <select
                                    value={periodEnd}
                                    onChange={e => setPeriodEnd(parseInt(e.target.value, 10))}
                                    className={selectClass}
                                >
                                    {allPeriods.map(p => (
                                        <option key={p.periodNum} value={p.periodNum}>{p.label}</option>
                                    ))}
                                </select>
                            </div>
                        </>
                    )}

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">Chart Scope</label>
                        <select
                            value={chartScope}
                            onChange={e => setChartScope(e.target.value as BarchartScope)}
                            className={selectClass}
                        >
                            <option value="expense">Expenses</option>
                            <option value="income">Income</option>
                            <option value="net">Net income</option>
                        </select>
                    </div>
                </div>
            </div>

            {isLoading ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Generating report...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-negative/40 rounded-xl p-12 text-center">
                    <div className="text-negative">{error}</div>
                </div>
            ) : reportData && (
                <>
                    {/* Grouped barchart: budgeted vs actual per period */}
                    {series && series.points.length > 0 && (
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
                            <div className="flex items-center justify-between mb-2 px-2">
                                <h2 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider">
                                    Budgeted vs Actual — {series.scopeLabel}
                                </h2>
                            </div>
                            <ResponsiveContainer width="100%" height={280}>
                                <BarChart data={series.points} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                    <XAxis
                                        dataKey="label"
                                        stroke="var(--foreground-secondary)"
                                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                        axisLine={{ stroke: 'var(--border)' }}
                                        tickLine={{ stroke: 'var(--border)' }}
                                    />
                                    <YAxis
                                        tickFormatter={formatAxisCurrency}
                                        stroke="var(--foreground-secondary)"
                                        tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                        axisLine={{ stroke: 'var(--border)' }}
                                        tickLine={{ stroke: 'var(--border)' }}
                                        width={70}
                                    />
                                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-hover)', opacity: 0.4 }} />
                                    <Legend
                                        wrapperStyle={{ paddingTop: '12px' }}
                                        formatter={(value: string) => (
                                            <span className="text-foreground-secondary text-sm capitalize">{value}</span>
                                        )}
                                    />
                                    <Bar dataKey="budgeted" fill="var(--secondary)" radius={[3, 3, 0, 0]} maxBarSize={32} />
                                    <Bar dataKey="actual" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={32} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {/* Statement */}
                    <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border text-sm text-foreground-secondary">
                            <span className="font-semibold text-foreground">{reportData.budgetName}</span>
                            {periodSummary && (
                                <span className="text-xs font-mono" style={TNUM}>
                                    {reportData.periods.length} of {reportData.numPeriods} periods · {periodSummary}
                                </span>
                            )}
                        </div>

                        <StatementSection section={reportData.income} currency={currency} />
                        <StatementSection section={reportData.expense} currency={currency} />

                        {/* Net income */}
                        <div className="border-t-2 border-border-hover bg-background-tertiary p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-lg font-bold text-foreground">Net Income</span>
                                <span className="text-sm text-foreground-secondary">
                                    Budgeted{' '}
                                    <span className="font-mono font-semibold text-foreground" style={TNUM}>
                                        {formatCurrency(reportData.net.budgeted, currency)}
                                    </span>
                                    {' '}· Actual{' '}
                                    <span
                                        className={`font-mono font-semibold ${reportData.net.actual >= 0 ? 'text-positive' : 'text-negative'}`}
                                        style={TNUM}
                                    >
                                        {formatCurrency(reportData.net.actual, currency)}
                                    </span>
                                    {' '}· Variance{' '}
                                    <span className="font-mono font-semibold" style={TNUM}>
                                        <VarianceValue cell={reportData.net} currency={currency} />
                                    </span>
                                </span>
                            </div>
                        </div>

                        {/* CSV export */}
                        <div className="border-t border-border p-4 flex justify-end no-print">
                            <button
                                onClick={handleExportCSV}
                                className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Export CSV
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
