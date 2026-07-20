/**
 * Budget Service
 *
 * Handles CRUD operations for GnuCash budgets
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { generateGuid, serializeBigInts, toDecimal } from '@/lib/gnucash';

// Validation schemas
export const CreateBudgetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048),
  description: z.string().max(2048).optional().default(''),
  num_periods: z.number().int().min(1).max(60).default(12),
});

export const UpdateBudgetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048).optional(),
  description: z.string().max(2048).optional(),
});

export type CreateBudgetInput = z.infer<typeof CreateBudgetSchema>;
export type UpdateBudgetInput = z.infer<typeof UpdateBudgetSchema>;

/**
 * Service class for budget operations
 */
export class BudgetService {
  /**
   * List all budgets
   */
  static async list() {
    const budgets = await prisma.budgets.findMany({
      include: {
        _count: {
          select: { amounts: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return serializeBigInts(budgets);
  }

  /**
   * Get a single budget with all amounts
   */
  static async getById(guid: string) {
    const budget = await prisma.budgets.findUnique({
      where: { guid },
      include: {
        recurrences: true,
        amounts: {
          include: {
            account: {
              include: {
                commodity: true,
              },
            },
          },
          orderBy: [
            { account: { name: 'asc' } },
            { period_num: 'asc' },
          ],
        },
      },
    });

    if (!budget) {
      return null;
    }

    // Transform to include computed decimals and hierarchy info
    const recurrence = budget.recurrences?.[0] || null;
    return serializeBigInts({
      ...budget,
      recurrence: recurrence ? {
        period_type: recurrence.recurrence_period_type,
        mult: recurrence.recurrence_mult,
        period_start: recurrence.recurrence_period_start,
      } : null,
      amounts: budget.amounts.map(amount => ({
        ...amount,
        amount_decimal: toDecimal(amount.amount_num, amount.amount_denom),
        account_name: amount.account.name,
        account_parent_guid: amount.account.parent_guid,
        commodity_mnemonic: amount.account.commodity?.mnemonic,
      })),
    });
  }

  /**
   * Create a new budget
   */
  static async create(input: CreateBudgetInput) {
    const data = CreateBudgetSchema.parse(input);

    const budgetGuid = generateGuid();

    const budget = await prisma.budgets.create({
      data: {
        guid: budgetGuid,
        name: data.name,
        description: data.description || null,
        num_periods: data.num_periods,
      },
    });

    return serializeBigInts(budget);
  }

  /**
   * Update a budget
   */
  static async update(guid: string, input: UpdateBudgetInput) {
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid budget GUID');
    }

    const data = UpdateBudgetSchema.parse(input);

    // Check budget exists
    const existing = await prisma.budgets.findUnique({
      where: { guid },
    });

    if (!existing) {
      throw new Error(`Budget not found: ${guid}`);
    }

    const budget = await prisma.budgets.update({
      where: { guid },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
      },
    });

    return serializeBigInts(budget);
  }

  /**
   * Delete a budget and its amounts
   */
  static async delete(guid: string) {
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid budget GUID');
    }

    // Check budget exists
    const existing = await prisma.budgets.findUnique({
      where: { guid },
    });

    if (!existing) {
      throw new Error(`Budget not found: ${guid}`);
    }

    // Delete budget (amounts cascade due to onDelete: Cascade)
    await prisma.budgets.delete({
      where: { guid },
    });

    return { success: true, guid };
  }

  /**
   * Update a budget amount for a specific account and period
   */
  static async setAmount(
    budgetGuid: string,
    accountGuid: string,
    periodNum: number,
    amount: number
  ) {
    // Validate inputs
    if (!budgetGuid || budgetGuid.length !== 32) {
      throw new Error('Invalid budget GUID');
    }
    if (!accountGuid || accountGuid.length !== 32) {
      throw new Error('Invalid account GUID');
    }

    // Check budget exists
    const budget = await prisma.budgets.findUnique({
      where: { guid: budgetGuid },
    });

    if (!budget) {
      throw new Error(`Budget not found: ${budgetGuid}`);
    }

    // Validate period number
    if (periodNum < 0 || periodNum >= budget.num_periods) {
      throw new Error(`Period must be between 0 and ${budget.num_periods - 1}`);
    }

    // Check account exists
    const account = await prisma.accounts.findUnique({
      where: { guid: accountGuid },
    });

    if (!account) {
      throw new Error(`Account not found: ${accountGuid}`);
    }

    // Upsert the amount
    const amountNum = BigInt(Math.round(amount * 100));
    const amountDenom = BigInt(100);

    const budgetAmount = await prisma.budget_amounts.upsert({
      where: {
        budget_guid_account_guid_period_num: {
          budget_guid: budgetGuid,
          account_guid: accountGuid,
          period_num: periodNum,
        },
      },
      update: {
        amount_num: amountNum,
        amount_denom: amountDenom,
      },
      create: {
        budget_guid: budgetGuid,
        account_guid: accountGuid,
        period_num: periodNum,
        amount_num: amountNum,
        amount_denom: amountDenom,
      },
      include: {
        account: true,
      },
    });

    return serializeBigInts({
      ...budgetAmount,
      amount_decimal: toDecimal(budgetAmount.amount_num, budgetAmount.amount_denom),
    });
  }

  /**
   * Add an account to a budget with zero amounts for all periods
   */
  static async addAccount(budgetGuid: string, accountGuid: string) {
    // Get the budget to know num_periods
    const budget = await prisma.budgets.findUnique({
      where: { guid: budgetGuid },
      select: { num_periods: true },
    });
    if (!budget) throw new Error('Budget not found');

    // Check account exists and is not already in budget
    const existingAmounts = await prisma.budget_amounts.findFirst({
      where: { budget_guid: budgetGuid, account_guid: accountGuid },
    });
    if (existingAmounts) throw new Error('Account already in budget');

    // Create amounts for all periods with 0 value
    const amounts = [];
    for (let period = 0; period < budget.num_periods; period++) {
      const amount = await prisma.budget_amounts.create({
        data: {
          budget_guid: budgetGuid,
          account_guid: accountGuid,
          period_num: period,
          amount_num: 0n,
          amount_denom: 100n,
        },
      });
      amounts.push(amount);
    }
    return serializeBigInts(amounts);
  }

  /**
   * Delete all budget amounts for a specific account
   */
  static async deleteAccountAmounts(budgetGuid: string, accountGuid: string) {
    const result = await prisma.budget_amounts.deleteMany({
      where: {
        budget_guid: budgetGuid,
        account_guid: accountGuid,
      },
    });
    return result.count;
  }

  /**
   * Set the same amount for all periods of an account
   */
  static async setAllPeriods(
    budgetGuid: string,
    accountGuid: string,
    amount: number
  ) {
    const budget = await prisma.budgets.findUnique({
      where: { guid: budgetGuid },
      select: { num_periods: true },
    });
    if (!budget) throw new Error('Budget not found');

    const amounts = [];
    for (let period = 0; period < budget.num_periods; period++) {
      const result = await this.setAmount(budgetGuid, accountGuid, period, amount);
      amounts.push(result);
    }
    return amounts;
  }

  /**
   * Create a budget together with a monthly recurrence and bulk per-period
   * amounts in a single transaction. Used by budget generation (uniform
   * amounts across periods) and scenario duplication (per-period amounts).
   *
   * Each line's `amounts` array is indexed by period_num; shorter arrays are
   * zero-filled, longer ones truncated to num_periods. Rows are written for
   * every period (including zeros) so the account is part of the budget.
   */
  static async createWithAmounts(input: {
    name: string;
    description?: string;
    num_periods: number;
    /** YYYY-MM-DD start of period 0; creates a monthly recurrence when set */
    period_start?: string;
    lines: Array<{ accountGuid: string; amounts: number[] }>;
  }) {
    const base = CreateBudgetSchema.parse({
      name: input.name,
      description: input.description ?? '',
      num_periods: input.num_periods,
    });

    const budgetGuid = generateGuid();

    const rows: Array<{
      budget_guid: string;
      account_guid: string;
      period_num: number;
      amount_num: bigint;
      amount_denom: bigint;
    }> = [];
    for (const line of input.lines) {
      if (!line.accountGuid || line.accountGuid.length !== 32) {
        throw new Error(`Invalid account GUID: ${line.accountGuid}`);
      }
      for (let period = 0; period < base.num_periods; period++) {
        const amount = line.amounts[period] ?? 0;
        rows.push({
          budget_guid: budgetGuid,
          account_guid: line.accountGuid,
          period_num: period,
          amount_num: BigInt(Math.round(amount * 100)),
          amount_denom: 100n,
        });
      }
    }

    const budget = await prisma.$transaction(async tx => {
      const created = await tx.budgets.create({
        data: {
          guid: budgetGuid,
          name: base.name,
          description: base.description || null,
          num_periods: base.num_periods,
        },
      });
      if (input.period_start) {
        await tx.recurrences.create({
          data: {
            obj_guid: budgetGuid,
            recurrence_mult: 1,
            recurrence_period_type: 'month',
            recurrence_period_start: new Date(`${input.period_start}T00:00:00.000Z`),
            recurrence_weekend_adjust: 'none',
          },
        });
      }
      if (rows.length > 0) {
        await tx.budget_amounts.createMany({ data: rows });
      }
      return created;
    });

    return serializeBigInts(budget);
  }

  /**
   * Calculate average monthly spending from last N months
   */
  static async getHistoricalAverage(accountGuid: string, months: number = 12) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setUTCMonth(startDate.getUTCMonth() - months);

    // Get the root account's type (income is stored negative). The subtree of
    // an income parent is all income and an expense parent all expense, so the
    // root type is the correct sign for the whole roll-up.
    const account = await prisma.accounts.findUnique({
      where: { guid: accountGuid },
      select: { account_type: true },
    });

    // Roll up the account AND all descendants: parent accounts rarely hold
    // splits directly — the activity lives on their leaf children. Without the
    // subtree walk, estimating on a parent (now budgetable in the all-accounts
    // view) returns ~0. Walk the hierarchy to collect every account guid.
    const subtree = await prisma.$queryRaw<Array<{ guid: string }>>`
      WITH RECURSIVE subtree AS (
        SELECT guid FROM accounts WHERE guid = ${accountGuid}
        UNION ALL
        SELECT a.guid FROM accounts a
        JOIN subtree s ON a.parent_guid = s.guid
      )
      SELECT guid FROM subtree
    `;
    const accountGuids = subtree.map((row) => row.guid);

    const splits = await prisma.splits.findMany({
      where: {
        account_guid: { in: accountGuids },
        transaction: {
          post_date: {
            gte: startDate,
            lte: endDate,
          },
        },
      },
      select: {
        quantity_num: true,
        quantity_denom: true,
      },
    });

    const total = splits.reduce((sum, split) => {
      const value = split.quantity_denom
        ? Number(split.quantity_num) / Number(split.quantity_denom)
        : 0;
      return sum + value;
    }, 0);

    const adjustedTotal = account?.account_type === 'INCOME' ? -total : total;
    const average = adjustedTotal / months;

    return {
      average: Math.round(average * 100) / 100,
      total: Math.round(adjustedTotal * 100) / 100,
      transactionCount: splits.length,
    };
  }
}

export default BudgetService;
