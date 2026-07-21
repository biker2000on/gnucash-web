import { describe, it, expect } from 'vitest';
import type { BudgetActualsSummary } from '@/lib/budget-actuals';
import {
    type BudgetListItem,
    type SummaryState,
    DEFAULT_SORT_DIR,
    budgetStartLabel,
    budgetStartMs,
    classifyBudget,
    filterBudgets,
    getPeriodLabel,
    matchesQuery,
    matchesStatus,
    sortBudgets,
    sortValue,
} from '@/lib/budget-list-utils';

function budget(overrides: Partial<BudgetListItem> & { guid: string; name: string }): BudgetListItem {
    return {
        description: null,
        num_periods: 12,
        _count: { amounts: 24 },
        ...overrides,
    };
}

function summary(overrides: Partial<BudgetActualsSummary> = {}): BudgetActualsSummary {
    return {
        budgetGuid: 'b1',
        currency: 'USD',
        currentPeriod: 6,
        periodLabel: 'Jul 2026',
        elapsedFraction: 0.33,
        spend: {
            periodNum: 6,
            budgeted: 1000,
            actual: 400,
            pctUsed: 40,
            elapsedFraction: 0.33,
            paceRatio: 1.21,
            projected: 1212,
            projectedOver: 212,
            status: 'warning',
        },
        ...overrides,
    };
}

describe('getPeriodLabel', () => {
    it('maps the common cadences', () => {
        expect(getPeriodLabel(1)).toBe('Yearly');
        expect(getPeriodLabel(4)).toBe('Quarterly');
        expect(getPeriodLabel(12)).toBe('Monthly');
    });

    it('falls back to a count for irregular cadences', () => {
        expect(getPeriodLabel(26)).toBe('26 periods');
    });
});

describe('classifyBudget', () => {
    it('classifies budgets without amounts regardless of summary', () => {
        const b = budget({ guid: 'b1', name: 'Empty', _count: { amounts: 0 } });
        expect(classifyBudget(b, summary())).toBe('no-amounts');
        expect(classifyBudget(b, undefined)).toBe('no-amounts');
    });

    it('treats a missing _count as no-amounts', () => {
        const b = budget({ guid: 'b1', name: 'Empty', _count: undefined });
        expect(classifyBudget(b, undefined)).toBe('no-amounts');
    });

    it('is active when today falls inside the budget range (currentPeriod set)', () => {
        const b = budget({ guid: 'b1', name: 'This Year' });
        expect(classifyBudget(b, summary({ currentPeriod: 0 }))).toBe('active');
    });

    it('is past when the range excludes today (currentPeriod null)', () => {
        const b = budget({ guid: 'b1', name: 'Last Year' });
        expect(classifyBudget(b, summary({ currentPeriod: null, periodLabel: null, spend: null }))).toBe('past');
    });

    it('is unknown while the summary is loading or failed', () => {
        const b = budget({ guid: 'b1', name: 'Pending' });
        expect(classifyBudget(b, undefined)).toBe('unknown');
        expect(classifyBudget(b, null)).toBe('unknown');
    });
});

describe('matchesQuery', () => {
    const b = budget({ guid: 'b1', name: 'Household 2026', description: 'Groceries and utilities' });

    it('matches on name, case-insensitive', () => {
        expect(matchesQuery(b, 'household')).toBe(true);
        expect(matchesQuery(b, 'HOUSE')).toBe(true);
    });

    it('matches on description', () => {
        expect(matchesQuery(b, 'utilities')).toBe(true);
    });

    it('ignores surrounding whitespace and empty queries', () => {
        expect(matchesQuery(b, '  2026  ')).toBe(true);
        expect(matchesQuery(b, '')).toBe(true);
        expect(matchesQuery(b, '   ')).toBe(true);
    });

    it('rejects non-matching text', () => {
        expect(matchesQuery(b, 'vacation')).toBe(false);
    });

    it('handles null descriptions', () => {
        expect(matchesQuery(budget({ guid: 'b2', name: 'Plain', description: null }), 'anything')).toBe(false);
    });
});

describe('matchesStatus', () => {
    it('the all pill matches every status including unknown', () => {
        expect(matchesStatus('active', 'all')).toBe(true);
        expect(matchesStatus('past', 'all')).toBe(true);
        expect(matchesStatus('no-amounts', 'all')).toBe(true);
        expect(matchesStatus('unknown', 'all')).toBe(true);
    });

    it('specific pills match only their own status', () => {
        expect(matchesStatus('active', 'active')).toBe(true);
        expect(matchesStatus('past', 'active')).toBe(false);
        expect(matchesStatus('unknown', 'active')).toBe(false);
        expect(matchesStatus('no-amounts', 'no-amounts')).toBe(true);
    });
});

describe('filterBudgets', () => {
    const active = budget({ guid: 'a', name: 'Active Budget' });
    const past = budget({ guid: 'p', name: 'Past Budget' });
    const empty = budget({ guid: 'e', name: 'Empty Budget', _count: { amounts: 0 } });
    const summaries: Record<string, SummaryState> = {
        a: summary({ budgetGuid: 'a', currentPeriod: 3 }),
        p: summary({ budgetGuid: 'p', currentPeriod: null, spend: null }),
    };

    it('combines text and status filters', () => {
        expect(filterBudgets([active, past, empty], '', 'all', summaries).map(b => b.guid)).toEqual(['a', 'p', 'e']);
        expect(filterBudgets([active, past, empty], '', 'active', summaries).map(b => b.guid)).toEqual(['a']);
        expect(filterBudgets([active, past, empty], '', 'past', summaries).map(b => b.guid)).toEqual(['p']);
        expect(filterBudgets([active, past, empty], '', 'no-amounts', summaries).map(b => b.guid)).toEqual(['e']);
        expect(filterBudgets([active, past, empty], 'past', 'all', summaries).map(b => b.guid)).toEqual(['p']);
        expect(filterBudgets([active, past, empty], 'budget', 'active', summaries).map(b => b.guid)).toEqual(['a']);
    });
});

describe('sortValue', () => {
    const b = budget({ guid: 'b1', name: 'B', num_periods: 4, _count: { amounts: 8 } });

    it('reads structural columns off the budget', () => {
        expect(sortValue(b, 'period', undefined)).toBe(4);
        expect(sortValue(b, 'numPeriods', undefined)).toBe(4);
        expect(sortValue(b, 'allocations', undefined)).toBe(8);
        expect(sortValue(budget({ guid: 'x', name: 'X', _count: undefined }), 'allocations', undefined)).toBe(0);
    });

    it('reads summary columns and returns null when unavailable', () => {
        const s = summary();
        expect(sortValue(b, 'budgeted', s)).toBe(1000);
        expect(sortValue(b, 'spent', s)).toBe(400);
        expect(sortValue(b, 'pctUsed', s)).toBe(40);
        expect(sortValue(b, 'budgeted', undefined)).toBeNull();
        expect(sortValue(b, 'spent', null)).toBeNull();
        expect(sortValue(b, 'pctUsed', summary({ spend: null }))).toBeNull();
    });
});

describe('sortBudgets', () => {
    const alpha = budget({ guid: 'a', name: 'alpha', num_periods: 12, _count: { amounts: 5 } });
    const bravo = budget({ guid: 'b', name: 'Bravo', num_periods: 4, _count: { amounts: 20 } });
    const charlie = budget({ guid: 'c', name: 'charlie', num_periods: 1, _count: { amounts: 10 } });

    it('sorts by name case-insensitively in both directions', () => {
        const summaries = {};
        expect(sortBudgets([charlie, alpha, bravo], 'name', 'asc', summaries).map(b => b.name))
            .toEqual(['alpha', 'Bravo', 'charlie']);
        expect(sortBudgets([charlie, alpha, bravo], 'name', 'desc', summaries).map(b => b.name))
            .toEqual(['charlie', 'Bravo', 'alpha']);
    });

    it('does not mutate the input array', () => {
        const input = [charlie, alpha];
        sortBudgets(input, 'name', 'asc', {});
        expect(input.map(b => b.guid)).toEqual(['c', 'a']);
    });

    it('sorts numeric columns in both directions', () => {
        expect(sortBudgets([alpha, bravo, charlie], 'numPeriods', 'asc', {}).map(b => b.guid))
            .toEqual(['c', 'b', 'a']);
        expect(sortBudgets([alpha, bravo, charlie], 'allocations', 'desc', {}).map(b => b.guid))
            .toEqual(['b', 'c', 'a']);
    });

    it('sorts by percent used with missing summaries last in both directions', () => {
        const summaries: Record<string, SummaryState> = {
            a: summary({ budgetGuid: 'a', spend: { ...summary().spend!, pctUsed: 80 } }),
            b: summary({ budgetGuid: 'b', spend: { ...summary().spend!, pctUsed: 20 } }),
            // charlie: still loading (undefined)
        };
        expect(sortBudgets([charlie, alpha, bravo], 'pctUsed', 'desc', summaries).map(b => b.guid))
            .toEqual(['a', 'b', 'c']);
        expect(sortBudgets([charlie, alpha, bravo], 'pctUsed', 'asc', summaries).map(b => b.guid))
            .toEqual(['b', 'a', 'c']);
    });

    it('orders all-null groups by name and breaks value ties by name', () => {
        expect(sortBudgets([charlie, bravo, alpha], 'spent', 'desc', {}).map(b => b.guid))
            .toEqual(['a', 'b', 'c']);
        const tied: Record<string, SummaryState> = {
            a: summary({ budgetGuid: 'a', spend: { ...summary().spend!, actual: 100 } }),
            b: summary({ budgetGuid: 'b', spend: { ...summary().spend!, actual: 100 } }),
        };
        expect(sortBudgets([bravo, alpha], 'spent', 'desc', tied).map(b => b.guid)).toEqual(['a', 'b']);
    });
});

describe('DEFAULT_SORT_DIR', () => {
    it('defaults name/period ascending and value columns descending', () => {
        expect(DEFAULT_SORT_DIR.name).toBe('asc');
        expect(DEFAULT_SORT_DIR.period).toBe('asc');
        expect(DEFAULT_SORT_DIR.pctUsed).toBe('desc');
        expect(DEFAULT_SORT_DIR.spent).toBe('desc');
        expect(DEFAULT_SORT_DIR.budgeted).toBe('desc');
    });

    it('defaults start descending (recent budgets first)', () => {
        expect(DEFAULT_SORT_DIR.start).toBe('desc');
    });
});

describe('start sort (recent budgets first)', () => {
    const withStart = (guid: string, name: string, iso: string | null): BudgetListItem =>
        budget({
            guid,
            name,
            recurrences: iso
                ? [{ recurrence_mult: 1, recurrence_period_type: 'month', recurrence_period_start: iso }]
                : [],
        });

    it('budgetStartMs reads the recurrence and null-guards', () => {
        expect(budgetStartMs(withStart('a', 'A', '2026-01-01T00:00:00.000Z')))
            .toBe(Date.parse('2026-01-01T00:00:00.000Z'));
        expect(budgetStartMs(withStart('b', 'B', null))).toBeNull();
    });

    it('budgetStartMs falls back to a year in the name when no recurrence exists', () => {
        expect(budgetStartMs(withStart('b', '2026 Annual Budget', null)))
            .toBe(Date.UTC(2026, 0, 1));
        expect(budgetStartLabel(withStart('b', '2026 Annual Budget', null))).toBe('Jan 2026');
    });

    it('budgetStartLabel renders "Mon YYYY" and an em-dash without a recurrence', () => {
        expect(budgetStartLabel(withStart('a', 'A', '2026-01-01T00:00:00.000Z'))).toBe('Jan 2026');
        expect(budgetStartLabel(withStart('b', 'B', null))).toBe('—');
    });

    it('sorts start desc with recurrence-less budgets last', () => {
        const b2014 = withStart('2014', '2014 Budget', '2014-01-01T00:00:00.000Z');
        const b2026 = withStart('2026', '2026 Annual', '2026-01-01T00:00:00.000Z');
        const b2025 = withStart('2025', '2025 Budget', '2025-01-01T00:00:00.000Z');
        const noRec = withStart('none', 'No recurrence', null);
        expect(sortBudgets([b2014, noRec, b2026, b2025], 'start', 'desc', {}).map(b => b.guid))
            .toEqual(['2026', '2025', '2014', 'none']);
    });
});
