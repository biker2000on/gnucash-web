import prisma from '@/lib/prisma';
import {
    loadBudgetActuals,
    computePeriodRanges,
    signCorrectAmount,
    type BudgetRecurrence,
} from '@/lib/budget-actuals';
import { toDecimalNumber } from '@/lib/gnucash';
import { buildAccountValuationContext } from '@/lib/account-valuation';

/**
 * Budget Statements — Budget Income Statement, Budget Balance Sheet, and
 * Budget Barchart series (GnuCash desktop report parity).
 *
 * All budgeted/actual flow amounts for the income statement and barchart come
 * from `loadBudgetActuals` (src/lib/budget-actuals.ts) and are therefore
 * SIGN-CORRECTED: income reads positive-earned, expense reads positive-spent.
 * Only accounts that carry budget amounts (plus their ancestors, as rollup
 * subtotal rows) appear — actuals for never-budgeted leaf accounts are not
 * loaded, matching the GnuCash desktop budget reports.
 *
 * Variance convention (favorable-positive, uniform across rows and totals):
 *   EXPENSE: variance = budgeted − actual  (under-budget spend  = favorable)
 *   INCOME:  variance = actual − budgeted  (over-budget income  = favorable)
 *   NET:     variance = actualNet − budgetedNet
 * so a POSITIVE variance is always good news and a negative one always bad.
 *
 * Balance-sheet projection model (kept deliberately simple):
 *   For every asset/liability/equity account in the active book, the
 *   projected ("Budgeted") balance at the end of period P is
 *       actual opening balance (all activity before period 0)
 *     + Σ budgeted amounts for periods 0..P     — if the account is budgeted
 *     + Σ actual flows for periods 0..P         — if it carries no budget
 *   The "Actual" column is the real balance at the end of period P
 *   (opening + actual flows) for every account. STOCK/MUTUAL quantities are
 *   valued with the latest price at the end of period P in both columns;
 *   budget amounts on such accounts are treated as commodity quantities, the
 *   same convention `loadBudgetActuals` uses for actuals.
 *   Equity additionally gets a synthetic "Period net income (retained)" row:
 *   budgeted column = budgeted income − budgeted expenses through P, actual
 *   column = actual income − actual expenses through P. Pre-budget retained
 *   earnings are NOT closed into equity — exactly like the regular balance
 *   sheet report — so the A = L + E check carries the same caveat there.
 *   Liability and equity rows are displayed credit-normal (negated) so
 *   healthy balances read positive.
 */

/* ------------------------------------------------------------------ */
/* Shared types                                                        */
/* ------------------------------------------------------------------ */

export interface BudgetStatementPeriod {
    periodNum: number;
    /** YYYY-MM-DD inclusive */
    start: string;
    /** YYYY-MM-DD inclusive */
    end: string;
    label: string;
}

/** Budgeted vs actual with a favorable-positive variance. */
export interface VarianceCell {
    budgeted: number;
    actual: number;
    /** Favorable-positive (see module doc) */
    variance: number;
    favorable: boolean;
    /** actual / budgeted × 100; null when budgeted is 0 */
    pctOfBudget: number | null;
}

export interface BudgetStatementRow extends VarianceCell {
    guid: string;
    name: string;
    depth: number;
    /** True for rollup rows (accounts with budgeted descendants) */
    isSubtotal: boolean;
}

export interface BudgetStatementSection {
    title: string;
    rows: BudgetStatementRow[];
    total: VarianceCell;
}

/** Per-account input for the pure statement builder. */
export interface StatementAccountInput {
    guid: string;
    name: string;
    /** GnuCash account type (INCOME, EXPENSE, ...) */
    type: string;
    parentGuid: string | null;
    /** Sign-corrected budgeted amount per period (index = periodNum) */
    budgeted: number[];
    /** Sign-corrected actual amount per period (index = periodNum) */
    actual: number[];
}

export interface BudgetIncomeStatementData {
    reportType: 'budget_income_statement';
    title: string;
    generatedAt: string;
    budgetGuid: string;
    budgetName: string;
    currency: string;
    numPeriods: number;
    /** Every period the budget defines (for range pickers) */
    allPeriods: BudgetStatementPeriod[];
    /** The periods included in this statement */
    periods: BudgetStatementPeriod[];
    income: BudgetStatementSection;
    expense: BudgetStatementSection;
    /** Net income: budgeted vs actual vs variance (favorable-positive) */
    net: VarianceCell;
}

export interface BudgetIncomeStatementOptions {
    /** First period index, inclusive (default 0) */
    periodStart?: number | null;
    /** Last period index, inclusive (default numPeriods − 1) */
    periodEnd?: number | null;
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
};

/**
 * Favorable-positive variance: expenses under budget and income over budget
 * are both positive. Any non-EXPENSE type uses the income convention.
 */
export function computeVariance(type: string, budgeted: number, actual: number): number {
    return type === 'EXPENSE' ? budgeted - actual : actual - budgeted;
}

export function makeVarianceCell(type: string, budgeted: number, actual: number): VarianceCell {
    const b = round2(budgeted);
    const a = round2(actual);
    const variance = round2(computeVariance(type, b, a));
    return {
        budgeted: b,
        actual: a,
        variance,
        favorable: variance >= 0,
        pctOfBudget: b !== 0 ? round2((a / b) * 100) : null,
    };
}

/**
 * Resolve an inclusive [periodStart, periodEnd] option pair into period
 * indices. Out-of-range values clamp; a reversed pair is swapped; null or
 * undefined bounds default to the full budget.
 */
export function selectPeriodIndices(
    numPeriods: number,
    periodStart?: number | null,
    periodEnd?: number | null,
): number[] {
    if (numPeriods <= 0) return [];
    const clamp = (n: number) => Math.min(numPeriods - 1, Math.max(0, Math.trunc(n)));
    let lo = periodStart === null || periodStart === undefined || Number.isNaN(periodStart) ? 0 : clamp(periodStart);
    let hi = periodEnd === null || periodEnd === undefined || Number.isNaN(periodEnd) ? numPeriods - 1 : clamp(periodEnd);
    if (lo > hi) [lo, hi] = [hi, lo];
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

const sumPeriods = (values: number[], periodNums: ReadonlyArray<number>): number =>
    periodNums.reduce((s, p) => s + (values[p] || 0), 0);

/* ------------------------------------------------------------------ */
/* Income statement — pure section builder                             */
/* ------------------------------------------------------------------ */

interface StatementNode {
    account: StatementAccountInput;
    children: StatementNode[];
    budgeted: number;
    actual: number;
}

/**
 * Build one hierarchical statement section (Income or Expenses) from flat
 * accounts. Accounts whose parent is missing from the input attach at the
 * top level. Every node's amounts are its own plus all descendants; nodes
 * whose entire subtree is zero (both budgeted and actual) are pruned.
 * Rows come out in pre-order, sorted by name at every level. Pure.
 */
export function buildStatementSection(
    accounts: ReadonlyArray<StatementAccountInput>,
    sectionType: 'INCOME' | 'EXPENSE',
    periodNums: ReadonlyArray<number>,
    title: string,
): BudgetStatementSection {
    const sectionAccounts = accounts.filter(a => a.type === sectionType);
    const present = new Set(sectionAccounts.map(a => a.guid));

    const nodes = new Map<string, StatementNode>();
    for (const account of sectionAccounts) {
        nodes.set(account.guid, {
            account,
            children: [],
            budgeted: sumPeriods(account.budgeted, periodNums),
            actual: sumPeriods(account.actual, periodNums),
        });
    }

    const roots: StatementNode[] = [];
    for (const node of nodes.values()) {
        const parentGuid = node.account.parentGuid;
        if (parentGuid !== null && present.has(parentGuid)) {
            nodes.get(parentGuid)!.children.push(node);
        } else {
            roots.push(node);
        }
    }

    // Roll descendants up into every node (post-order).
    const rollup = (node: StatementNode): { budgeted: number; actual: number } => {
        for (const child of node.children) {
            const sums = rollup(child);
            node.budgeted += sums.budgeted;
            node.actual += sums.actual;
        }
        return { budgeted: node.budgeted, actual: node.actual };
    };
    roots.forEach(rollup);

    const rows: BudgetStatementRow[] = [];
    const emit = (list: StatementNode[], depth: number) => {
        const sorted = [...list].sort((a, b) => a.account.name.localeCompare(b.account.name));
        for (const node of sorted) {
            if (round2(node.budgeted) === 0 && round2(node.actual) === 0) continue;
            rows.push({
                guid: node.account.guid,
                name: node.account.name,
                depth,
                isSubtotal: node.children.length > 0,
                ...makeVarianceCell(sectionType, node.budgeted, node.actual),
            });
            emit(node.children, depth + 1);
        }
    };
    emit(roots, 0);

    const total = makeVarianceCell(
        sectionType,
        roots.reduce((s, n) => s + n.budgeted, 0),
        roots.reduce((s, n) => s + n.actual, 0),
    );

    return { title, rows, total };
}

/**
 * Net income cell from section totals. Variance uses the income convention
 * (actual − budgeted), so beating the plan is favorable-positive.
 */
export function buildNetIncome(
    income: { budgeted: number; actual: number },
    expense: { budgeted: number; actual: number },
): VarianceCell {
    return makeVarianceCell('INCOME', income.budgeted - expense.budgeted, income.actual - expense.actual);
}

/* ------------------------------------------------------------------ */
/* Balance sheet — pure projection                                     */
/* ------------------------------------------------------------------ */

/** Per-account input for the pure balance-sheet projection. */
export interface BalanceProjectionInput {
    guid: string;
    name: string;
    /** GnuCash account type (ASSET, BANK, LIABILITY, EQUITY, ...) */
    type: string;
    parentGuid: string | null;
    /** Actual balance before period 0 (valued, raw GnuCash sign) */
    openingBalance: number;
    /** Budgeted flow per period (valued, raw GnuCash sign) */
    budgeted: number[];
    /** Actual flow per period (valued, raw GnuCash sign) */
    actualFlows: number[];
    /** True when the account carries any budget amount in this budget */
    hasBudget: boolean;
}

export interface ProjectedBalance {
    guid: string;
    /** Opening + budgeted flows 0..P (actual flows when not budgeted). Raw sign. */
    projected: number;
    /** Opening + actual flows 0..P. Raw sign. */
    actual: number;
}

/**
 * Core projection math: budgeted accounts follow the plan, unbudgeted
 * accounts follow reality, both starting from the actual opening balance.
 * Raw GnuCash signs in, raw signs out. Pure.
 */
export function projectAccountBalances(
    accounts: ReadonlyArray<BalanceProjectionInput>,
    periodIndex: number,
): ProjectedBalance[] {
    const periodNums = Array.from({ length: Math.max(0, periodIndex + 1) }, (_, i) => i);
    return accounts.map(account => {
        const actualFlow = sumPeriods(account.actualFlows, periodNums);
        const plannedFlow = account.hasBudget ? sumPeriods(account.budgeted, periodNums) : actualFlow;
        return {
            guid: account.guid,
            projected: account.openingBalance + plannedFlow,
            actual: account.openingBalance + actualFlow,
        };
    });
}

export interface BalanceSheetPair {
    budgeted: number;
    actual: number;
    /** actual − budgeted */
    difference: number;
}

export interface BudgetBalanceSheetRow extends BalanceSheetPair {
    guid: string;
    name: string;
    depth: number;
    isSubtotal: boolean;
    /** True for the synthetic period-net-income equity row */
    isSynthetic?: boolean;
}

export interface BudgetBalanceSheetSection {
    title: string;
    rows: BudgetBalanceSheetRow[];
    total: BalanceSheetPair;
}

export interface BudgetBalanceSheetData {
    reportType: 'budget_balance_sheet';
    title: string;
    generatedAt: string;
    budgetGuid: string;
    budgetName: string;
    currency: string;
    numPeriods: number;
    /** Every period the budget defines (for period pickers) */
    periods: BudgetStatementPeriod[];
    /** Balances are projected through the END of this period */
    periodIndex: number;
    /** YYYY-MM-DD end of the selected period */
    asOfDate: string;
    assets: BudgetBalanceSheetSection;
    liabilities: BudgetBalanceSheetSection;
    equity: BudgetBalanceSheetSection;
    totals: {
        assets: BalanceSheetPair;
        liabilities: BalanceSheetPair;
        equity: BalanceSheetPair;
        liabilitiesAndEquity: BalanceSheetPair;
        /** assets − (liabilities + equity); ≈0 when the book closes cleanly */
        check: BalanceSheetPair;
    };
}

export const BALANCE_SHEET_ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE'] as const;
export const BALANCE_SHEET_LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'] as const;
export const BALANCE_SHEET_EQUITY_TYPES = ['EQUITY'] as const;

const PERIOD_NET_INCOME_GUID = 'synthetic-period-net-income';

function makePair(budgeted: number, actual: number): BalanceSheetPair {
    const b = round2(budgeted);
    const a = round2(actual);
    return { budgeted: b, actual: a, difference: round2(a - b) };
}

interface BalanceNode {
    account: BalanceProjectionInput;
    children: BalanceNode[];
    projected: number;
    actual: number;
}

function buildBalanceSection(
    accounts: ReadonlyArray<BalanceProjectionInput>,
    balances: Map<string, ProjectedBalance>,
    types: ReadonlyArray<string>,
    title: string,
    /** +1 for debit-normal (assets), −1 for credit-normal display */
    displaySign: 1 | -1,
    extraRows: BudgetBalanceSheetRow[] = [],
): BudgetBalanceSheetSection {
    const sectionAccounts = accounts.filter(a => types.includes(a.type));
    const present = new Set(sectionAccounts.map(a => a.guid));

    const nodes = new Map<string, BalanceNode>();
    for (const account of sectionAccounts) {
        const balance = balances.get(account.guid);
        nodes.set(account.guid, {
            account,
            children: [],
            projected: balance?.projected ?? 0,
            actual: balance?.actual ?? 0,
        });
    }

    const roots: BalanceNode[] = [];
    for (const node of nodes.values()) {
        const parentGuid = node.account.parentGuid;
        if (parentGuid !== null && present.has(parentGuid)) {
            nodes.get(parentGuid)!.children.push(node);
        } else {
            roots.push(node);
        }
    }

    const rollup = (node: BalanceNode): { projected: number; actual: number } => {
        for (const child of node.children) {
            const sums = rollup(child);
            node.projected += sums.projected;
            node.actual += sums.actual;
        }
        return { projected: node.projected, actual: node.actual };
    };
    roots.forEach(rollup);

    const rows: BudgetBalanceSheetRow[] = [];
    const emit = (list: BalanceNode[], depth: number) => {
        const sorted = [...list].sort((a, b) => a.account.name.localeCompare(b.account.name));
        for (const node of sorted) {
            const projected = round2(displaySign * node.projected);
            const actual = round2(displaySign * node.actual);
            if (projected === 0 && actual === 0 && node.children.length === 0) continue;
            rows.push({
                guid: node.account.guid,
                name: node.account.name,
                depth,
                isSubtotal: node.children.length > 0,
                ...makePair(displaySign * node.projected, displaySign * node.actual),
            });
            emit(node.children, depth + 1);
        }
    };
    emit(roots, 0);
    rows.push(...extraRows);

    const total = makePair(
        displaySign * roots.reduce((s, n) => s + n.projected, 0) + extraRows.reduce((s, r) => s + r.budgeted, 0),
        displaySign * roots.reduce((s, n) => s + n.actual, 0) + extraRows.reduce((s, r) => s + r.actual, 0),
    );

    return { title, rows, total };
}

/**
 * Assemble the three balance-sheet sections plus totals from projected
 * balances. Liabilities and equity are displayed credit-normal (negated);
 * `periodNetIncome` (sign-corrected income − expense through the projection
 * period) is appended to equity as a synthetic retained-earnings row. Pure.
 */
export function buildBudgetBalanceSheetSections(
    accounts: ReadonlyArray<BalanceProjectionInput>,
    periodIndex: number,
    periodNetIncome: { budgeted: number; actual: number },
): Pick<BudgetBalanceSheetData, 'assets' | 'liabilities' | 'equity' | 'totals'> {
    const balances = new Map(
        projectAccountBalances(accounts, periodIndex).map(b => [b.guid, b]),
    );

    const netIncomeRow: BudgetBalanceSheetRow = {
        guid: PERIOD_NET_INCOME_GUID,
        name: 'Period net income (retained)',
        depth: 0,
        isSubtotal: false,
        isSynthetic: true,
        ...makePair(periodNetIncome.budgeted, periodNetIncome.actual),
    };

    const assets = buildBalanceSection(accounts, balances, BALANCE_SHEET_ASSET_TYPES, 'Assets', 1);
    const liabilities = buildBalanceSection(accounts, balances, BALANCE_SHEET_LIABILITY_TYPES, 'Liabilities', -1);
    const equity = buildBalanceSection(accounts, balances, BALANCE_SHEET_EQUITY_TYPES, 'Equity', -1, [netIncomeRow]);

    const liabilitiesAndEquity = makePair(
        liabilities.total.budgeted + equity.total.budgeted,
        liabilities.total.actual + equity.total.actual,
    );
    const check = makePair(
        assets.total.budgeted - liabilitiesAndEquity.budgeted,
        assets.total.actual - liabilitiesAndEquity.actual,
    );

    return {
        assets,
        liabilities,
        equity,
        totals: {
            assets: assets.total,
            liabilities: liabilities.total,
            equity: equity.total,
            liabilitiesAndEquity,
            check,
        },
    };
}

/* ------------------------------------------------------------------ */
/* Barchart series — pure                                              */
/* ------------------------------------------------------------------ */

export interface BarchartPoint {
    periodNum: number;
    label: string;
    budgeted: number;
    actual: number;
}

export type BarchartScope = 'income' | 'expense' | 'net';

export interface BudgetBarchartSeriesData {
    reportType: 'budget_barchart';
    budgetGuid: string;
    budgetName: string;
    currency: string;
    numPeriods: number;
    scopeLabel: string;
    points: BarchartPoint[];
}

/**
 * Sum per-period budgeted/actual matrices into one grouped-bar series.
 * Callers pre-apply any sign weighting (e.g. negate expenses for a net
 * series). Pure.
 */
export function buildBarchartPoints(
    accounts: ReadonlyArray<{ budgeted: number[]; actual: number[] }>,
    periods: ReadonlyArray<BudgetStatementPeriod>,
): BarchartPoint[] {
    return periods.map(period => ({
        periodNum: period.periodNum,
        label: period.label,
        budgeted: round2(accounts.reduce((s, a) => s + (a.budgeted[period.periodNum] || 0), 0)),
        actual: round2(accounts.reduce((s, a) => s + (a.actual[period.periodNum] || 0), 0)),
    }));
}

/* ------------------------------------------------------------------ */
/* DB-bound generators                                                 */
/* ------------------------------------------------------------------ */

/**
 * A budget "belongs to" the active book when it either has no amounts at all
 * (a legal empty budget) or at least one of its budgeted accounts is inside
 * the book's account tree. Mirrors how loadBudgetActuals scopes accounts.
 */
async function budgetBelongsToBook(budgetGuid: string, bookAccountGuids: string[]): Promise<boolean> {
    const totalAmounts = await prisma.budget_amounts.count({ where: { budget_guid: budgetGuid } });
    if (totalAmounts === 0) return true;
    const inBook = await prisma.budget_amounts.count({
        where: { budget_guid: budgetGuid, account_guid: { in: bookAccountGuids } },
    });
    return inBook > 0;
}

interface HierarchyAccount {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
}

/**
 * Restrict hierarchy accounts to budgeted accounts plus their ancestors so
 * never-budgeted leaves (whose actuals were never loaded) don't render as
 * misleading zero rows.
 */
function ancestorClosure(accounts: HierarchyAccount[], keepGuids: Set<string>): HierarchyAccount[] {
    const byGuid = new Map(accounts.map(a => [a.guid, a]));
    const keep = new Set<string>();
    for (const guid of keepGuids) {
        let cursor: string | null | undefined = guid;
        while (cursor && byGuid.has(cursor) && !keep.has(cursor)) {
            keep.add(cursor);
            cursor = byGuid.get(cursor)!.parent_guid;
        }
    }
    return accounts.filter(a => keep.has(a.guid));
}

/**
 * Budget Income Statement: period-formatted budget-vs-actual P&L with
 * hierarchical rollups, favorable-positive variances, and a net income row.
 * Returns null when the budget does not exist or belongs to another book.
 */
export async function generateBudgetIncomeStatement(
    bookAccountGuids: string[],
    budgetGuid: string,
    options: BudgetIncomeStatementOptions = {},
): Promise<BudgetIncomeStatementData | null> {
    if (!(await budgetBelongsToBook(budgetGuid, bookAccountGuids))) return null;

    const actuals = await loadBudgetActuals(budgetGuid);
    if (!actuals) return null;

    const periodNums = selectPeriodIndices(actuals.numPeriods, options.periodStart, options.periodEnd);
    const selected = new Set(periodNums);

    const matrixByGuid = new Map(
        actuals.accounts.map(account => [
            account.guid,
            {
                type: account.type,
                budgeted: account.periods.map(p => p.budgeted),
                actual: account.periods.map(p => p.actual),
            },
        ]),
    );

    // Hierarchy: book-scoped income/expense accounts (hidden included so a
    // budgeted-but-hidden account's amounts are never silently dropped).
    const hierarchy: HierarchyAccount[] = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { in: ['INCOME', 'EXPENSE'] },
        },
        select: { guid: true, name: true, account_type: true, parent_guid: true },
    });

    const budgetedGuids = new Set(
        [...matrixByGuid.entries()]
            .filter(([, m]) => m.type === 'INCOME' || m.type === 'EXPENSE')
            .map(([guid]) => guid),
    );
    const scoped = ancestorClosure(hierarchy, budgetedGuids);

    const inputs: StatementAccountInput[] = scoped.map(account => {
        const matrix = matrixByGuid.get(account.guid);
        return {
            guid: account.guid,
            name: account.name,
            type: account.account_type,
            parentGuid: account.parent_guid,
            budgeted: matrix?.budgeted ?? [],
            actual: matrix?.actual ?? [],
        };
    });

    const income = buildStatementSection(inputs, 'INCOME', periodNums, 'Income');
    const expense = buildStatementSection(inputs, 'EXPENSE', periodNums, 'Expenses');
    const net = buildNetIncome(income.total, expense.total);

    const toPeriod = (p: { periodNum: number; start: string; end: string; label: string }): BudgetStatementPeriod =>
        ({ periodNum: p.periodNum, start: p.start, end: p.end, label: p.label });

    return {
        reportType: 'budget_income_statement',
        title: 'Budget Income Statement',
        generatedAt: new Date().toISOString(),
        budgetGuid: actuals.budgetGuid,
        budgetName: actuals.budgetName,
        currency: actuals.currency,
        numPeriods: actuals.numPeriods,
        allPeriods: actuals.periods.map(toPeriod),
        periods: actuals.periods.filter(p => selected.has(p.periodNum)).map(toPeriod),
        income,
        expense,
        net,
    };
}

/**
 * Budget Barchart series: per-period budgeted vs actual for a scope — an
 * account subtree (accountGuid, inclusive of descendants) or a top-level
 * type ('income' | 'expense' | 'net'). Returns null when the budget does
 * not exist or belongs to another book.
 */
export async function budgetBarchartSeries(
    bookAccountGuids: string[],
    budgetGuid: string,
    options: {
        scope?: BarchartScope;
        accountGuid?: string | null;
        periodStart?: number | null;
        periodEnd?: number | null;
    } = {},
): Promise<BudgetBarchartSeriesData | null> {
    if (!(await budgetBelongsToBook(budgetGuid, bookAccountGuids))) return null;

    const actuals = await loadBudgetActuals(budgetGuid);
    if (!actuals) return null;

    const scope = options.scope ?? 'expense';
    const periodNums = new Set(selectPeriodIndices(actuals.numPeriods, options.periodStart, options.periodEnd));
    const periods: BudgetStatementPeriod[] = actuals.periods
        .filter(p => periodNums.has(p.periodNum))
        .map(p => ({ periodNum: p.periodNum, start: p.start, end: p.end, label: p.label }));

    let scopeLabel: string;
    let weighted: Array<{ budgeted: number[]; actual: number[] }>;

    if (options.accountGuid) {
        // Subtree scope: the account plus all descendants inside the book.
        const hierarchy = await prisma.accounts.findMany({
            where: { guid: { in: bookAccountGuids } },
            select: { guid: true, name: true, parent_guid: true },
        });
        const childrenOf = new Map<string, string[]>();
        for (const account of hierarchy) {
            if (!account.parent_guid) continue;
            const list = childrenOf.get(account.parent_guid) ?? [];
            list.push(account.guid);
            childrenOf.set(account.parent_guid, list);
        }
        const subtree = new Set<string>();
        const stack = [options.accountGuid];
        while (stack.length > 0) {
            const guid = stack.pop()!;
            if (subtree.has(guid)) continue;
            subtree.add(guid);
            stack.push(...(childrenOf.get(guid) ?? []));
        }
        scopeLabel = hierarchy.find(a => a.guid === options.accountGuid)?.name ?? 'Account subtree';
        weighted = actuals.accounts
            .filter(account => subtree.has(account.guid))
            .map(account => ({
                budgeted: account.periods.map(p => p.budgeted),
                actual: account.periods.map(p => p.actual),
            }));
    } else {
        scopeLabel = scope === 'income' ? 'Income' : scope === 'expense' ? 'Expenses' : 'Net income';
        weighted = actuals.accounts
            .filter(account => account.type === 'INCOME' || account.type === 'EXPENSE')
            .filter(account => scope === 'net' || account.type === (scope === 'income' ? 'INCOME' : 'EXPENSE'))
            .map(account => {
                // For the net series expenses subtract from income.
                const weight = scope === 'net' && account.type === 'EXPENSE' ? -1 : 1;
                return {
                    budgeted: account.periods.map(p => weight * p.budgeted),
                    actual: account.periods.map(p => weight * p.actual),
                };
            });
    }

    return {
        reportType: 'budget_barchart',
        budgetGuid: actuals.budgetGuid,
        budgetName: actuals.budgetName,
        currency: actuals.currency,
        numPeriods: actuals.numPeriods,
        scopeLabel,
        points: buildBarchartPoints(weighted, periods),
    };
}

/**
 * Budget Balance Sheet: projected balances at the end of `periodIndex`
 * (clamped to the budget's range; see module doc for the model). Returns
 * null when the budget does not exist or belongs to another book.
 */
export async function generateBudgetBalanceSheet(
    bookAccountGuids: string[],
    budgetGuid: string,
    periodIndex: number,
): Promise<BudgetBalanceSheetData | null> {
    if (!(await budgetBelongsToBook(budgetGuid, bookAccountGuids))) return null;

    const budget = await prisma.budgets.findUnique({
        where: { guid: budgetGuid },
        include: {
            recurrences: true,
            amounts: { include: { account: { select: { account_type: true } } } },
        },
    });
    if (!budget || budget.num_periods <= 0) return null;

    const rec = budget.recurrences?.[0] ?? null;
    const recurrence: BudgetRecurrence = rec
        ? {
            periodType: rec.recurrence_period_type,
            mult: rec.recurrence_mult,
            periodStart: rec.recurrence_period_start.toISOString().slice(0, 10),
        }
        : { periodType: 'month', mult: 1, periodStart: `${new Date().getUTCFullYear()}-01-01` };

    const ranges = computePeriodRanges(recurrence, budget.num_periods);
    const clampedIndex = Math.min(budget.num_periods - 1, Math.max(0, Math.trunc(periodIndex)));
    const budgetStart = new Date(`${ranges[0].start}T00:00:00.000Z`);
    const asOfEnd = new Date(`${ranges[clampedIndex].end}T23:59:59.999Z`);

    const bookGuidSet = new Set(bookAccountGuids);

    // Book-scoped balance-sheet accounts.
    const balanceSheetTypes = [
        ...BALANCE_SHEET_ASSET_TYPES,
        ...BALANCE_SHEET_LIABILITY_TYPES,
        ...BALANCE_SHEET_EQUITY_TYPES,
    ];
    const accounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { in: balanceSheetTypes },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
            commodity_guid: true,
            commodity: { select: { namespace: true } },
        },
    });
    const accountGuids = accounts.map(a => a.guid);

    const valuation = await buildAccountValuationContext(
        accounts.map(account => ({
            accountType: account.account_type,
            commodityGuid: account.commodity_guid,
            commodityNamespace: account.commodity?.namespace,
        })),
        asOfEnd,
    );
    const multiplierByGuid = new Map(
        accounts.map(account => [
            account.guid,
            valuation.getMultiplier({
                accountType: account.account_type,
                commodityGuid: account.commodity_guid,
                commodityNamespace: account.commodity?.namespace,
            }),
        ]),
    );

    // One split pass: opening quantities (before period 0) and per-period
    // actual flow quantities through the selected period.
    const splits = accountGuids.length > 0
        ? await prisma.splits.findMany({
            where: {
                account_guid: { in: accountGuids },
                transaction: { post_date: { lte: asOfEnd } },
            },
            select: {
                account_guid: true,
                quantity_num: true,
                quantity_denom: true,
                transaction: { select: { post_date: true } },
            },
        })
        : [];

    const opening = new Map<string, number>();
    const flows = new Map<string, number[]>();
    for (const split of splits) {
        const postDate = split.transaction.post_date;
        if (!postDate) continue;
        const amount = toDecimalNumber(split.quantity_num, split.quantity_denom);
        if (postDate < budgetStart) {
            opening.set(split.account_guid, (opening.get(split.account_guid) || 0) + amount);
        } else {
            const dateKey = postDate.toISOString().slice(0, 10);
            const idx = ranges.findIndex(r => dateKey >= r.start && dateKey <= r.end);
            if (idx < 0) continue;
            let row = flows.get(split.account_guid);
            if (!row) {
                row = new Array(budget.num_periods).fill(0);
                flows.set(split.account_guid, row);
            }
            row[idx] += amount;
        }
    }

    // Budgeted flows per balance-sheet account (raw sign, book-scoped) and
    // sign-corrected income/expense budget totals for the net-income row.
    const budgetedFlows = new Map<string, number[]>();
    let budgetedIncome = 0;
    let budgetedExpense = 0;
    for (const amount of budget.amounts) {
        if (!bookGuidSet.has(amount.account_guid)) continue;
        if (amount.period_num < 0 || amount.period_num >= budget.num_periods) continue;
        const raw = toDecimalNumber(amount.amount_num, amount.amount_denom);
        const type = amount.account.account_type;
        if (type === 'INCOME' || type === 'EXPENSE') {
            if (amount.period_num <= clampedIndex) {
                if (type === 'INCOME') budgetedIncome += signCorrectAmount(type, raw);
                else budgetedExpense += raw;
            }
            continue;
        }
        let row = budgetedFlows.get(amount.account_guid);
        if (!row) {
            row = new Array(budget.num_periods).fill(0);
            budgetedFlows.set(amount.account_guid, row);
        }
        row[amount.period_num] += raw;
    }

    // Actual net income (sign-corrected) through the selected period.
    const ieAccounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { in: ['INCOME', 'EXPENSE'] },
        },
        select: { guid: true, account_type: true },
    });
    const ieTypeByGuid = new Map(ieAccounts.map(a => [a.guid, a.account_type]));
    const ieSplits = ieAccounts.length > 0
        ? await prisma.splits.findMany({
            where: {
                account_guid: { in: ieAccounts.map(a => a.guid) },
                transaction: { post_date: { gte: budgetStart, lte: asOfEnd } },
            },
            select: { account_guid: true, quantity_num: true, quantity_denom: true },
        })
        : [];
    let actualIncome = 0;
    let actualExpense = 0;
    for (const split of ieSplits) {
        const raw = toDecimalNumber(split.quantity_num, split.quantity_denom);
        if (ieTypeByGuid.get(split.account_guid) === 'INCOME') actualIncome += -raw;
        else actualExpense += raw;
    }

    const inputs: BalanceProjectionInput[] = accounts.map(account => {
        const multiplier = multiplierByGuid.get(account.guid) ?? 1;
        const budgeted = budgetedFlows.get(account.guid);
        return {
            guid: account.guid,
            name: account.name,
            type: account.account_type,
            parentGuid: account.parent_guid,
            openingBalance: (opening.get(account.guid) || 0) * multiplier,
            budgeted: (budgeted ?? []).map(v => v * multiplier),
            actualFlows: (flows.get(account.guid) ?? []).map(v => v * multiplier),
            hasBudget: budgeted !== undefined,
        };
    });

    const sections = buildBudgetBalanceSheetSections(inputs, clampedIndex, {
        budgeted: budgetedIncome - budgetedExpense,
        actual: actualIncome - actualExpense,
    });

    return {
        reportType: 'budget_balance_sheet',
        title: 'Budget Balance Sheet',
        generatedAt: new Date().toISOString(),
        budgetGuid: budget.guid,
        budgetName: budget.name,
        currency: valuation.reportCurrencyMnemonic,
        numPeriods: budget.num_periods,
        periods: ranges.map(r => ({ periodNum: r.periodNum, start: r.start, end: r.end, label: r.label })),
        periodIndex: clampedIndex,
        asOfDate: ranges[clampedIndex].end,
        ...sections,
    };
}
