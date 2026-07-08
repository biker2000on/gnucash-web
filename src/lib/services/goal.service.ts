/**
 * Financial Goals Service
 *
 * Lazy-created table (`gnucash_web_goals`) following the advisory-lock
 * pattern from `notifications.ts`, plus book-scoped CRUD and a
 * progress-enriched read that gathers the projection context (current
 * savings, monthly expense run-rate, tracking-account balances) and runs
 * the pure engine in `goals.ts` for each goal.
 */

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { toDecimal } from '@/lib/gnucash';
import { getBaseCurrency } from '@/lib/currency';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import { computeDailyRunRates } from '@/lib/forecast';
import {
    computeGoalProgress,
    type Goal,
    type GoalType,
    type GoalProgress,
} from '@/lib/goals';

/** Goal types the API/UI accept. */
export const GOAL_TYPES: GoalType[] = ['emergency_fund', 'savings_target', 'debt_payoff'];

/** Trailing window (months) used for the monthly expense + contribution run-rate. */
const RUN_RATE_MONTHS = 3;
const DAYS_PER_MONTH = 365.25 / 12;

export interface GoalInput {
    name: string;
    goalType: GoalType;
    targetAmount?: number | null;
    targetMonths?: number | null;
    targetDate?: string | null;
    accountGuid?: string | null;
    monthlyContribution?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + normalize an untrusted request body into a GoalInput.
 * Returns an error string when invalid.
 */
export function parseGoalBody(body: unknown): { input: GoalInput } | { error: string } {
    if (!body || typeof body !== 'object') return { error: 'Invalid request body' };
    const b = body as Record<string, unknown>;

    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return { error: 'Name is required' };
    if (name.length > 255) return { error: 'Name is too long' };

    const goalType = b.goalType as GoalType;
    if (!GOAL_TYPES.includes(goalType)) {
        return { error: `Invalid goal type. Must be one of: ${GOAL_TYPES.join(', ')}` };
    }

    const num = (v: unknown): number | null => {
        if (v == null || v === '') return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        return Number.isFinite(n) ? n : NaN;
    };

    const targetAmount = num(b.targetAmount);
    const targetMonths = num(b.targetMonths);
    const monthlyContribution = num(b.monthlyContribution);
    if ([targetAmount, targetMonths, monthlyContribution].some(v => Number.isNaN(v))) {
        return { error: 'Numeric fields must be valid numbers' };
    }
    if ((targetAmount ?? 0) < 0 || (targetMonths ?? 0) < 0 || (monthlyContribution ?? 0) < 0) {
        return { error: 'Numeric fields cannot be negative' };
    }

    let targetDate: string | null = null;
    if (b.targetDate != null && b.targetDate !== '') {
        if (typeof b.targetDate !== 'string' || !DATE_RE.test(b.targetDate)) {
            return { error: 'Target date must be YYYY-MM-DD' };
        }
        targetDate = b.targetDate;
    }

    const accountGuid = typeof b.accountGuid === 'string' && b.accountGuid ? b.accountGuid : null;

    // Type-specific requirements.
    if (goalType === 'emergency_fund' && targetMonths == null && targetAmount == null) {
        return { error: 'Emergency fund goals need a number of months (or a target amount)' };
    }
    if (goalType === 'savings_target' && targetAmount == null) {
        return { error: 'Savings goals need a target amount' };
    }

    return {
        input: {
            name,
            goalType,
            targetAmount,
            targetMonths,
            targetDate,
            accountGuid,
            monthlyContribution,
        },
    };
}

interface GoalRow {
    id: number;
    book_guid: string | null;
    name: string;
    goal_type: string;
    target_amount: unknown;
    target_months: unknown;
    target_date: Date | null;
    account_guid: string | null;
    monthly_contribution: unknown;
    created_at: Date;
}

let ensurePromise: Promise<void> | null = null;

/** Lazily create the goals table (advisory-lock guarded, idempotent). */
export function ensureGoalsTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_goals_schema'));

                    CREATE TABLE IF NOT EXISTS gnucash_web_goals (
                        id SERIAL PRIMARY KEY,
                        book_guid TEXT,
                        name TEXT NOT NULL,
                        goal_type TEXT NOT NULL,
                        target_amount NUMERIC,
                        target_months NUMERIC,
                        target_date DATE,
                        account_guid TEXT,
                        monthly_contribution NUMERIC,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );

                    CREATE INDEX IF NOT EXISTS idx_goals_book
                        ON gnucash_web_goals(book_guid);
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

function toNum(value: unknown): number | null {
    if (value == null) return null;
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(n) ? n : null;
}

function toDateString(value: Date | null): string | null {
    if (!value) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function mapRow(row: GoalRow): Goal {
    return {
        id: row.id,
        bookGuid: row.book_guid,
        name: row.name,
        goalType: row.goal_type as GoalType,
        targetAmount: toNum(row.target_amount),
        targetMonths: toNum(row.target_months),
        targetDate: toDateString(row.target_date),
        accountGuid: row.account_guid,
        monthlyContribution: toNum(row.monthly_contribution),
        createdAt: row.created_at.toISOString(),
    };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listGoals(bookGuid: string): Promise<Goal[]> {
    await ensureGoalsTable();
    const rows = await prisma.$queryRaw<GoalRow[]>`
        SELECT id, book_guid, name, goal_type, target_amount, target_months,
               target_date, account_guid, monthly_contribution, created_at
        FROM gnucash_web_goals
        WHERE book_guid = ${bookGuid}
        ORDER BY created_at DESC, id DESC
    `;
    return rows.map(mapRow);
}

export async function createGoal(bookGuid: string, input: GoalInput): Promise<Goal> {
    await ensureGoalsTable();
    const rows = await prisma.$queryRaw<GoalRow[]>`
        INSERT INTO gnucash_web_goals
            (book_guid, name, goal_type, target_amount, target_months,
             target_date, account_guid, monthly_contribution)
        VALUES (
            ${bookGuid},
            ${input.name},
            ${input.goalType},
            ${input.targetAmount ?? null},
            ${input.targetMonths ?? null},
            ${input.targetDate ? new Date(input.targetDate) : null},
            ${input.accountGuid ?? null},
            ${input.monthlyContribution ?? null}
        )
        RETURNING id, book_guid, name, goal_type, target_amount, target_months,
                  target_date, account_guid, monthly_contribution, created_at
    `;
    return mapRow(rows[0]);
}

export async function updateGoal(
    bookGuid: string,
    id: number,
    input: GoalInput
): Promise<Goal | null> {
    await ensureGoalsTable();
    const rows = await prisma.$queryRaw<GoalRow[]>`
        UPDATE gnucash_web_goals
        SET name = ${input.name},
            goal_type = ${input.goalType},
            target_amount = ${input.targetAmount ?? null},
            target_months = ${input.targetMonths ?? null},
            target_date = ${input.targetDate ? new Date(input.targetDate) : null},
            account_guid = ${input.accountGuid ?? null},
            monthly_contribution = ${input.monthlyContribution ?? null}
        WHERE id = ${id} AND book_guid = ${bookGuid}
        RETURNING id, book_guid, name, goal_type, target_amount, target_months,
                  target_date, account_guid, monthly_contribution, created_at
    `;
    return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function deleteGoal(bookGuid: string, id: number): Promise<boolean> {
    await ensureGoalsTable();
    const result = await prisma.$executeRaw`
        DELETE FROM gnucash_web_goals
        WHERE id = ${id} AND book_guid = ${bookGuid}
    `;
    return result > 0;
}

/* ------------------------------------------------------------------ */
/* Progress-enriched read                                              */
/* ------------------------------------------------------------------ */

export interface GoalWithProgress extends Goal {
    progress: GoalProgress;
}

/** Sum split quantities per account (raw GnuCash sign) up to `asOf`. */
async function loadAccountBalances(
    accountGuids: string[],
    asOf: Date
): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    if (accountGuids.length === 0) return balances;

    const rows = await prisma.$queryRaw<Array<{ account_guid: string; balance: unknown }>>`
        SELECT s.account_guid,
               SUM(CAST(s.quantity_num AS numeric) / NULLIF(s.quantity_denom, 0)) AS balance
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid IN (${Prisma.join(accountGuids)})
          AND t.post_date <= ${asOf}
        GROUP BY s.account_guid
    `;
    for (const row of rows) {
        const v = parseFloat(String(row.balance ?? '0'));
        balances.set(row.account_guid, Number.isFinite(v) ? v : 0);
    }
    return balances;
}

/** Trailing net-flow run-rate (monthly) per account, for implied contributions. */
async function loadMonthlyRunRates(
    accountGuids: string[],
    start: Date,
    end: Date,
    lookbackDays: number
): Promise<Map<string, number>> {
    const rates = new Map<string, number>();
    if (accountGuids.length === 0) return rates;

    const splits = await prisma.splits.findMany({
        where: {
            account_guid: { in: accountGuids },
            transaction: { post_date: { gt: start, lte: end } },
        },
        select: { account_guid: true, quantity_num: true, quantity_denom: true },
    });

    const flows = splits.map(s => ({
        accountGuid: s.account_guid,
        amount: parseFloat(toDecimal(s.quantity_num, s.quantity_denom)),
    }));
    const daily = computeDailyRunRates(flows, lookbackDays);
    for (const [guid, perDay] of Object.entries(daily)) {
        rates.set(guid, perDay * DAYS_PER_MONTH);
    }
    return rates;
}

/**
 * List goals for a book with computed progress + projections.
 * Gathers current savings, the monthly expense run-rate and per-account
 * balances, then runs the pure engine per goal.
 */
export async function getGoalsWithProgress(
    bookAccountGuids: string[],
    bookGuid: string
): Promise<GoalWithProgress[]> {
    const goals = await listGoals(bookGuid);
    if (goals.length === 0) return [];

    const now = new Date();
    const asOf = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lookbackDays = Math.round(RUN_RATE_MONTHS * DAYS_PER_MONTH);
    const lookbackStart = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() - lookbackDays);

    // Monthly expense run-rate (trailing window) via the shared summary service.
    const baseCurrency = await getBaseCurrency();
    const incomeExpense = await FinancialSummaryService.computeIncomeExpenses(
        bookAccountGuids,
        lookbackStart,
        now,
        baseCurrency
    );
    const monthlyExpense = incomeExpense.totalExpenses / RUN_RATE_MONTHS;

    const linkedGuids = [
        ...new Set(goals.map(g => g.accountGuid).filter((g): g is string => !!g)),
    ];
    const [balances, monthlyRunRates] = await Promise.all([
        loadAccountBalances(linkedGuids, now),
        loadMonthlyRunRates(linkedGuids, lookbackStart, now, lookbackDays),
    ]);

    return goals.map(goal => {
        const rawBalance = goal.accountGuid ? balances.get(goal.accountGuid) ?? 0 : 0;

        // Debt goals: current amount is the amount owed (positive = -credit sign).
        const currentAmount = goal.goalType === 'debt_payoff' ? -rawBalance : rawBalance;

        // Effective contribution: explicit plan, else the tracking account's
        // trailing net-inflow run-rate (absolute value for debt paydown).
        let monthlyContribution = goal.monthlyContribution ?? undefined;
        if (monthlyContribution == null && goal.accountGuid) {
            const rate = monthlyRunRates.get(goal.accountGuid);
            if (rate != null) {
                monthlyContribution = goal.goalType === 'debt_payoff' ? Math.abs(rate) : rate;
            }
        }

        const progress = computeGoalProgress(goal, {
            currentAmount,
            monthlyExpense,
            monthlyContribution,
            asOf,
        });

        return { ...goal, progress };
    });
}
