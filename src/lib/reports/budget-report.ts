import { loadBudgetActuals } from '@/lib/budget-actuals';
import { ReportType, ReportData, ReportFilters, ReportSection } from './types';

/**
 * Budget Report — GnuCash-desktop-style budgeted vs actual per account.
 *
 * All amounts come from `loadBudgetActuals` (src/lib/budget-actuals.ts) and
 * are therefore already SIGN-CORRECTED: income reads positive-earned, expense
 * reads positive-spent. This module never re-derives actuals — it only
 * selects periods and rolls the loader's per-period numbers up into report
 * rows.
 *
 * Column semantics (uniform across every row, subtotal, and the net row):
 *   difference = budgeted − actual  (positive = under budget / income short)
 *   % used     = actual / budgeted × 100, null when budgeted is 0
 *
 * The optional date-range filter selects budget PERIODS: a period is included
 * when its calendar range overlaps [startDate, endDate]. No dates = all
 * periods.
 *
 * Net row = Income subtotal − Expenses subtotal (the "Other" group — budgeted
 * transfer targets such as asset/liability accounts — is excluded from net).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BudgetReportPeriod {
    periodNum: number;
    /** YYYY-MM-DD inclusive */
    start: string;
    /** YYYY-MM-DD inclusive */
    end: string;
    label: string;
}

export interface BudgetReportRow {
    guid: string;
    name: string;
    budgeted: number;
    actual: number;
    /** budgeted - actual */
    difference: number;
    /** actual / budgeted * 100; null when budgeted is 0 */
    pctUsed: number | null;
}

export type BudgetGroupKey = 'income' | 'expense' | 'other';

export interface BudgetReportGroup {
    key: BudgetGroupKey;
    title: string;
    rows: BudgetReportRow[];
    subtotal: BudgetReportRow;
}

export interface BudgetReportData extends ReportData {
    budgetGuid: string;
    budgetName: string;
    currency: string;
    /** Total number of periods the budget defines */
    numPeriods: number;
    /** The periods included in this report (after date-range selection) */
    periods: BudgetReportPeriod[];
    groups: BudgetReportGroup[];
    /** Income subtotal − Expenses subtotal ("Other" excluded) */
    net: BudgetReportRow;
}

/** Per-account input for the pure builder: per-period matrices, sign-corrected. */
export interface BudgetReportAccountInput {
    guid: string;
    name: string;
    /** GnuCash account type (INCOME, EXPENSE, ...) */
    type: string;
    /** Budgeted amount per period (index = periodNum) */
    budgeted: number[];
    /** Actual amount per period (index = periodNum) */
    actual: number[];
}

/* ------------------------------------------------------------------ */
/* Pure aggregation (exported for unit tests)                          */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
};

export function pctUsedOf(actual: number, budgeted: number): number | null {
    return budgeted !== 0 ? round2((actual / budgeted) * 100) : null;
}

/**
 * Select the budget period numbers whose calendar range overlaps the
 * optional [startDate, endDate] filter (both YYYY-MM-DD, inclusive).
 * Null/undefined bounds are open-ended; no bounds = every period.
 */
export function selectPeriodNums(
    periods: ReadonlyArray<{ periodNum: number; start: string; end: string }>,
    startDate?: string | null,
    endDate?: string | null,
): number[] {
    return periods
        .filter(p => (!startDate || p.end >= startDate) && (!endDate || p.start <= endDate))
        .map(p => p.periodNum);
}

function makeRow(guid: string, name: string, budgeted: number, actual: number): BudgetReportRow {
    const b = round2(budgeted);
    const a = round2(actual);
    return {
        guid,
        name,
        budgeted: b,
        actual: a,
        difference: round2(b - a),
        pctUsed: pctUsedOf(a, b),
    };
}

const GROUP_TITLES: Record<BudgetGroupKey, string> = {
    income: 'Income',
    expense: 'Expenses',
    other: 'Other',
};

function groupKeyFor(accountType: string): BudgetGroupKey {
    if (accountType === 'INCOME') return 'income';
    if (accountType === 'EXPENSE') return 'expense';
    return 'other';
}

/**
 * Roll per-period budget/actual matrices up over the selected periods and
 * group into Income / Expenses / Other with subtotals plus a net row.
 * Pure. Empty groups are omitted; net = income − expenses regardless.
 */
export function buildBudgetReportGroups(
    accounts: ReadonlyArray<BudgetReportAccountInput>,
    periodNums: ReadonlyArray<number>,
): { groups: BudgetReportGroup[]; net: BudgetReportRow } {
    const sumPeriods = (values: number[]): number =>
        periodNums.reduce((s, p) => s + (values[p] || 0), 0);

    const rowsByGroup: Record<BudgetGroupKey, BudgetReportRow[]> = {
        income: [],
        expense: [],
        other: [],
    };

    for (const account of accounts) {
        rowsByGroup[groupKeyFor(account.type)].push(
            makeRow(account.guid, account.name, sumPeriods(account.budgeted), sumPeriods(account.actual))
        );
    }

    const groups: BudgetReportGroup[] = [];
    const subtotals: Record<BudgetGroupKey, BudgetReportRow> = {} as Record<BudgetGroupKey, BudgetReportRow>;

    for (const key of ['income', 'expense', 'other'] as const) {
        const rows = rowsByGroup[key];
        rows.sort((a, b) => a.name.localeCompare(b.name));
        const subtotal = makeRow(
            `subtotal-${key}`,
            `Total ${GROUP_TITLES[key]}`,
            rows.reduce((s, r) => s + r.budgeted, 0),
            rows.reduce((s, r) => s + r.actual, 0),
        );
        subtotals[key] = subtotal;
        if (rows.length > 0) {
            groups.push({ key, title: GROUP_TITLES[key], rows, subtotal });
        }
    }

    const net = makeRow(
        'net',
        'Net (Income − Expenses)',
        subtotals.income.budgeted - subtotals.expense.budgeted,
        subtotals.income.actual - subtotals.expense.actual,
    );

    return { groups, net };
}

/**
 * ReportData-compatible sections projection so the generic single-amount CSV
 * export (`generateCSV`) works: item amount = ACTUAL, section total = actual
 * subtotal. The full multi-column export lives on the report page.
 */
export function buildBudgetReportSections(groups: BudgetReportGroup[]): ReportSection[] {
    return groups.map(group => ({
        title: group.title,
        items: group.rows.map(row => ({ guid: row.guid, name: row.name, amount: row.actual })),
        total: group.subtotal.actual,
    }));
}

/* ------------------------------------------------------------------ */
/* DB-bound generator                                                  */
/* ------------------------------------------------------------------ */

/**
 * Generate the Budget Report for one budget. Actuals, sign correction, and
 * book scoping all come from `loadBudgetActuals`. Returns null when the
 * budget does not exist.
 */
export async function generateBudgetReport(
    budgetGuid: string,
    filters: ReportFilters,
): Promise<BudgetReportData | null> {
    const actuals = await loadBudgetActuals(budgetGuid);
    if (!actuals) return null;

    const periodNums = selectPeriodNums(actuals.periods, filters.startDate, filters.endDate);
    const selected = new Set(periodNums);

    const accounts: BudgetReportAccountInput[] = actuals.accounts.map(account => ({
        guid: account.guid,
        name: account.name,
        type: account.type,
        budgeted: account.periods.map(p => p.budgeted),
        actual: account.periods.map(p => p.actual),
    }));

    const { groups, net } = buildBudgetReportGroups(accounts, periodNums);

    return {
        type: ReportType.BUDGET_REPORT,
        title: 'Budget Report',
        generatedAt: new Date().toISOString(),
        filters,
        budgetGuid: actuals.budgetGuid,
        budgetName: actuals.budgetName,
        currency: actuals.currency,
        numPeriods: actuals.numPeriods,
        periods: actuals.periods
            .filter(p => selected.has(p.periodNum))
            .map(p => ({ periodNum: p.periodNum, start: p.start, end: p.end, label: p.label })),
        groups,
        net,
        sections: buildBudgetReportSections(groups),
        grandTotal: net.actual,
    };
}
