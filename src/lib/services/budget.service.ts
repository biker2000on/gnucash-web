/**
 * Budget Service
 *
 * Handles CRUD operations for GnuCash budgets
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { generateGuid, serializeBigInts, toDecimal } from '@/lib/gnucash';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  createBudgetOwnership,
  isBudgetOwnedByBook,
} from '@/lib/budget-ownership';

// Validation schemas
export const CreateBudgetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048),
  description: z.string().max(2048).optional().default(''),
  num_periods: z.number().int().min(1).max(60).default(12),
  /** YYYY-MM-DD start of period 0; defaults to Jan 1 of the current year. */
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_type: z.enum(['month', 'year']).default('month'),
  mult: z.number().int().min(1).max(12).default(1),
});

export const UpdateBudgetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048).optional(),
  description: z.string().max(2048).optional(),
});

export type CreateBudgetInput = z.infer<typeof CreateBudgetSchema>;
export type UpdateBudgetInput = z.infer<typeof UpdateBudgetSchema>;

function assertGuid(guid: string, label: 'budget' | 'account'): void {
  if (!guid || guid.length !== 32) {
    throw new Error(`Invalid ${label} GUID`);
  }
}

async function assertAccountsBelongToBook(
  bookGuid: string,
  accountGuids: string[],
): Promise<void> {
  for (const accountGuid of accountGuids) {
    assertGuid(accountGuid, 'account');
  }

  const bookAccountGuids = new Set(await getAccountGuidsForBook(bookGuid));
  for (const accountGuid of accountGuids) {
    if (!bookAccountGuids.has(accountGuid)) {
      throw new Error(`Account not found: ${accountGuid}`);
    }
  }
}

/**
 * Service class for budget operations
 */
export class BudgetService {
  /**
   * List budgets explicitly owned by one book.
   */
  static async list(bookGuid: string) {
    const [ownershipRows, bookAccountGuids] = await Promise.all([
      prisma.gnucash_web_budget_ownership.findMany({
        where: { book_guid: bookGuid },
        select: { budget_guid: true },
      }),
      getAccountGuidsForBook(bookGuid),
    ]);
    const budgetGuids = ownershipRows.map((row) => row.budget_guid);
    if (budgetGuids.length === 0) return [];

    const budgets = await prisma.budgets.findMany({
      where: { guid: { in: budgetGuids } },
      include: {
        recurrences: true,
        _count: {
          select: {
            amounts: {
              where: { account_guid: { in: bookAccountGuids } },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return serializeBigInts(budgets);
  }

  /**
   * Get a single budget with all amounts
   */
  static async getById(bookGuid: string, guid: string) {
    assertGuid(guid, 'budget');
    if (!await isBudgetOwnedByBook(prisma, guid, bookGuid)) {
      return null;
    }
    const bookAccountGuids = await getAccountGuidsForBook(bookGuid);
    const bookAccountGuidSet = new Set(bookAccountGuids);

    const budget = await prisma.budgets.findUnique({
      where: { guid },
      include: {
        recurrences: true,
        amounts: {
          where: { account_guid: { in: bookAccountGuids } },
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
      // Keep a response-boundary check in addition to the SQL filter. This
      // fails closed even if a mocked/custom client or future query change
      // returns a corrupt cross-book amount row.
      amounts: budget.amounts
        .filter(amount => bookAccountGuidSet.has(amount.account_guid))
        .map(amount => ({
        ...amount,
        amount_decimal: toDecimal(amount.amount_num, amount.amount_denom),
        account_name: amount.account.name,
        account_parent_guid: amount.account.parent_guid,
        commodity_mnemonic: amount.account.commodity?.mnemonic,
        })),
    });
  }

  /**
   * Create a new budget. Always writes a recurrence row (GnuCash parity) —
   * the period calendar drives start dates, current-budget selection, and
   * seasonal estimates.
   */
  static async create(bookGuid: string, input: CreateBudgetInput) {
    const data = CreateBudgetSchema.parse(input);

    const budgetGuid = generateGuid();
    const periodStart = data.period_start ?? `${new Date().getUTCFullYear()}-01-01`;

    const budget = await prisma.$transaction(async tx => {
      const created = await tx.budgets.create({
        data: {
          guid: budgetGuid,
          name: data.name,
          description: data.description || null,
          num_periods: data.num_periods,
        },
      });
      await createBudgetOwnership(tx, budgetGuid, bookGuid);
      await tx.recurrences.create({
        data: {
          obj_guid: budgetGuid,
          recurrence_mult: data.mult,
          recurrence_period_type: data.period_type,
          recurrence_period_start: new Date(`${periodStart}T00:00:00.000Z`),
          recurrence_weekend_adjust: 'none',
        },
      });
      return created;
    });

    return serializeBigInts(budget);
  }

  /**
   * Update a budget
   */
  static async update(bookGuid: string, guid: string, input: UpdateBudgetInput) {
    assertGuid(guid, 'budget');

    const data = UpdateBudgetSchema.parse(input);

    const budget = await prisma.$transaction(async tx => {
      if (!await isBudgetOwnedByBook(tx, guid, bookGuid)) {
        throw new Error(`Budget not found: ${guid}`);
      }
      return tx.budgets.update({
        where: { guid },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description || null }),
        },
      });
    });

    return serializeBigInts(budget);
  }

  /**
   * Delete a budget and its amounts
   */
  static async delete(bookGuid: string, guid: string) {
    assertGuid(guid, 'budget');

    await prisma.$transaction(async tx => {
      if (!await isBudgetOwnedByBook(tx, guid, bookGuid)) {
        throw new Error(`Budget not found: ${guid}`);
      }

      // Amounts and ownership cascade from the budget. The native recurrence
      // FK is restrictive, so its rows must be removed first.
      await tx.recurrences.deleteMany({ where: { obj_guid: guid } });
      await tx.budgets.delete({ where: { guid } });
    });

    return { success: true, guid };
  }

  /**
   * Update a budget amount for a specific account and period
   */
  static async setAmount(
    bookGuid: string,
    budgetGuid: string,
    accountGuid: string,
    periodNum: number,
    amount: number
  ) {
    assertGuid(budgetGuid, 'budget');
    await assertAccountsBelongToBook(bookGuid, [accountGuid]);

    // Upsert the amount
    const amountNum = BigInt(Math.round(amount * 100));
    const amountDenom = BigInt(100);

    const budgetAmount = await prisma.$transaction(async tx => {
      if (!await isBudgetOwnedByBook(tx, budgetGuid, bookGuid)) {
        throw new Error(`Budget not found: ${budgetGuid}`);
      }
      const budget = await tx.budgets.findUnique({
        where: { guid: budgetGuid },
        select: { num_periods: true },
      });
      if (!budget) {
        throw new Error(`Budget not found: ${budgetGuid}`);
      }
      if (periodNum < 0 || periodNum >= budget.num_periods) {
        throw new Error(`Period must be between 0 and ${budget.num_periods - 1}`);
      }

      return tx.budget_amounts.upsert({
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
    });

    return serializeBigInts({
      ...budgetAmount,
      amount_decimal: toDecimal(budgetAmount.amount_num, budgetAmount.amount_denom),
    });
  }

  /**
   * Add an account to a budget with zero amounts for all periods
   */
  static async addAccount(bookGuid: string, budgetGuid: string, accountGuid: string) {
    assertGuid(budgetGuid, 'budget');
    await assertAccountsBelongToBook(bookGuid, [accountGuid]);

    const amounts = await prisma.$transaction(async tx => {
      if (!await isBudgetOwnedByBook(tx, budgetGuid, bookGuid)) {
        throw new Error(`Budget not found: ${budgetGuid}`);
      }
      const budget = await tx.budgets.findUnique({
        where: { guid: budgetGuid },
        select: { num_periods: true },
      });
      if (!budget) throw new Error(`Budget not found: ${budgetGuid}`);

      const existingAmounts = await tx.budget_amounts.findFirst({
        where: { budget_guid: budgetGuid, account_guid: accountGuid },
      });
      if (existingAmounts) throw new Error('Account already in budget');

      const created = [];
      for (let period = 0; period < budget.num_periods; period++) {
        created.push(await tx.budget_amounts.create({
          data: {
            budget_guid: budgetGuid,
            account_guid: accountGuid,
            period_num: period,
            amount_num: 0n,
            amount_denom: 100n,
          },
        }));
      }
      return created;
    });

    return serializeBigInts(amounts);
  }

  /**
   * Delete all budget amounts for a specific account
   */
  static async deleteAccountAmounts(
    bookGuid: string,
    budgetGuid: string,
    accountGuid: string,
  ) {
    assertGuid(budgetGuid, 'budget');
    await assertAccountsBelongToBook(bookGuid, [accountGuid]);

    const result = await prisma.$transaction(async tx => {
      if (!await isBudgetOwnedByBook(tx, budgetGuid, bookGuid)) {
        throw new Error(`Budget not found: ${budgetGuid}`);
      }
      return tx.budget_amounts.deleteMany({
        where: {
          budget_guid: budgetGuid,
          account_guid: accountGuid,
        },
      });
    });
    return result.count;
  }

  /**
   * Set every period of an account: a single flat amount, or one amount per
   * period (index = period_num, missing entries fill with 0). Amounts are raw
   * GnuCash-signed, same as setAmount.
   */
  static async setAllPeriods(
    bookGuid: string,
    budgetGuid: string,
    accountGuid: string,
    amount: number | number[]
  ) {
    assertGuid(budgetGuid, 'budget');
    await assertAccountsBelongToBook(bookGuid, [accountGuid]);

    const results = await prisma.$transaction(async tx => {
      if (!await isBudgetOwnedByBook(tx, budgetGuid, bookGuid)) {
        throw new Error(`Budget not found: ${budgetGuid}`);
      }
      const budget = await tx.budgets.findUnique({
        where: { guid: budgetGuid },
        select: { num_periods: true },
      });
      if (!budget) throw new Error(`Budget not found: ${budgetGuid}`);

      const periodAmounts = [];
      for (let period = 0; period < budget.num_periods; period++) {
        const numericAmount = Array.isArray(amount) ? (amount[period] ?? 0) : amount;
        const amountNum = BigInt(Math.round(numericAmount * 100));
        periodAmounts.push(await tx.budget_amounts.upsert({
          where: {
            budget_guid_account_guid_period_num: {
              budget_guid: budgetGuid,
              account_guid: accountGuid,
              period_num: period,
            },
          },
          update: {
            amount_num: amountNum,
            amount_denom: 100n,
          },
          create: {
            budget_guid: budgetGuid,
            account_guid: accountGuid,
            period_num: period,
            amount_num: amountNum,
            amount_denom: 100n,
          },
          include: { account: true },
        }));
      }
      return periodAmounts;
    });

    return serializeBigInts(results.map(result => ({
      ...result,
      amount_decimal: toDecimal(result.amount_num, result.amount_denom),
    })));
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
  static async createWithAmounts(bookGuid: string, input: {
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
    const accountGuids = [...new Set(input.lines.map(line => line.accountGuid))];
    await assertAccountsBelongToBook(bookGuid, accountGuids);

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
      await createBudgetOwnership(tx, budgetGuid, bookGuid);
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

}

export default BudgetService;
