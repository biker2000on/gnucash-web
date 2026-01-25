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

    // Transform to include computed decimals
    return serializeBigInts({
      ...budget,
      amounts: budget.amounts.map(amount => ({
        ...amount,
        amount_decimal: toDecimal(amount.amount_num, amount.amount_denom),
        account_name: amount.account.name,
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
    if (periodNum < 1 || periodNum > budget.num_periods) {
      throw new Error(`Period must be between 1 and ${budget.num_periods}`);
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
}

export default BudgetService;
