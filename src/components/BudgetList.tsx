'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { FilterBar } from '@/components/ui/FilterBar';
import { formatCurrency } from '@/lib/format';
import type { BudgetActualsSummary } from '@/lib/budget-actuals';
import {
    type BudgetListItem,
    type BudgetSortKey,
    type BudgetStatusFilter,
    type SortDir,
    type SummaryState,
    DEFAULT_SORT_DIR,
    classifyBudget,
    filterBudgets,
    getPeriodLabel,
    sortBudgets,
} from '@/lib/budget-list-utils';

interface BudgetListProps {
    budgets: BudgetListItem[];
    onEdit?: (budget: BudgetListItem) => void;
    onDelete?: (budget: BudgetListItem) => void;
    /** Open the "Duplicate as scenario" modal pre-seeded with this budget. */
    onScenario?: (budget: BudgetListItem) => void;
}

const STATUS_FILTERS: { value: BudgetStatusFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'past', label: 'Past' },
    { value: 'no-amounts', label: 'No amounts' },
];

const SORT_OPTIONS: { value: BudgetSortKey; label: string }[] = [
    { value: 'name', label: 'Name' },
    { value: 'period', label: 'Period type' },
    { value: 'numPeriods', label: 'Periods' },
    { value: 'allocations', label: 'Allocations' },
    { value: 'budgeted', label: 'Budgeted' },
    { value: 'spent', label: 'Spent' },
    { value: 'pctUsed', label: '% used' },
];

/** Fixed-footprint shimmer so summary loading never shifts the layout. */
function ProgressShimmer() {
    return (
        <div className="w-full max-w-[220px]">
            <div className="h-1.5 rounded-sm bg-background-tertiary animate-pulse" />
            <div className="mt-1.5 h-3 w-24 rounded bg-background-tertiary animate-pulse" />
        </div>
    );
}

/** Compact current-period budget bar with pace marker (matches BudgetProgress). */
function CompactProgress({ summary }: { summary: SummaryState }) {
    if (summary === undefined) return <ProgressShimmer />;
    if (!summary || !summary.spend || summary.currentPeriod === null) {
        return <span className="text-xs text-foreground-muted">&mdash;</span>;
    }
    const s = summary.spend;
    const fill = s.pctUsed === null ? 0 : Math.min(100, Math.max(0, s.pctUsed));
    const barColor = s.status === 'over' ? 'bg-negative' : s.status === 'warning' ? 'bg-warning' : 'bg-primary';
    return (
        <div className="w-full max-w-[220px]">
            <div className="relative h-1.5 rounded-sm bg-background-tertiary overflow-hidden">
                <div
                    className={`absolute inset-y-0 left-0 rounded-sm ${barColor} transition-[width] duration-150 ease-out`}
                    style={{ width: `${fill}%` }}
                />
                {summary.elapsedFraction !== null && summary.elapsedFraction > 0 && summary.elapsedFraction < 1 && (
                    <div
                        className="absolute inset-y-0 w-px bg-foreground-muted"
                        style={{ left: `${summary.elapsedFraction * 100}%` }}
                        title={`${Math.round(summary.elapsedFraction * 100)}% of period elapsed`}
                    />
                )}
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-foreground-muted whitespace-nowrap">
                {s.pctUsed !== null ? `${s.pctUsed.toFixed(0)}% used` : 'no budget'}
                {summary.periodLabel && <span> &middot; {summary.periodLabel}</span>}
            </div>
        </div>
    );
}

/** Right-aligned mono currency cell fed by the summary; shimmer while loading. */
function AmountCell({ summary, field }: { summary: SummaryState; field: 'budgeted' | 'actual' }) {
    if (summary === undefined) {
        return <div className="ml-auto h-3.5 w-16 rounded bg-background-tertiary animate-pulse" />;
    }
    if (!summary?.spend) return <span className="text-foreground-muted">&mdash;</span>;
    return <>{formatCurrency(summary.spend[field], summary.currency)}</>;
}

function SortHeader({
    label,
    column,
    sortKey,
    sortDir,
    onSort,
    align = 'left',
    className = '',
    title,
}: {
    label: string;
    column: BudgetSortKey;
    sortKey: BudgetSortKey;
    sortDir: SortDir;
    onSort: (key: BudgetSortKey) => void;
    align?: 'left' | 'right';
    className?: string;
    title?: string;
}) {
    const active = sortKey === column;
    return (
        <th
            aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
            className={`px-4 py-3 font-semibold ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
        >
            <button
                onClick={() => onSort(column)}
                title={title}
                className={`inline-flex items-center gap-1 uppercase tracking-widest text-xs transition-colors ${
                    active ? 'text-foreground' : 'hover:text-foreground'
                }`}
            >
                {align === 'right' && <span className="w-3 text-primary">{active ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>}
                {label}
                {align === 'left' && <span className="w-3 text-primary">{active ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>}
            </button>
        </th>
    );
}

export function BudgetList({ budgets, onEdit, onDelete, onScenario }: BudgetListProps) {
    const router = useRouter();
    const isMobile = useIsMobile();
    const searchRef = useRef<HTMLInputElement>(null);

    // Per-budget current-period summaries; keyed presence marks "resolved"
    // (null = failed) so rows shimmer only until their own fetch settles.
    const [summaries, setSummaries] = useState<Record<string, BudgetActualsSummary | null>>({});
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<BudgetStatusFilter>('all');
    const [sortKey, setSortKey] = useState<BudgetSortKey>('name');
    const [sortDir, setSortDir] = useState<SortDir>('asc');

    useEffect(() => {
        let cancelled = false;
        const targets = budgets.filter(b => (b._count?.amounts ?? 0) > 0);
        if (targets.length === 0) return;
        (async () => {
            const entries = await Promise.all(
                targets.map(async budget => {
                    try {
                        const res = await fetch(`/api/budgets/${budget.guid}/actuals?summary=1`);
                        if (!res.ok) return [budget.guid, null] as const;
                        return [budget.guid, (await res.json()) as BudgetActualsSummary] as const;
                    } catch {
                        return [budget.guid, null] as const;
                    }
                })
            );
            if (cancelled) return;
            // Merge instead of replace: keeps cached rows stable across list refreshes.
            setSummaries(prev => {
                const next = { ...prev };
                for (const [guid, summary] of entries) next[guid] = summary;
                return next;
            });
        })();
        return () => { cancelled = true; };
    }, [budgets]);

    const handleSort = useCallback((key: BudgetSortKey) => {
        if (key === sortKey) {
            setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir(DEFAULT_SORT_DIR[key]);
        }
    }, [sortKey]);

    useKeyboardShortcut(
        'budget-list-search',
        '/',
        'Focus budget filter',
        () => searchRef.current?.focus(),
        'page'
    );

    const statusCounts = useMemo(() => {
        const counts: Record<BudgetStatusFilter, number> = { all: budgets.length, active: 0, past: 0, 'no-amounts': 0 };
        for (const b of budgets) {
            const status = classifyBudget(b, summaries[b.guid]);
            if (status !== 'unknown') counts[status] += 1;
        }
        return counts;
    }, [budgets, summaries]);

    const visible = useMemo(
        () => sortBudgets(filterBudgets(budgets, query, statusFilter, summaries), sortKey, sortDir, summaries),
        [budgets, query, statusFilter, summaries, sortKey, sortDir]
    );

    const menuItemsFor = useCallback((budget: BudgetListItem): ActionMenuItem[] => {
        const items: ActionMenuItem[] = [
            { label: 'Open', onSelect: () => router.push(`/budgets/${budget.guid}`) },
        ];
        if (onEdit) items.push({ label: 'Edit…', onSelect: () => onEdit(budget) });
        if (onScenario) items.push({ label: 'Duplicate as scenario…', onSelect: () => onScenario(budget) });
        items.push({ label: 'Compare…', onSelect: () => router.push(`/budgets/compare?a=${budget.guid}`) });
        if (onDelete) items.push({ label: 'Delete…', onSelect: () => onDelete(budget), destructive: true });
        return items;
    }, [router, onEdit, onScenario, onDelete]);

    if (budgets.length === 0) {
        return (
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 text-center">
                <svg className="w-16 h-16 mx-auto text-foreground-muted mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <h3 className="text-lg font-medium text-foreground-secondary mb-2">No Budgets Yet</h3>
                <p className="text-foreground-muted">
                    Create your first budget to start tracking your financial goals.
                </p>
            </div>
        );
    }

    const activeFilterCount = statusFilter !== 'all' ? 1 : 0;

    const toolbar = (
        <div className="px-4 py-2.5 border-b border-border">
            <FilterBar
                activeCount={activeFilterCount}
                primary={
                    <div className="relative w-full md:w-64">
                        <input
                            ref={searchRef}
                            type="text"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Escape') {
                                    if (query) setQuery('');
                                    else e.currentTarget.blur();
                                }
                            }}
                            placeholder="Filter budgets…"
                            aria-label="Filter budgets"
                            className="w-full pl-3 pr-8 py-1.5 bg-background-tertiary border border-border rounded-lg text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary/50 transition-colors"
                        />
                        <kbd className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 items-center px-1.5 py-0.5 rounded border border-border bg-surface text-[10px] font-mono text-foreground-muted pointer-events-none">
                            /
                        </kbd>
                    </div>
                }
            >
                <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter by status">
                    {STATUS_FILTERS.map(f => (
                        <button
                            key={f.value}
                            onClick={() => setStatusFilter(f.value)}
                            aria-pressed={statusFilter === f.value}
                            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                                statusFilter === f.value
                                    ? 'border-primary/60 bg-primary-light text-primary'
                                    : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                            }`}
                        >
                            {f.label}
                            <span className={`ml-1 font-mono tabular-nums ${statusFilter === f.value ? 'text-primary/70' : 'text-foreground-muted'}`}>
                                {statusCounts[f.value]}
                            </span>
                        </button>
                    ))}
                </div>
                {/* Sort controls for the card view; the table sorts via its headers. */}
                <div className="flex items-center gap-1.5 md:hidden">
                    <label htmlFor="budget-sort" className="text-xs text-foreground-muted uppercase tracking-wider">Sort</label>
                    <select
                        id="budget-sort"
                        value={sortKey}
                        onChange={e => {
                            const key = e.target.value as BudgetSortKey;
                            setSortKey(key);
                            setSortDir(DEFAULT_SORT_DIR[key]);
                        }}
                        className="flex-1 px-2 py-1.5 bg-background-tertiary border border-border rounded-lg text-sm text-foreground"
                    >
                        {SORT_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                    <button
                        onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                        aria-label={sortDir === 'asc' ? 'Sorted ascending' : 'Sorted descending'}
                        className="px-2.5 py-1.5 rounded-lg border border-border text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        {sortDir === 'asc' ? '↑' : '↓'}
                    </button>
                </div>
            </FilterBar>
        </div>
    );

    const emptyFiltered = (
        <div className="p-8 text-center">
            <p className="text-sm text-foreground-muted">No budgets match the current filters.</p>
            <button
                onClick={() => { setQuery(''); setStatusFilter('all'); }}
                className="mt-2 text-sm text-primary hover:text-primary-hover transition-colors"
            >
                Clear filters
            </button>
        </div>
    );

    if (isMobile) {
        return (
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl">
                {toolbar}
                {visible.length === 0 ? emptyFiltered : (
                    <div className="divide-y divide-border">
                        {visible.map(budget => {
                            const summary = summaries[budget.guid];
                            const resolved = (budget._count?.amounts ?? 0) > 0 ? summary : null;
                            return (
                                <div key={budget.guid} className="p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <Link
                                                href={`/budgets/${budget.guid}`}
                                                className="block text-sm font-medium text-foreground hover:text-primary transition-colors truncate"
                                            >
                                                {budget.name}
                                            </Link>
                                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary border border-primary/20">
                                                    {getPeriodLabel(budget.num_periods)}
                                                </span>
                                                <span className="text-xs text-foreground-muted font-mono tabular-nums">
                                                    {budget.num_periods}p &middot; {budget._count?.amounts ?? 0} alloc
                                                </span>
                                            </div>
                                        </div>
                                        <ActionMenu items={menuItemsFor(budget)} label={`Actions for ${budget.name}`} className="shrink-0" />
                                    </div>
                                    <div className="mt-3">
                                        {(budget._count?.amounts ?? 0) === 0 ? (
                                            <span className="text-xs text-foreground-muted">No amounts yet</span>
                                        ) : resolved === undefined ? (
                                            <ProgressShimmer />
                                        ) : !resolved?.spend || resolved.currentPeriod === null ? (
                                            <span className="text-xs text-foreground-muted">Outside budget range</span>
                                        ) : (
                                            <>
                                                <div className="relative h-1.5 rounded-sm bg-background-tertiary overflow-hidden">
                                                    <div
                                                        className={`absolute inset-y-0 left-0 rounded-sm ${
                                                            resolved.spend.status === 'over' ? 'bg-negative'
                                                                : resolved.spend.status === 'warning' ? 'bg-warning'
                                                                : 'bg-primary'
                                                        }`}
                                                        style={{ width: `${Math.min(100, Math.max(0, resolved.spend.pctUsed ?? 0))}%` }}
                                                    />
                                                    {resolved.elapsedFraction !== null && resolved.elapsedFraction > 0 && resolved.elapsedFraction < 1 && (
                                                        <div
                                                            className="absolute inset-y-0 w-px bg-foreground-muted"
                                                            style={{ left: `${resolved.elapsedFraction * 100}%` }}
                                                        />
                                                    )}
                                                </div>
                                                <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] font-mono tabular-nums text-foreground-muted">
                                                    <span>
                                                        {formatCurrency(resolved.spend.actual, resolved.currency)} / {formatCurrency(resolved.spend.budgeted, resolved.currency)}
                                                        {resolved.periodLabel && <span> &middot; {resolved.periodLabel}</span>}
                                                    </span>
                                                    {resolved.spend.pctUsed !== null && (
                                                        <span className={
                                                            resolved.spend.status === 'over' ? 'text-negative'
                                                                : resolved.spend.status === 'warning' ? 'text-warning'
                                                                : 'text-foreground-secondary'
                                                        }>
                                                            {resolved.spend.pctUsed.toFixed(0)}%
                                                        </span>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl">
            {toolbar}
            {visible.length === 0 ? emptyFiltered : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-foreground-secondary border-b border-border">
                            <SortHeader label="Name" column="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                            <SortHeader label="Period" column="period" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                            <SortHeader label="Periods" column="numPeriods" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" className="hidden xl:table-cell" />
                            <SortHeader label="Allocations" column="allocations" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" className="hidden lg:table-cell" />
                            <SortHeader label="Budgeted" column="budgeted" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" className="hidden lg:table-cell" title="Current period budgeted" />
                            <SortHeader label="Spent" column="spent" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" title="Current period actual" />
                            <SortHeader label="% Used" column="pctUsed" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="w-[24%] min-w-[170px]" title="Current period progress" />
                            <th className="px-4 py-3 w-12"><span className="sr-only">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {visible.map(budget => {
                            const summary = summaries[budget.guid];
                            const state: SummaryState = (budget._count?.amounts ?? 0) > 0 ? summary : null;
                            return (
                                <tr key={budget.guid} className="hover:bg-white/[0.02] transition-colors">
                                    <td className="px-4 py-2.5">
                                        <Link
                                            href={`/budgets/${budget.guid}`}
                                            className="text-foreground font-medium hover:text-primary transition-colors"
                                        >
                                            {budget.name}
                                        </Link>
                                        {budget.description && (
                                            <div className="text-xs text-foreground-muted truncate max-w-xs">{budget.description}</div>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                                            {getPeriodLabel(budget.num_periods)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground-secondary hidden xl:table-cell">
                                        {budget.num_periods}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground-secondary hidden lg:table-cell">
                                        {budget._count?.amounts ?? 0}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground-secondary hidden lg:table-cell">
                                        <AmountCell summary={state} field="budgeted" />
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground">
                                        <AmountCell summary={state} field="actual" />
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <CompactProgress summary={state} />
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <div className="flex justify-end">
                                            <ActionMenu items={menuItemsFor(budget)} label={`Actions for ${budget.name}`} />
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
