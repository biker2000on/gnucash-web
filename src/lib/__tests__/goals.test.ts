import { describe, it, expect } from 'vitest';
import {
    computeGoalProgress,
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
