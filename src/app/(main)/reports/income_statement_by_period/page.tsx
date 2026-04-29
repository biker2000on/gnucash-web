'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import {
    ReportFilters,
    PeriodicReportData,
    PeriodGrouping,
    PeriodicLineItem,
} from '@/lib/reports/types';
import { formatCurrency } from '@/lib/format';
import { TransactionDrilldownModal, DrilldownTarget } from '@/components/reports/TransactionDrilldownModal';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
    };
}

// Flatten hierarchy into a depth-annotated list for rendering
function flatten(items: PeriodicLineItem[], expanded: Set<string>, out: PeriodicLineItem[] = []): PeriodicLineItem[] {
    for (const item of items) {
        out.push(item);
        if (item.children && item.children.length > 0 && expanded.has(item.guid)) {
            flatten(item.children, expanded, out);
        }
    }
    return out;
}

function collectAllGuidsWithChildren(items: PeriodicLineItem[], out: Set<string> = new Set()): Set<string> {
    for (const item of items) {
        if (item.children && item.children.length > 0) {
            out.add(item.guid);
            collectAllGuidsWithChildren(item.children, out);
        }
    }
    return out;
}

/** Collect guids of rows that should be expanded to show all children up to depth `level`. */
function collectGuidsToLevel(items: PeriodicLineItem[], level: number, currentDepth = 0, out: Set<string> = new Set()): Set<string> {
    for (const item of items) {
        if (currentDepth < level && item.children && item.children.length > 0) {
            out.add(item.guid);
            collectGuidsToLevel(item.children, level, currentDepth + 1, out);
        }
    }
    return out;
}

/** Find the deepest depth in the hierarchy (0 = top-level items, 1 = their children, etc.). */
function computeMaxDepth(items: PeriodicLineItem[], currentDepth = 0): number {
    let max = currentDepth;
    for (const item of items) {
        if (item.children && item.children.length > 0) {
            max = Math.max(max, computeMaxDepth(item.children, currentDepth + 1));
        }
    }
    return max;
}

export default function IncomeStatementByPeriodPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [grouping, setGrouping] = useState<PeriodGrouping>('month');
    const [reportData, setReportData] = useState<PeriodicReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [hideZero, setHideZero] = useState(true);
    const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            params.set('grouping', grouping);

            const res = await fetch(`/api/reports/income-statement-by-period?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: PeriodicReportData = await res.json();
            setReportData(data);
            // Default: expand to level 1 (top-level accounts show, their children are collapsed)
            setExpanded(collectGuidsToLevel(data.sections.flatMap(s => s.items), 1));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, grouping]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const toggleRow = (guid: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(guid)) next.delete(guid);
            else next.add(guid);
            return next;
        });
    };

    const expandAll = () => {
        if (!reportData) return;
        setExpanded(collectAllGuidsWithChildren(reportData.sections.flatMap(s => s.items)));
    };
    const collapseAll = () => setExpanded(new Set());
    const expandToLevel = (level: number) => {
        if (!reportData) return;
        setExpanded(collectGuidsToLevel(reportData.sections.flatMap(s => s.items), level));
    };

    const maxDepth = useMemo(() => {
        if (!reportData) return 0;
        return computeMaxDepth(reportData.sections.flatMap(s => s.items));
    }, [reportData]);

    const visibleItemsBySection = useMemo(() => {
        if (!reportData) return [];
        return reportData.sections.map(section => {
            const flat = flatten(section.items, expanded);
            const filtered = hideZero
                ? flat.filter(item => Math.abs(item.total) >= 0.005)
                : flat;
            return { section, rows: filtered };
        });
    }, [reportData, expanded, hideZero]);

    return (
        <ReportViewer
            title="Income Statement by Period"
            description="Income & expenses broken out by month, quarter, or year for side-by-side comparison"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
        >
            {/* Grouping + display controls */}
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-background-tertiary/30">
                <div className="flex items-center gap-2">
                    <label className="text-xs text-foreground-muted uppercase tracking-wider">Grouping</label>
                    <div className="inline-flex rounded-lg border border-border overflow-hidden">
                        {(['month', 'quarter', 'year'] as PeriodGrouping[]).map(g => (
                            <button
                                key={g}
                                onClick={() => setGrouping(g)}
                                className={`px-3 py-1.5 text-xs capitalize transition-colors ${
                                    grouping === g
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-surface text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {g}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex items-center gap-2 ml-4">
                    <label className="inline-flex items-center gap-1.5 text-xs text-foreground-secondary cursor-pointer">
                        <input
                            type="checkbox"
                            checked={hideZero}
                            onChange={e => setHideZero(e.target.checked)}
                            className="w-3.5 h-3.5 rounded border-border-hover bg-background-tertiary text-primary"
                        />
                        Hide zero rows
                    </label>
                </div>

                <div className="flex items-center gap-2 ml-auto">
                    {maxDepth > 0 && (
                        <div className="flex items-center gap-1">
                            <label className="text-xs text-foreground-muted">Level:</label>
                            <select
                                onChange={e => {
                                    const val = e.target.value;
                                    if (val === 'all') expandAll();
                                    else expandToLevel(Number(val));
                                }}
                                defaultValue="1"
                                className="bg-background-tertiary border border-border-hover text-foreground-secondary text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-foreground-muted"
                            >
                                {Array.from({ length: maxDepth + 1 }, (_, i) => (
                                    <option key={i} value={i}>
                                        {i === 0 ? 'None' : i}
                                    </option>
                                ))}
                                <option value="all">All</option>
                            </select>
                        </div>
                    )}
                    <button
                        onClick={expandAll}
                        className="text-xs px-2 py-1 rounded border border-border text-foreground-secondary hover:text-foreground hover:bg-surface-hover"
                    >
                        Expand all
                    </button>
                    <button
                        onClick={collapseAll}
                        className="text-xs px-2 py-1 rounded border border-border text-foreground-secondary hover:text-foreground hover:bg-surface-hover"
                    >
                        Collapse all
                    </button>
                </div>
            </div>

            {reportData && (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-background-tertiary/80 backdrop-blur-sm z-10">
                            <tr className="border-b border-border">
                                <th className="text-left px-4 py-3 text-xs uppercase tracking-wider text-foreground-muted font-medium sticky left-0 bg-background-tertiary/80 min-w-[220px]">
                                    Account
                                </th>
                                {reportData.periods.map(p => (
                                    <th
                                        key={p.label}
                                        className="text-right px-3 py-3 text-xs uppercase tracking-wider text-foreground-muted font-medium whitespace-nowrap"
                                        title={`${p.startDate} → ${p.endDate}`}
                                    >
                                        {p.label}
                                    </th>
                                ))}
                                <th className="text-right px-3 py-3 text-xs uppercase tracking-wider text-foreground-muted font-medium whitespace-nowrap border-l border-border">
                                    Total
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleItemsBySection.map(({ section, rows }, sectionIdx) => (
                                <PeriodicSectionRows
                                    key={section.title}
                                    title={section.title}
                                    rows={rows}
                                    totals={section.totals}
                                    grandTotal={section.grandTotal}
                                    expanded={expanded}
                                    onToggle={toggleRow}
                                    onCellClick={setDrilldown}
                                    periods={reportData.periods}
                                    isLast={sectionIdx === visibleItemsBySection.length - 1}
                                />
                            ))}
                            {/* Net income row */}
                            <tr className="border-t-2 border-border-hover bg-background-tertiary/60 font-bold">
                                <td className="px-4 py-3 text-foreground">Net Income</td>
                                {reportData.netByPeriod.map((v, i) => (
                                    <td
                                        key={i}
                                        className={`text-right px-3 py-3 font-mono ${
                                            v >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                        }`}
                                    >
                                        {formatCurrency(v, 'USD')}
                                    </td>
                                ))}
                                <td
                                    className={`text-right px-3 py-3 font-mono border-l border-border ${
                                        reportData.netTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                    }`}
                                >
                                    {formatCurrency(reportData.netTotal, 'USD')}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}
            <TransactionDrilldownModal
                target={drilldown}
                onClose={() => setDrilldown(null)}
            />
        </ReportViewer>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

interface PeriodicSectionRowsProps {
    title: string;
    rows: PeriodicLineItem[];
    totals: number[];
    grandTotal: number;
    expanded: Set<string>;
    onToggle: (guid: string) => void;
    onCellClick: (target: DrilldownTarget) => void;
    periods: { label: string; startDate: string; endDate: string }[];
    isLast: boolean;
}

function PeriodicSectionRows({
    title,
    rows,
    totals,
    grandTotal,
    expanded,
    onToggle,
    onCellClick,
    periods,
}: PeriodicSectionRowsProps) {
    const totalLabel =
        periods.length > 0
            ? `${periods[0].label} – ${periods[periods.length - 1].label}`
            : 'Total';
    const totalStartDate = periods[0]?.startDate ?? '';
    const totalEndDate = periods[periods.length - 1]?.endDate ?? '';

    return (
        <>
            <tr className="bg-background-tertiary/40">
                <td
                    colSpan={totals.length + 2}
                    className="px-4 py-2 text-xs uppercase tracking-wider text-foreground-secondary font-bold border-t border-border"
                >
                    {title}
                </td>
            </tr>
            {rows.map(row => {
                const hasChildren = !!(row.children && row.children.length > 0);
                const isExpanded = expanded.has(row.guid);
                const depth = row.depth ?? 0;
                return (
                    <tr key={row.guid} className="hover:bg-surface-hover/30 transition-colors border-b border-border/30">
                        <td className="px-4 py-1.5 sticky left-0 bg-background" style={{ paddingLeft: `${16 + depth * 18}px` }}>
                            <div className="flex items-center gap-1.5">
                                {hasChildren ? (
                                    <button
                                        onClick={() => onToggle(row.guid)}
                                        className="w-4 text-foreground-muted hover:text-foreground"
                                        aria-label={isExpanded ? 'Collapse' : 'Expand'}
                                    >
                                        {isExpanded ? '▼' : '▶'}
                                    </button>
                                ) : (
                                    <span className="w-4" />
                                )}
                                <span className="text-foreground">{row.name}</span>
                            </div>
                        </td>
                        {row.amounts.map((v, i) => {
                            const isZero = Math.abs(v) < 0.005;
                            const className = `text-right px-3 py-1.5 font-mono text-xs ${
                                isZero
                                    ? 'text-foreground-muted'
                                    : v >= 0
                                        ? 'text-foreground-secondary'
                                        : 'text-rose-400'
                            }`;
                            if (isZero) {
                                return (
                                    <td key={i} className={className}>
                                        {formatCurrency(v, 'USD')}
                                    </td>
                                );
                            }
                            return (
                                <td key={i} className={`${className} cursor-pointer hover:underline`}>
                                    <button
                                        type="button"
                                        className="w-full text-right hover:underline focus:outline-none focus:underline"
                                        onClick={() =>
                                            onCellClick({
                                                accountGuid: row.guid,
                                                accountName: row.name,
                                                periodLabel: periods[i].label,
                                                startDate: periods[i].startDate,
                                                endDate: periods[i].endDate,
                                            })
                                        }
                                    >
                                        {formatCurrency(v, 'USD')}
                                    </button>
                                </td>
                            );
                        })}
                        {(() => {
                            const v = row.total;
                            const isZero = Math.abs(v) < 0.005;
                            const cls = `text-right px-3 py-1.5 font-mono text-xs text-foreground font-medium border-l border-border`;
                            if (isZero) {
                                return (
                                    <td className={cls}>
                                        {formatCurrency(v, 'USD')}
                                    </td>
                                );
                            }
                            return (
                                <td className={`${cls} cursor-pointer`}>
                                    <button
                                        type="button"
                                        className="w-full text-right hover:underline focus:outline-none focus:underline"
                                        onClick={() =>
                                            onCellClick({
                                                accountGuid: row.guid,
                                                accountName: row.name,
                                                periodLabel: totalLabel,
                                                startDate: totalStartDate,
                                                endDate: totalEndDate,
                                            })
                                        }
                                    >
                                        {formatCurrency(v, 'USD')}
                                    </button>
                                </td>
                            );
                        })()}
                    </tr>
                );
            })}
            {/* Section total */}
            <tr className="bg-background-tertiary/30 border-t border-border font-medium">
                <td className="px-4 py-2 text-foreground sticky left-0 bg-background-tertiary/30">
                    Total {title}
                </td>
                {totals.map((v, i) => (
                    <td key={i} className="text-right px-3 py-2 font-mono text-foreground">
                        {formatCurrency(v, 'USD')}
                    </td>
                ))}
                <td className="text-right px-3 py-2 font-mono text-foreground border-l border-border">
                    {formatCurrency(grandTotal, 'USD')}
                </td>
            </tr>
        </>
    );
}
