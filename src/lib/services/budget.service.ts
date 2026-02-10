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
   * Calculate average monthly spending from last N months
   */
  static async getHistoricalAverage(accountGuid: string, months: number = 12) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const splits = await prisma.splits.findMany({
      where: {
        account_guid: accountGuid,
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

    // Get account type to determine if we need to negate (income is stored negative)
    const account = await prisma.accounts.findUnique({
      where: { guid: accountGuid },
      select: { account_type: true },
    });

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
