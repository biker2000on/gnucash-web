/**
 * Financial Goals Engine
 *
 * Pure progress + projection math for the Financial Goals Tracker. No
 * database access here — data loading lives in `goal.service.ts` so this
 * module stays fully unit-testable.
 *
 * Three goal types are supported:
 * - emergency_fund: accumulate N months of expenses (target resolved from
 *   the monthly expense run-rate × target_months).
 * - savings_target: accumulate a fixed dollar amount by an optional date.
 * - debt_payoff:    pay a tracked liability down to zero, projected with the
 *   shared debt amortization engine (`simulatePlan`).
 *
 * Projection model:
 * - Accumulation goals project completion from the effective monthly
 *   contribution (months = ceil(remaining / contribution)).
 * - Debt payoff goals project completion from the debt engine using the
 *   monthly contribution as the payment.
 * - "onTrack" compares the projected completion date against the target date.
 * - "monthlyNeededToHitDate" is the contribution/payment required to reach
 *   the goal exactly on the target date.
 */

import { toDateKey, parseLocalDate } from './forecast';
import { simulatePlan } from './debt-payoff';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type GoalType = 'emergency_fund' | 'savings_target' | 'debt_payoff';

export interface Goal {
    id: number;
    bookGuid: string | null;
    name: string;
    goalType: GoalType;
    /** Fixed dollar target (savings_target), or original balance baseline (debt_payoff). */
    targetAmount: number | null;
    /** Emergency fund: number of months of expenses to cover. */
    targetMonths: number | null;
    /** Optional target/payoff-by date (YYYY-MM-DD). */
    targetDate: string | null;
    /** Linked tracking/source account. */
    accountGuid: string | null;
    /** Planned monthly contribution (accumulation) or payment (debt_payoff). */
    monthlyContribution: number | null;
    createdAt: string;
}

export interface GoalContext {
    /**
     * Current amount toward the goal.
     * - accumulation goals: linked account balance (positive savings).
     * - debt_payoff goals: current amount owed (positive).
     */
    currentAmount: number;
    /** Monthly expense run-rate, required to resolve emergency_fund targets. */
    monthlyExpense?: number;
    /**
     * Effective monthly contribution/payment. Falls back to the goal's own
     * monthlyContribution when omitted.
     */
    monthlyContribution?: number;
    /** Annual percentage rate for debt_payoff projection (default 0). */
    debtApr?: number;
    /** As-of date for projections (default: today, local midnight). */
    asOf?: Date;
}

export interface GoalProgress {
    id: number;
    name: string;
    goalType: GoalType;
    /** Current saved amount (accumulation) or amount owed (debt_payoff). */
    currentAmount: number;
    /** Resolved dollar target (emergency_fund → monthlyExpense × target_months). */
    targetAmount: number;
    /** Amount still to save, or still owed. */
    remainingAmount: number;
    /** 0..100. */
    progressPct: number;
    /** Effective monthly contribution/payment used for the projection. */
    monthlyContribution: number;
    /** Projected months to completion (null = never within the horizon). */
    projectedMonths: number | null;
    /** Projected completion date YYYY-MM-DD (null = never). */
    projectedCompletionDate: string | null;
    /** Copied through from the goal for the UI. */
    targetDate: string | null;
    /** True/false vs target date; null when no target date is set. */
    onTrack: boolean | null;
    /** Monthly amount needed to hit the target date (null = n/a or already met). */
    monthlyNeededToHitDate: number | null;
    /** Goal is already satisfied (met the target / debt paid off). */
    alreadyMet: boolean;
}

/* ------------------------------------------------------------------ */
/* Date + math helpers                                                 */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

function daysInMonth(year: number, monthIndex: number): number {
    return new Date(year, monthIndex + 1, 0).getDate();
}

/** Add a whole number of months to a date, clamping the day to month end. */
function addMonths(date: Date, months: number): Date {
    const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const target = new Date(base.getFullYear(), base.getMonth() + months, 1);
    const day = Math.min(base.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
    target.setDate(day);
    return target;
}

/**
 * Calendar months between two dates. Equal day-of-month → whole months;
 * a partial month contributes a day-based fraction (÷30).
 */
function monthsBetween(from: Date, to: Date): number {
    const whole = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    return whole + (to.getDate() - from.getDate()) / 30;
}

/** Standard amortization payment: M = P·r(1+r)^n / ((1+r)^n − 1). */
function amortizedPayment(principal: number, annualRatePct: number, months: number): number | null {
    if (!(principal > 0) || !(months > 0)) return null;
    const r = annualRatePct / 100 / 12;
    if (r <= 0) return principal / months;
    const rn = Math.pow(1 + r, months);
    return (principal * r * rn) / (rn - 1);
}

/* ------------------------------------------------------------------ */
/* Progress computation                                                */
/* ------------------------------------------------------------------ */

/** Resolve a goal's dollar target given the run-rate context. */
export function resolveTargetAmount(goal: Goal, context: Pick<GoalContext, 'monthlyExpense'>): number {
    if (goal.goalType === 'emergency_fund') {
        if (goal.targetMonths != null && context.monthlyExpense != null) {
            return round2(context.monthlyExpense * goal.targetMonths);
        }
        return round2(goal.targetAmount ?? 0);
    }
    // savings_target uses its explicit target; debt_payoff uses target_amount
    // as the original-balance baseline (0 = unknown baseline).
    return round2(goal.targetAmount ?? 0);
}

/**
 * Compute progress and projection for a single goal.
 */
export function computeGoalProgress(goal: Goal, context: GoalContext): GoalProgress {
    const asOf = context.asOf
        ? new Date(context.asOf.getFullYear(), context.asOf.getMonth(), context.asOf.getDate())
        : (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })();

    const monthlyContribution = Math.max(
        0,
        context.monthlyContribution ?? goal.monthlyContribution ?? 0
    );

    const targetDate = goal.targetDate;
    const target = resolveTargetAmount(goal, context);

    if (goal.goalType === 'debt_payoff') {
        return computeDebtProgress(goal, context, asOf, monthlyContribution, target);
    }
    return computeAccumulationProgress(goal, context, asOf, monthlyContribution, target, targetDate);
}

function computeAccumulationProgress(
    goal: Goal,
    context: GoalContext,
    asOf: Date,
    monthlyContribution: number,
    target: number,
    targetDate: string | null
): GoalProgress {
    const current = context.currentAmount;
    const remaining = Math.max(0, target - current);
    const alreadyMet = target <= 0 ? current >= 0 : current >= target;

    const progressPct = target > 0
        ? Math.min(100, Math.max(0, (current / target) * 100))
        : 100;

    let projectedMonths: number | null;
    let projectedCompletionDate: string | null;
    if (alreadyMet) {
        projectedMonths = 0;
        projectedCompletionDate = toDateKey(asOf);
    } else if (monthlyContribution <= 0) {
        // Never completes without contributions.
        projectedMonths = null;
        projectedCompletionDate = null;
    } else {
        projectedMonths = Math.ceil(remaining / monthlyContribution);
        projectedCompletionDate = toDateKey(addMonths(asOf, projectedMonths));
    }

    const { onTrack, monthlyNeededToHitDate } = evaluateAgainstTargetDate(
        targetDate,
        asOf,
        remaining,
        alreadyMet,
        projectedCompletionDate,
        null
    );

    return {
        id: goal.id,
        name: goal.name,
        goalType: goal.goalType,
        currentAmount: round2(current),
        targetAmount: round2(target),
        remainingAmount: round2(remaining),
        progressPct: round2(progressPct),
        monthlyContribution: round2(monthlyContribution),
        projectedMonths,
        projectedCompletionDate,
        targetDate,
        onTrack,
        monthlyNeededToHitDate,
        alreadyMet,
    };
}

function computeDebtProgress(
    goal: Goal,
    context: GoalContext,
    asOf: Date,
    monthlyContribution: number,
    baseline: number
): GoalProgress {
    const owed = Math.max(0, context.currentAmount);
    const apr = Math.max(0, context.debtApr ?? 0);
    const alreadyMet = owed <= 0;

    // Progress relative to the original-balance baseline when available.
    const progressPct = baseline > 0
        ? Math.min(100, Math.max(0, ((baseline - owed) / baseline) * 100))
        : (alreadyMet ? 100 : 0);

    let projectedMonths: number | null;
    let projectedCompletionDate: string | null;
    if (alreadyMet) {
        projectedMonths = 0;
        projectedCompletionDate = toDateKey(asOf);
    } else if (monthlyContribution <= 0) {
        projectedMonths = null;
        projectedCompletionDate = null;
    } else {
        // Reuse the shared amortization engine for a single debt.
        const plan = simulatePlan(
            [{ guid: goal.accountGuid ?? String(goal.id), name: goal.name, balance: owed, apr, minPayment: monthlyContribution }],
            0,
            'avalanche'
        );
        projectedMonths = plan.months;
        projectedCompletionDate = plan.months != null ? toDateKey(addMonths(asOf, plan.months)) : null;
    }

    const { onTrack, monthlyNeededToHitDate } = evaluateAgainstTargetDate(
        goal.targetDate,
        asOf,
        owed,
        alreadyMet,
        projectedCompletionDate,
        apr
    );

    return {
        id: goal.id,
        name: goal.name,
        goalType: goal.goalType,
        currentAmount: round2(owed),
        targetAmount: round2(baseline),
        remainingAmount: round2(owed),
        progressPct: round2(progressPct),
        monthlyContribution: round2(monthlyContribution),
        projectedMonths,
        projectedCompletionDate,
        targetDate: goal.targetDate,
        onTrack,
        monthlyNeededToHitDate,
        alreadyMet,
    };
}

/**
 * Evaluate a goal against its target date.
 *
 * @param debtApr - when non-null, "needed" is an amortized debt payment;
 *                  otherwise it is a straight-line savings contribution.
 */
function evaluateAgainstTargetDate(
    targetDate: string | null,
    asOf: Date,
    remaining: number,
    alreadyMet: boolean,
    projectedCompletionDate: string | null,
    debtApr: number | null
): { onTrack: boolean | null; monthlyNeededToHitDate: number | null } {
    if (!targetDate) {
        return { onTrack: null, monthlyNeededToHitDate: null };
    }
    if (alreadyMet) {
        return { onTrack: true, monthlyNeededToHitDate: 0 };
    }

    // On track when the projection lands on or before the target date.
    const onTrack = projectedCompletionDate != null && projectedCompletionDate <= targetDate;

    const monthsUntil = monthsBetween(asOf, parseLocalDate(targetDate));
    let monthlyNeededToHitDate: number | null;
    if (monthsUntil <= 0) {
        // Target date is here or past — the entire remainder is needed now.
        monthlyNeededToHitDate = round2(remaining);
    } else if (debtApr != null) {
        const payment = amortizedPayment(remaining, debtApr, monthsUntil);
        monthlyNeededToHitDate = payment != null ? round2(payment) : null;
    } else {
        monthlyNeededToHitDate = round2(remaining / monthsUntil);
    }

    return { onTrack, monthlyNeededToHitDate };
}
