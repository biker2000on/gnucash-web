/**
 * Unit tests for the pure aggregation core in
 * src/lib/reports/budget-statements.ts: variance sign conventions, hierarchy
 * rollups, period-range accumulation, net income math, balance-sheet
 * projection math, barchart series, and empty-budget handling.
 * DB-bound generators are not tested here.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {},
}));

import {
    computeVariance,
    makeVarianceCell,
    selectPeriodIndices,
    buildStatementSection,
    buildNetIncome,
    projectAccountBalances,
    buildBudgetBalanceSheetSections,
    buildBarchartPoints,
    type StatementAccountInput,
    type BalanceProjectionInput,
    type BudgetStatementPeriod,
} from '@/lib/reports/budget-statements';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function statementAccount(overrides: Partial<StatementAccountInput> = {}): StatementAccountInput {
    return {
        guid: 'acc1',
        name: 'Groceries',
        type: 'EXPENSE',
        parentGuid: null,
        budgeted: [],
        actual: [],
        ...overrides,
    };
}

function projectionAccount(overrides: Partial<BalanceProjectionInput> = {}): BalanceProjectionInput {
    return {
        guid: 'asset1',
        name: 'Checking',
        type: 'BANK',
        parentGuid: null,
        openingBalance: 0,
        budgeted: [],
        actualFlows: [],
        hasBudget: false,
        ...overrides,
    };
}

function periods(labels: string[]): BudgetStatementPeriod[] {
    return labels.map((label, i) => ({
        periodNum: i,
        start: `2026-${String(i + 1).padStart(2, '0')}-01`,
        end: `2026-${String(i + 1).padStart(2, '0')}-28`,
        label,
    }));
}

/* ------------------------------------------------------------------ */
/* Variance sign conventions                                           */
/* ------------------------------------------------------------------ */

describe('computeVariance', () => {
    it('expense under budget is favorable positive', () => {
        expect(computeVariance('EXPENSE', 500, 400)).toBe(100);
    });

    it('expense over budget is unfavorable negative', () => {
        expect(computeVariance('EXPENSE', 500, 650)).toBe(-150);
    });

    it('income over budget is favorable positive', () => {
        expect(computeVariance('INCOME', 1000, 1200)).toBe(200);
    });

    it('income under budget is unfavorable negative', () => {
        expect(computeVariance('INCOME', 1000, 900)).toBe(-100);
    });
});

describe('makeVarianceCell', () => {
    it('marks favorable and computes % of budget', () => {
        const cell = makeVarianceCell('EXPENSE', 500, 400);
        expect(cell).toMatchObject({
            budgeted: 500,
            actual: 400,
            variance: 100,
            favorable: true,
            pctOfBudget: 80,
        });
    });

    it('marks unfavorable expense overruns', () => {
        const cell = makeVarianceCell('EXPENSE', 500, 650);
        expect(cell.variance).toBe(-150);
        expect(cell.favorable).toBe(false);
        expect(cell.pctOfBudget).toBe(130);
    });

    it('exactly on budget is favorable with 100%', () => {
        const cell = makeVarianceCell('INCOME', 300, 300);
        expect(cell.variance).toBe(0);
        expect(cell.favorable).toBe(true);
        expect(cell.pctOfBudget).toBe(100);
    });

    it('% of budget is null when nothing was budgeted', () => {
        const cell = makeVarianceCell('EXPENSE', 0, 42);
        expect(cell.pctOfBudget).toBeNull();
        expect(cell.variance).toBe(-42);
        expect(cell.favorable).toBe(false);
    });

    it('rounds to cents and never emits negative zero', () => {
        const cell = makeVarianceCell('EXPENSE', 10.005, 10.0049);
        expect(Object.is(cell.variance, -0)).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* Period-range selection                                              */
/* ------------------------------------------------------------------ */

describe('selectPeriodIndices', () => {
    it('defaults to the full budget', () => {
        expect(selectPeriodIndices(4)).toEqual([0, 1, 2, 3]);
        expect(selectPeriodIndices(4, null, null)).toEqual([0, 1, 2, 3]);
    });

    it('selects a single period when start equals end', () => {
        expect(selectPeriodIndices(12, 6, 6)).toEqual([6]);
    });

    it('selects an inclusive sub-range (year-to-date style)', () => {
        expect(selectPeriodIndices(12, 0, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('clamps out-of-range bounds', () => {
        expect(selectPeriodIndices(3, -5, 99)).toEqual([0, 1, 2]);
    });

    it('swaps a reversed pair', () => {
        expect(selectPeriodIndices(12, 4, 2)).toEqual([2, 3, 4]);
    });

    it('returns empty for a zero-period budget', () => {
        expect(selectPeriodIndices(0)).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* Statement sections: rollups + accumulation                          */
/* ------------------------------------------------------------------ */

describe('buildStatementSection', () => {
    const accounts: StatementAccountInput[] = [
        statementAccount({
            guid: 'food', name: 'Food', type: 'EXPENSE', parentGuid: null,
            budgeted: [0, 0, 0], actual: [0, 0, 0],
        }),
        statementAccount({
            guid: 'groceries', name: 'Groceries', type: 'EXPENSE', parentGuid: 'food',
            budgeted: [100, 100, 100], actual: [90, 120, 80],
        }),
        statementAccount({
            guid: 'dining', name: 'Dining', type: 'EXPENSE', parentGuid: 'food',
            budgeted: [50, 50, 50], actual: [60, 40, 55],
        }),
        statementAccount({
            guid: 'salary', name: 'Salary', type: 'INCOME', parentGuid: null,
            budgeted: [1000, 1000, 1000], actual: [1000, 1100, 950],
        }),
    ];

    it('rolls children up into parent subtotal rows', () => {
        const section = buildStatementSection(accounts, 'EXPENSE', [0, 1, 2], 'Expenses');
        const food = section.rows.find(r => r.guid === 'food')!;
        expect(food.isSubtotal).toBe(true);
        expect(food.depth).toBe(0);
        expect(food.budgeted).toBe(450); // 300 groceries + 150 dining
        expect(food.actual).toBe(445);   // 290 + 155
        expect(food.variance).toBe(5);   // under budget → favorable
        expect(food.favorable).toBe(true);

        const groceries = section.rows.find(r => r.guid === 'groceries')!;
        expect(groceries.depth).toBe(1);
        expect(groceries.isSubtotal).toBe(false);
    });

    it('section total matches the top-level rollup', () => {
        const section = buildStatementSection(accounts, 'EXPENSE', [0, 1, 2], 'Expenses');
        expect(section.total.budgeted).toBe(450);
        expect(section.total.actual).toBe(445);
        expect(section.total.variance).toBe(5);
    });

    it('accumulates only the selected periods', () => {
        const section = buildStatementSection(accounts, 'EXPENSE', [1], 'Expenses');
        const groceries = section.rows.find(r => r.guid === 'groceries')!;
        expect(groceries.budgeted).toBe(100);
        expect(groceries.actual).toBe(120);
        expect(groceries.variance).toBe(-20); // over budget → unfavorable
        expect(groceries.favorable).toBe(false);
    });

    it('filters by section type and applies the income convention', () => {
        const section = buildStatementSection(accounts, 'INCOME', [0, 1, 2], 'Income');
        expect(section.rows.map(r => r.guid)).toEqual(['salary']);
        const salary = section.rows[0];
        expect(salary.budgeted).toBe(3000);
        expect(salary.actual).toBe(3050);
        expect(salary.variance).toBe(50); // over-budget income → favorable
        expect(salary.favorable).toBe(true);
    });

    it('prunes all-zero subtrees', () => {
        const withZero = [
            ...accounts,
            statementAccount({ guid: 'unused', name: 'Unused', budgeted: [0, 0, 0], actual: [0, 0, 0] }),
        ];
        const section = buildStatementSection(withZero, 'EXPENSE', [0, 1, 2], 'Expenses');
        expect(section.rows.find(r => r.guid === 'unused')).toBeUndefined();
    });

    it('attaches orphans (parent missing from the input) at the top level', () => {
        const orphan = [
            statementAccount({
                guid: 'lonely', name: 'Lonely', parentGuid: 'not-present',
                budgeted: [10], actual: [5],
            }),
        ];
        const section = buildStatementSection(orphan, 'EXPENSE', [0], 'Expenses');
        expect(section.rows).toHaveLength(1);
        expect(section.rows[0].depth).toBe(0);
        expect(section.total.budgeted).toBe(10);
    });

    it('handles an empty budget: no rows, zero totals', () => {
        const section = buildStatementSection([], 'EXPENSE', [0, 1, 2], 'Expenses');
        expect(section.rows).toEqual([]);
        expect(section.total).toMatchObject({ budgeted: 0, actual: 0, variance: 0, pctOfBudget: null });
    });
});

describe('buildNetIncome', () => {
    it('computes budgeted vs actual net with income-convention variance', () => {
        const net = buildNetIncome(
            { budgeted: 3000, actual: 3050 },
            { budgeted: 450, actual: 445 },
        );
        expect(net.budgeted).toBe(2550);
        expect(net.actual).toBe(2605);
        expect(net.variance).toBe(55); // beat the plan → favorable
        expect(net.favorable).toBe(true);
    });

    it('flags an unfavorable net miss', () => {
        const net = buildNetIncome(
            { budgeted: 1000, actual: 800 },
            { budgeted: 400, actual: 500 },
        );
        expect(net.budgeted).toBe(600);
        expect(net.actual).toBe(300);
        expect(net.variance).toBe(-300);
        expect(net.favorable).toBe(false);
    });

    it('is zero-safe for an empty budget', () => {
        const net = buildNetIncome({ budgeted: 0, actual: 0 }, { budgeted: 0, actual: 0 });
        expect(net).toMatchObject({ budgeted: 0, actual: 0, variance: 0, favorable: true, pctOfBudget: null });
    });
});

/* ------------------------------------------------------------------ */
/* Balance-sheet projection                                            */
/* ------------------------------------------------------------------ */

describe('projectAccountBalances', () => {
    it('budgeted accounts project opening + budgeted flows through the period', () => {
        const [result] = projectAccountBalances(
            [projectionAccount({
                openingBalance: 1000,
                budgeted: [200, 200, 200, 200],
                actualFlows: [150, 250, 0, 0],
                hasBudget: true,
            })],
            2, // through end of period 2
        );
        expect(result.projected).toBe(1000 + 600); // 3 budgeted periods
        expect(result.actual).toBe(1000 + 400);    // actual flows through period 2
    });

    it('unbudgeted accounts carry their actual balance in both columns', () => {
        const [result] = projectAccountBalances(
            [projectionAccount({
                openingBalance: 500,
                budgeted: [],
                actualFlows: [10, -20, 30],
                hasBudget: false,
            })],
            1,
        );
        expect(result.projected).toBe(490);
        expect(result.actual).toBe(490);
    });

    it('a budgeted account with no amounts in range projects only its opening balance', () => {
        const [result] = projectAccountBalances(
            [projectionAccount({
                openingBalance: 750,
                budgeted: [0, 0, 500],
                actualFlows: [100, 0, 0],
                hasBudget: true,
            })],
            1, // period 2's budget not yet included
        );
        expect(result.projected).toBe(750);
        expect(result.actual).toBe(850);
    });

    it('period 0 includes exactly one period of flows', () => {
        const [result] = projectAccountBalances(
            [projectionAccount({ openingBalance: 0, budgeted: [100, 100], actualFlows: [80, 80], hasBudget: true })],
            0,
        );
        expect(result.projected).toBe(100);
        expect(result.actual).toBe(80);
    });
});

describe('buildBudgetBalanceSheetSections', () => {
    const accounts: BalanceProjectionInput[] = [
        projectionAccount({
            guid: 'checking', name: 'Checking', type: 'BANK', parentGuid: 'assets',
            openingBalance: 1000, budgeted: [500, 500], actualFlows: [450, 0], hasBudget: true,
        }),
        projectionAccount({
            guid: 'assets', name: 'Current Assets', type: 'ASSET', parentGuid: null,
            openingBalance: 0, budgeted: [], actualFlows: [], hasBudget: false,
        }),
        projectionAccount({
            guid: 'visa', name: 'Visa', type: 'CREDIT', parentGuid: null,
            // raw GnuCash sign: liabilities negative when owed
            openingBalance: -300, budgeted: [-100, -100], actualFlows: [-50, 0], hasBudget: true,
        }),
        projectionAccount({
            guid: 'opening-eq', name: 'Opening Balances', type: 'EQUITY', parentGuid: null,
            openingBalance: -700, budgeted: [], actualFlows: [], hasBudget: false,
        }),
    ];

    const result = buildBudgetBalanceSheetSections(accounts, 1, { budgeted: 800, actual: 400 });

    it('rolls asset children into parent rollup rows', () => {
        const parent = result.assets.rows.find(r => r.guid === 'assets')!;
        expect(parent.isSubtotal).toBe(true);
        expect(parent.budgeted).toBe(2000); // 1000 opening + 500 + 500 budgeted
        expect(parent.actual).toBe(1450);   // 1000 + 450
        const child = result.assets.rows.find(r => r.guid === 'checking')!;
        expect(child.depth).toBe(1);
        expect(result.totals.assets).toMatchObject({ budgeted: 2000, actual: 1450, difference: -550 });
    });

    it('displays liabilities credit-normal (positive when owed)', () => {
        const visa = result.liabilities.rows.find(r => r.guid === 'visa')!;
        expect(visa.budgeted).toBe(500); // -(-300 - 200)
        expect(visa.actual).toBe(350);   // -(-300 - 50)
        expect(result.totals.liabilities).toMatchObject({ budgeted: 500, actual: 350 });
    });

    it('appends the synthetic period-net-income row to equity', () => {
        const synthetic = result.equity.rows.find(r => r.isSynthetic)!;
        expect(synthetic.budgeted).toBe(800);
        expect(synthetic.actual).toBe(400);
        // equity accounts (700 credit-normal) + net income row
        expect(result.totals.equity).toMatchObject({ budgeted: 1500, actual: 1100 });
    });

    it('computes L+E and the balancing check per column', () => {
        expect(result.totals.liabilitiesAndEquity).toMatchObject({ budgeted: 2000, actual: 1450 });
        expect(result.totals.check).toMatchObject({ budgeted: 0, actual: 0 });
    });

    it('handles an empty account list', () => {
        const empty = buildBudgetBalanceSheetSections([], 0, { budgeted: 0, actual: 0 });
        expect(empty.assets.rows).toEqual([]);
        expect(empty.totals.assets).toMatchObject({ budgeted: 0, actual: 0 });
        // synthetic equity row is still present (zero-valued)
        expect(empty.equity.rows.filter(r => r.isSynthetic)).toHaveLength(1);
    });
});

/* ------------------------------------------------------------------ */
/* Barchart series                                                     */
/* ------------------------------------------------------------------ */

describe('buildBarchartPoints', () => {
    it('sums budgeted and actual across accounts per period', () => {
        const points = buildBarchartPoints(
            [
                { budgeted: [100, 100, 100], actual: [90, 120, 80] },
                { budgeted: [50, 50, 50], actual: [60, 40, 55] },
            ],
            periods(['Jan 2026', 'Feb 2026', 'Mar 2026']),
        );
        expect(points).toEqual([
            { periodNum: 0, label: 'Jan 2026', budgeted: 150, actual: 150 },
            { periodNum: 1, label: 'Feb 2026', budgeted: 150, actual: 160 },
            { periodNum: 2, label: 'Mar 2026', budgeted: 150, actual: 135 },
        ]);
    });

    it('respects a restricted period subset', () => {
        const points = buildBarchartPoints(
            [{ budgeted: [10, 20, 30], actual: [1, 2, 3] }],
            periods(['Jan 2026', 'Feb 2026', 'Mar 2026']).slice(1, 2),
        );
        expect(points).toEqual([{ periodNum: 1, label: 'Feb 2026', budgeted: 20, actual: 2 }]);
    });

    it('handles an empty budget: zero-valued points', () => {
        const points = buildBarchartPoints([], periods(['Jan 2026']));
        expect(points).toEqual([{ periodNum: 0, label: 'Jan 2026', budgeted: 0, actual: 0 }]);
    });
});
