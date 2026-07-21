import type { BudgetActualsSummary } from '@/lib/budget-actuals';
import { inferStartFromName } from '@/lib/budget-select';

/** Shape of one row on the /budgets overview (the /api/budgets list payload). */
export interface BudgetListItem {
    guid: string;
    name: string;
    description: string | null;
    num_periods: number;
    /** Raw Prisma recurrence rows; period_start arrives as an ISO string over JSON. */
    recurrences?: Array<{
        recurrence_mult: number;
        recurrence_period_type: string;
        recurrence_period_start: string | Date;
    }> | null;
    _count?: {
        amounts: number;
    };
}

/**
 * Epoch ms of the budget's period 0 start. Prefers the recurrence row;
 * without one (old XML imports), falls back to a year in the budget's name
 * ("2026 Annual Budget" → Jan 2026). Null when neither is available.
 */
export function budgetStartMs(budget: BudgetListItem): number | null {
    const raw = budget.recurrences?.[0]?.recurrence_period_start;
    if (raw) {
        const t = new Date(raw).getTime();
        if (Number.isFinite(t)) return t;
    }
    return inferStartFromName(budget.name)?.getTime() ?? null;
}

/** Short label for the budget's start, e.g. "Jan 2026"; em-dash when unknown. */
export function budgetStartLabel(budget: BudgetListItem): string {
    const ms = budgetStartMs(budget);
    if (ms === null) return '—';
    const d = new Date(ms);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Per-budget summary fetch state:
 * - `undefined` = not resolved yet (loading)
 * - `null`      = resolved but unavailable (fetch failed)
 */
export type SummaryState = BudgetActualsSummary | null | undefined;

export type BudgetStatus = 'active' | 'past' | 'no-amounts' | 'unknown';
export type BudgetStatusFilter = 'all' | 'active' | 'past' | 'no-amounts';

export type BudgetSortKey =
    | 'name'
    | 'start'
    | 'period'
    | 'numPeriods'
    | 'allocations'
    | 'budgeted'
    | 'spent'
    | 'pctUsed';

export type SortDir = 'asc' | 'desc';

/** Sensible first-click direction per column. */
export const DEFAULT_SORT_DIR: Record<BudgetSortKey, SortDir> = {
    name: 'asc',
    start: 'desc', // most recent budget first
    period: 'asc',
    numPeriods: 'desc',
    allocations: 'desc',
    budgeted: 'desc',
    spent: 'desc',
    pctUsed: 'desc',
};

/** Human label for a budget's period cadence, derived from num_periods. */
export function getPeriodLabel(numPeriods: number): string {
    if (numPeriods === 1) return 'Yearly';
    if (numPeriods === 4) return 'Quarterly';
    if (numPeriods === 12) return 'Monthly';
    return `${numPeriods} periods`;
}

/**
 * Classify a budget for the status pills. "Active" means the server-computed
 * current period exists (i.e. today falls inside the budget's date range);
 * "past" means the budget has amounts but today is outside its range. While
 * the summary is still loading (or failed) the status is 'unknown'.
 */
export function classifyBudget(budget: BudgetListItem, summary: SummaryState): BudgetStatus {
    if (!budget._count?.amounts) return 'no-amounts';
    if (summary === undefined || summary === null) return 'unknown';
    return summary.currentPeriod !== null ? 'active' : 'past';
}

/** Case-insensitive text match against budget name and description. */
export function matchesQuery(budget: BudgetListItem, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (budget.name.toLowerCase().includes(q)) return true;
    return (budget.description ?? '').toLowerCase().includes(q);
}

export function matchesStatus(status: BudgetStatus, filter: BudgetStatusFilter): boolean {
    if (filter === 'all') return true;
    return status === filter;
}

/** Apply text query + status pill to the loaded list. Pure; returns a new array. */
export function filterBudgets<T extends BudgetListItem>(
    budgets: T[],
    query: string,
    statusFilter: BudgetStatusFilter,
    summaries: Record<string, SummaryState>
): T[] {
    return budgets.filter(
        b => matchesQuery(b, query) && matchesStatus(classifyBudget(b, summaries[b.guid]), statusFilter)
    );
}

/**
 * Numeric sort value for a column, or null when unavailable. Summary-driven
 * columns (budgeted/spent/% used) are null until the per-budget summary
 * resolves — null always sorts last regardless of direction.
 */
export function sortValue(
    budget: BudgetListItem,
    key: Exclude<BudgetSortKey, 'name'>,
    summary: SummaryState
): number | null {
    switch (key) {
        case 'start':
            return budgetStartMs(budget);
        case 'period':
        case 'numPeriods':
            return budget.num_periods;
        case 'allocations':
            return budget._count?.amounts ?? 0;
        case 'budgeted':
            return summary?.spend?.budgeted ?? null;
        case 'spent':
            return summary?.spend?.actual ?? null;
        case 'pctUsed':
            return summary?.spend?.pctUsed ?? null;
    }
}

/**
 * Sort a copy of the list. Name sorts alphabetically; numeric columns sort by
 * value with nulls (missing summaries) always last; ties fall back to name
 * ascending so the order is stable and predictable.
 */
export function sortBudgets<T extends BudgetListItem>(
    budgets: T[],
    key: BudgetSortKey,
    dir: SortDir,
    summaries: Record<string, SummaryState>
): T[] {
    const mult = dir === 'asc' ? 1 : -1;
    const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

    return [...budgets].sort((a, b) => {
        if (key === 'name') {
            return mult * byName(a, b) || mult * a.name.localeCompare(b.name);
        }
        const av = sortValue(a, key, summaries[a.guid]);
        const bv = sortValue(b, key, summaries[b.guid]);
        if (av === null && bv === null) return byName(a, b);
        if (av === null) return 1; // nulls last in both directions
        if (bv === null) return -1;
        if (av !== bv) return mult * (av - bv);
        return byName(a, b);
    });
}
