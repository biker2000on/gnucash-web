/**
 * Default-budget selection.
 *
 * Several features need "a budget" without the user picking one (monthly
 * digest, Year in Review, scheduled budget reports). Alphabetical findFirst
 * made ancient budgets ("2014 Budget") the default forever. The universal
 * rule: prefer a budget whose period range covers the reference date, then
 * the most recently ended, then the soonest upcoming.
 */

export interface BudgetRecurrenceLike {
    recurrence_mult: number;
    recurrence_period_type: string;
    /** Date server-side; ISO string once it has crossed a JSON API boundary. */
    recurrence_period_start: Date | string;
}

export interface BudgetLike {
    guid: string;
    num_periods: number;
    /** Used to infer a start year when no recurrence row exists. */
    name?: string;
    recurrences?: BudgetRecurrenceLike[] | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Infer a budget's start from a 4-digit year in its name ("2026 Annual
 * Budget" → Jan 1 2026). Fallback for budgets without a recurrence row
 * (old XML imports, hand-created rows) so sorting and current-budget
 * selection still behave sensibly. Returns null when no year is present.
 */
export function inferStartFromName(name: string | undefined | null): Date | null {
    const year = name?.match(/\b(19|20)\d{2}\b/)?.[0];
    return year ? new Date(Date.UTC(parseInt(year, 10), 0, 1)) : null;
}

function addMonthsUtc(date: Date, months: number): Date {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

/**
 * The [start, end) range a budget covers. Without a recurrence row, falls
 * back to a year in the budget's name (assumed monthly from Jan 1); null
 * when neither is available.
 */
export function budgetRange(budget: BudgetLike): { start: Date; end: Date } | null {
    const rec = budget.recurrences?.[0];
    if (!rec || !rec.recurrence_period_start) {
        const inferred = inferStartFromName(budget.name);
        if (!inferred) return null;
        return { start: inferred, end: addMonthsUtc(inferred, Math.max(1, budget.num_periods || 1)) };
    }
    const start = new Date(rec.recurrence_period_start);
    const mult = Math.max(1, rec.recurrence_mult || 1);
    const periods = Math.max(1, budget.num_periods || 1);
    const type = (rec.recurrence_period_type || 'month').toLowerCase();

    let end: Date;
    switch (type) {
        case 'day':
            end = new Date(start.getTime() + periods * mult * DAY_MS);
            break;
        case 'week':
            end = new Date(start.getTime() + periods * mult * 7 * DAY_MS);
            break;
        case 'year':
        case 'end of year':
            end = addMonthsUtc(start, periods * mult * 12);
            break;
        case 'month':
        case 'end of month':
        case 'nth weekday':
        case 'last weekday':
        default:
            end = addMonthsUtc(start, periods * mult);
            break;
    }
    return { start, end };
}

/** True when the budget's range covers the given date. */
export function budgetCovers(budget: BudgetLike, date: Date): boolean {
    const range = budgetRange(budget);
    if (!range) return false;
    return date >= range.start && date < range.end;
}

/**
 * Pick the best default budget for a reference date:
 * 1. a budget covering the date (latest start wins when several do),
 * 2. else the most recently ended,
 * 3. else the soonest upcoming,
 * 4. else (no recurrences at all) the first as given.
 */
export function pickCurrentBudget<T extends BudgetLike>(budgets: T[], now: Date = new Date()): T | null {
    if (budgets.length === 0) return null;

    const withRange = budgets
        .map(b => ({ budget: b, range: budgetRange(b) }))
        .filter((x): x is { budget: T; range: { start: Date; end: Date } } => x.range !== null);

    const covering = withRange.filter(x => now >= x.range.start && now < x.range.end);
    if (covering.length > 0) {
        covering.sort((a, b) => b.range.start.getTime() - a.range.start.getTime());
        return covering[0].budget;
    }

    const past = withRange.filter(x => x.range.end <= now);
    if (past.length > 0) {
        past.sort((a, b) => b.range.end.getTime() - a.range.end.getTime());
        return past[0].budget;
    }

    const future = withRange.filter(x => x.range.start > now);
    if (future.length > 0) {
        future.sort((a, b) => a.range.start.getTime() - b.range.start.getTime());
        return future[0].budget;
    }

    return budgets[0];
}
