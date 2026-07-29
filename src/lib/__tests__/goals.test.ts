import { describe, it, expect } from 'vitest';
import {
    completedEmergencyExpenseHistoryMonths,
    computeEmergencyExpenseRunRate,
    computeGoalProgress,
    emergencyExpenseHistoryWindow,
    isEmergencyFundExpensePath,
    resolveTargetAmount,
    type Goal,
    type GoalContext,
} from '@/lib/goals';

/** Fixed as-of date on the 15th so calendar-month math stays clean. */
const ASOF = new Date(2026, 0, 15); // 2026-01-15 local

function goal(overrides: Partial<Goal> & { goalType: Goal['goalType'] }): Goal {
    return {
        id: 1,
        bookGuid: 'book',
        name: 'Test Goal',
        targetAmount: null,
        targetMonths: null,
        targetDate: null,
        accountGuid: null,
        monthlyContribution: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function ctx(overrides: Partial<GoalContext> & { currentAmount: number }): GoalContext {
    return { asOf: ASOF, ...overrides };
}

describe('goals engine', () => {
    describe('emergency fund target resolution', () => {
        it('resolves target from months × monthly expense', () => {
            const g = goal({ goalType: 'emergency_fund', targetMonths: 3 });
            expect(resolveTargetAmount(g, { monthlyExpense: 2000 })).toBe(6000);
        });

        it('computes progress against the resolved target', () => {
            const g = goal({ goalType: 'emergency_fund', targetMonths: 3 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 3000, monthlyExpense: 2000 }));
            expect(p.targetAmount).toBe(6000);
            expect(p.progressPct).toBe(50);
            expect(p.remainingAmount).toBe(3000);
            expect(p.alreadyMet).toBe(false);
        });

        it('falls back to target_amount when the expense run-rate is unavailable', () => {
            const g = goal({ goalType: 'emergency_fund', targetMonths: 3, targetAmount: 5000 });
            expect(resolveTargetAmount(g, {})).toBe(5000);
            expect(resolveTargetAmount(g, { monthlyExpense: 0 })).toBe(5000);
        });

        it('excludes taxes, payroll deductions, savings, and investments', () => {
            const expenseByAccount = new Map([
                ['rent', 18_000],
                ['federal', 24_000],
                ['fica', 8_000],
                ['investing', 12_000],
                ['refund', -500],
            ]);
            const paths = new Map([
                ['rent', 'Expenses:Housing:Rent'],
                ['federal', 'Expenses:Taxes:Federal Income Tax'],
                ['fica', 'Expenses:Taxes:FICA:Social Security'],
                ['investing', 'Expenses:Savings:Brokerage Investment'],
                ['refund', 'Expenses:Medical:Reimbursements'],
            ]);

            const runRate = computeEmergencyExpenseRunRate(expenseByAccount, paths, 12);
            expect(runRate).toEqual({
                monthlyExpense: 1500,
                includedTotal: 18_000,
                excludedTotal: 44_000,
                historyMonths: 12,
            });
            expect(resolveTargetAmount(
                goal({ goalType: 'emergency_fund', targetMonths: 2 }),
                { monthlyExpense: runRate.monthlyExpense }
            )).toBe(3000);
        });

        it('includes unknown expense categories rather than silently underfunding', () => {
            expect(isEmergencyFundExpensePath('Expenses:Unusual Household Cost')).toBe(true);
            expect(isEmergencyFundExpensePath('Expenses:Insurance:Medicare Premiums')).toBe(true);
            expect(isEmergencyFundExpensePath('')).toBe(true);
        });

        it('uses completed calendar months and caps long histories at twelve months', () => {
            const asOf = new Date(2026, 6, 28);
            const window = emergencyExpenseHistoryWindow(asOf, 12);

            expect(window.start).toEqual(new Date(2025, 6, 1));
            expect(window.endExclusive).toEqual(new Date(2026, 6, 1));
            expect(window.end).toEqual(new Date(2026, 5, 30, 23, 59, 59, 999));
            expect(completedEmergencyExpenseHistoryMonths(
                new Date(2024, 0, 10),
                window.endExclusive,
                12
            )).toBe(12);
            expect(completedEmergencyExpenseHistoryMonths(
                new Date(2026, 3, 12),
                window.endExclusive,
                12
            )).toBe(3);
        });

        it('returns no run rate when there are no completed months', () => {
            const result = computeEmergencyExpenseRunRate(
                new Map([['rent', 2000]]),
                new Map([['rent', 'Expenses:Rent']]),
                0
            );
            expect(result.monthlyExpense).toBe(0);
            expect(completedEmergencyExpenseHistoryMonths(null, new Date(2026, 6, 1))).toBe(0);
        });
    });

    describe('savings target progress %', () => {
        it('computes progress percentage', () => {
            const g = goal({ goalType: 'savings_target', targetAmount: 10000 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            expect(p.progressPct).toBe(40);
            expect(p.remainingAmount).toBe(6000);
        });

        it('clamps progress to 100 when over target', () => {
            const g = goal({ goalType: 'savings_target', targetAmount: 10000 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 12000 }));
            expect(p.progressPct).toBe(100);
            expect(p.alreadyMet).toBe(true);
        });
    });

    describe('projected completion from contribution rate', () => {
        it('projects months and date from the monthly contribution', () => {
            const g = goal({ goalType: 'savings_target', targetAmount: 10000, monthlyContribution: 1000 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            // remaining 6000 / 1000 = 6 months from 2026-01-15
            expect(p.projectedMonths).toBe(6);
            expect(p.projectedCompletionDate).toBe('2026-07-15');
        });

        it('rounds partial months up', () => {
            const g = goal({ goalType: 'savings_target', targetAmount: 10000, monthlyContribution: 900 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            // 6000 / 900 = 6.67 -> 7 months
            expect(p.projectedMonths).toBe(7);
            expect(p.projectedCompletionDate).toBe('2026-08-15');
        });
    });

    describe('on-track vs behind vs target date', () => {
        it('is on track when projected completion lands on/before the target date', () => {
            const g = goal({
                goalType: 'savings_target',
                targetAmount: 10000,
                monthlyContribution: 1000,
                targetDate: '2026-07-15',
            });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            expect(p.onTrack).toBe(true);
            expect(p.monthlyNeededToHitDate).toBe(1000); // 6000 / 6 months
        });

        it('is behind when the contribution is too small', () => {
            const g = goal({
                goalType: 'savings_target',
                targetAmount: 10000,
                monthlyContribution: 500,
                targetDate: '2026-07-15',
            });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            // 6000 / 500 = 12 months -> 2027-01-15, past target
            expect(p.projectedCompletionDate).toBe('2027-01-15');
            expect(p.onTrack).toBe(false);
            expect(p.monthlyNeededToHitDate).toBe(1000);
        });

        it('leaves onTrack null when no target date is set', () => {
            const g = goal({ goalType: 'savings_target', targetAmount: 10000, monthlyContribution: 1000 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            expect(p.onTrack).toBeNull();
            expect(p.monthlyNeededToHitDate).toBeNull();
        });
    });

    describe('already met', () => {
        it('reports 100%, zero months, and on-track', () => {
            const g = goal({
                goalType: 'savings_target',
                targetAmount: 10000,
                monthlyContribution: 1000,
                targetDate: '2026-07-15',
            });
            const p = computeGoalProgress(g, ctx({ currentAmount: 10000 }));
            expect(p.alreadyMet).toBe(true);
            expect(p.progressPct).toBe(100);
            expect(p.projectedMonths).toBe(0);
            expect(p.projectedCompletionDate).toBe('2026-01-15');
            expect(p.onTrack).toBe(true);
            expect(p.monthlyNeededToHitDate).toBe(0);
        });
    });

    describe('zero contribution never completes', () => {
        it('has no projected completion when not yet met', () => {
            const g = goal({
                goalType: 'savings_target',
                targetAmount: 10000,
                monthlyContribution: 0,
                targetDate: '2026-07-15',
            });
            const p = computeGoalProgress(g, ctx({ currentAmount: 4000 }));
            expect(p.projectedMonths).toBeNull();
            expect(p.projectedCompletionDate).toBeNull();
            expect(p.onTrack).toBe(false);
            // Needed amount is still computable from the target date.
            expect(p.monthlyNeededToHitDate).toBe(1000);
        });
    });

    describe('debt payoff via the debt engine', () => {
        it('projects payoff month using amortization', () => {
            const g = goal({
                goalType: 'debt_payoff',
                targetAmount: 2000, // original-balance baseline
                monthlyContribution: 100,
                accountGuid: 'a'.repeat(32),
            });
            const p = computeGoalProgress(g, ctx({ currentAmount: 1000, debtApr: 12 }));
            // $1,000 at 12% APR, $100/mo -> 11 months (hand-verified in debt-payoff tests)
            expect(p.projectedMonths).toBe(11);
            expect(p.projectedCompletionDate).toBe('2026-12-15');
            // Progress relative to the 2000 baseline: (2000-1000)/2000 = 50%
            expect(p.progressPct).toBe(50);
            expect(p.remainingAmount).toBe(1000);
            expect(p.alreadyMet).toBe(false);
        });

        it('marks a paid-off debt as already met', () => {
            const g = goal({ goalType: 'debt_payoff', targetAmount: 2000, monthlyContribution: 100 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 0, debtApr: 12 }));
            expect(p.alreadyMet).toBe(true);
            expect(p.progressPct).toBe(100);
            expect(p.projectedMonths).toBe(0);
        });

        it('never pays off with a zero payment', () => {
            const g = goal({ goalType: 'debt_payoff', targetAmount: 2000, monthlyContribution: 0 });
            const p = computeGoalProgress(g, ctx({ currentAmount: 1000, debtApr: 12 }));
            expect(p.projectedMonths).toBeNull();
            expect(p.projectedCompletionDate).toBeNull();
        });
    });
});
