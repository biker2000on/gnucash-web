/**
 * Budget Report — pure aggregation tests
 *
 * Exercises period selection by date-range overlap and the grouped
 * budgeted/actual/difference/% used math, including zero-budget rows,
 * income vs expense subtotals, the net row, and empty-budget cases.
 */

import { describe, it, expect, vi } from 'vitest';

// The module under test imports loadBudgetActuals (DB-bound); mock it so
// importing the pure functions doesn't require a database.
vi.mock('@/lib/budget-actuals', () => ({ loadBudgetActuals: vi.fn() }));

import {
  selectPeriodNums,
  buildBudgetReportGroups,
  buildBudgetReportSections,
  pctUsedOf,
  BudgetReportAccountInput,
} from '../budget-report';

const account = (
  guid: string,
  type: string,
  budgeted: number[],
  actual: number[],
  name = guid,
): BudgetReportAccountInput => ({ guid, name, type, budgeted, actual });

const PERIODS = [
  { periodNum: 0, start: '2026-01-01', end: '2026-01-31' },
  { periodNum: 1, start: '2026-02-01', end: '2026-02-28' },
  { periodNum: 2, start: '2026-03-01', end: '2026-03-31' },
];

describe('selectPeriodNums', () => {
  it('returns every period when no dates are given', () => {
    expect(selectPeriodNums(PERIODS, null, null)).toEqual([0, 1, 2]);
    expect(selectPeriodNums(PERIODS)).toEqual([0, 1, 2]);
  });

  it('selects periods overlapping the range (inclusive, partial overlap counts)', () => {
    // Jan 15 – Feb 10 touches both Jan and Feb
    expect(selectPeriodNums(PERIODS, '2026-01-15', '2026-02-10')).toEqual([0, 1]);
    // Exactly one day on a period boundary
    expect(selectPeriodNums(PERIODS, '2026-02-28', '2026-02-28')).toEqual([1]);
  });

  it('supports open-ended bounds', () => {
    expect(selectPeriodNums(PERIODS, '2026-02-01', null)).toEqual([1, 2]);
    expect(selectPeriodNums(PERIODS, null, '2026-01-31')).toEqual([0]);
  });

  it('returns empty when the range misses every period', () => {
    expect(selectPeriodNums(PERIODS, '2027-01-01', '2027-12-31')).toEqual([]);
  });
});

describe('pctUsedOf', () => {
  it('computes actual/budgeted percent rounded to 2 decimals', () => {
    expect(pctUsedOf(50, 200)).toBe(25);
    expect(pctUsedOf(1, 3)).toBe(33.33);
  });

  it('is null for a zero budget', () => {
    expect(pctUsedOf(50, 0)).toBeNull();
    expect(pctUsedOf(0, 0)).toBeNull();
  });
});

describe('buildBudgetReportGroups', () => {
  it('computes budgeted, actual, difference, and % used per account', () => {
    const { groups } = buildBudgetReportGroups(
      [account('groceries', 'EXPENSE', [500, 500, 500], [450, 520, 0], 'Groceries')],
      [0, 1, 2],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('expense');
    const row = groups[0].rows[0];
    expect(row.budgeted).toBe(1500);
    expect(row.actual).toBe(970);
    expect(row.difference).toBe(530); // budgeted - actual (under budget)
    expect(row.pctUsed).toBe(64.67);
  });

  it('only sums the selected periods', () => {
    const { groups } = buildBudgetReportGroups(
      [account('rent', 'EXPENSE', [100, 200, 300], [90, 210, 290])],
      [1],
    );
    const row = groups[0].rows[0];
    expect(row.budgeted).toBe(200);
    expect(row.actual).toBe(210);
    expect(row.difference).toBe(-10); // over budget → negative
    expect(row.pctUsed).toBe(105);
  });

  it('keeps zero-budget rows with actual spend and reports % used as null', () => {
    const { groups } = buildBudgetReportGroups(
      [account('surprise', 'EXPENSE', [0], [42])],
      [0],
    );
    const row = groups[0].rows[0];
    expect(row.budgeted).toBe(0);
    expect(row.actual).toBe(42);
    expect(row.difference).toBe(-42);
    expect(row.pctUsed).toBeNull();
  });

  it('groups income vs expense with subtotals and a net row', () => {
    const { groups, net } = buildBudgetReportGroups(
      [
        account('salary', 'INCOME', [4000], [4100], 'Salary'),
        account('bonus', 'INCOME', [500], [0], 'Bonus'),
        account('rent', 'EXPENSE', [1500], [1500], 'Rent'),
        account('food', 'EXPENSE', [600], [700], 'Food'),
      ],
      [0],
    );

    expect(groups.map(g => g.key)).toEqual(['income', 'expense']);

    const income = groups[0];
    expect(income.subtotal.budgeted).toBe(4500);
    expect(income.subtotal.actual).toBe(4100);
    expect(income.subtotal.difference).toBe(400); // income shortfall vs plan
    expect(income.subtotal.pctUsed).toBe(91.11);

    const expense = groups[1];
    expect(expense.subtotal.budgeted).toBe(2100);
    expect(expense.subtotal.actual).toBe(2200);
    expect(expense.subtotal.difference).toBe(-100);

    // Net = income - expenses
    expect(net.budgeted).toBe(2400);
    expect(net.actual).toBe(1900);
    expect(net.difference).toBe(500);
    expect(net.pctUsed).toBe(79.17);
  });

  it('routes non-income/expense budget targets to an Other group excluded from net', () => {
    const { groups, net } = buildBudgetReportGroups(
      [
        account('salary', 'INCOME', [1000], [1000]),
        account('savings', 'ASSET', [200], [150], 'Savings transfer'),
      ],
      [0],
    );

    expect(groups.map(g => g.key)).toEqual(['income', 'other']);
    const other = groups.find(g => g.key === 'other')!;
    expect(other.subtotal.budgeted).toBe(200);
    // Net ignores the Other group entirely
    expect(net.budgeted).toBe(1000);
    expect(net.actual).toBe(1000);
  });

  it('sorts rows alphabetically within a group', () => {
    const { groups } = buildBudgetReportGroups(
      [
        account('z', 'EXPENSE', [1], [1], 'Zoo'),
        account('a', 'EXPENSE', [1], [1], 'Apples'),
        account('m', 'EXPENSE', [1], [1], 'Movies'),
      ],
      [0],
    );
    expect(groups[0].rows.map(r => r.name)).toEqual(['Apples', 'Movies', 'Zoo']);
  });

  it('handles an empty budget (no accounts): no groups, zero net', () => {
    const { groups, net } = buildBudgetReportGroups([], [0, 1]);
    expect(groups).toEqual([]);
    expect(net.budgeted).toBe(0);
    expect(net.actual).toBe(0);
    expect(net.difference).toBe(0);
    expect(net.pctUsed).toBeNull();
  });

  it('handles an empty period selection: rows exist with all-zero amounts', () => {
    const { groups, net } = buildBudgetReportGroups(
      [account('rent', 'EXPENSE', [100], [90])],
      [],
    );
    expect(groups[0].rows[0].budgeted).toBe(0);
    expect(groups[0].rows[0].actual).toBe(0);
    expect(net.actual).toBe(0);
  });

  it('rounds accumulated floating point to cents', () => {
    const { groups } = buildBudgetReportGroups(
      [account('x', 'EXPENSE', [10.005, 10.005, 10.005], [0.1, 0.2, 0.3])],
      [0, 1, 2],
    );
    const row = groups[0].rows[0];
    expect(row.budgeted).toBe(30.02); // 30.015000000000004 → 30.02
    expect(row.actual).toBe(0.6);
    expect(row.difference).toBe(29.42);
  });
});

describe('buildBudgetReportSections', () => {
  it('projects groups into single-amount sections (amount = actual)', () => {
    const { groups } = buildBudgetReportGroups(
      [
        account('salary', 'INCOME', [1000], [900], 'Salary'),
        account('rent', 'EXPENSE', [500], [510], 'Rent'),
      ],
      [0],
    );
    const sections = buildBudgetReportSections(groups);
    expect(sections).toEqual([
      {
        title: 'Income',
        items: [{ guid: 'salary', name: 'Salary', amount: 900 }],
        total: 900,
      },
      {
        title: 'Expenses',
        items: [{ guid: 'rent', name: 'Rent', amount: 510 }],
        total: 510,
      },
    ]);
  });
});
