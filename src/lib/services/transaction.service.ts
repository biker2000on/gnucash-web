/**
 * Transaction Service
 *
 * Handles CRUD operations for GnuCash transactions with:
 * - Double-entry validation (splits must sum to zero)
 * - Atomic operations (transaction and splits created together)
 * - GnuCash-compatible GUID generation
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { generateGuid, toDecimal } from '@/lib/gnucash';
import { Prisma } from '@prisma/client';

// Validation schemas - using num/denom format for API compatibility
export const SplitInputSchema = z.object({
  account_guid: z.string().length(32, 'Invalid account GUID'),
  value_num: z.number().int(), // Numerator (e.g., 10050 for $100.50)
  value_denom: z.number().int().positive(), // Denominator (e.g., 100)
  quantity_num: z.number().int().optional(), // For multi-currency/investment
  quantity_denom: z.number().int().positive().optional(),
  memo: z.string().max(2048).optional().default(''),
  action: z.string().max(2048).optional().default(''),
  reconcile_state: z.enum(['n', 'c', 'y']).optional().default('n'),
});

export const CreateTransactionSchema = z.object({
  currency_guid: z.string().length(32, 'Invalid currency GUID'),
  post_date: z.string().or(z.date()).transform(val => new Date(val)),
  description: z.string().max(2048).optional().default(''),
  num: z.string().max(2048).optional().default(''),
  splits: z.array(SplitInputSchema).min(2, 'Transaction must have at least 2 splits'),
});

export const UpdateTransactionSchema = CreateTransactionSchema.extend({
  guid: z.string().length(32, 'Invalid transaction GUID'),
});

export type SplitInput = z.infer<typeof SplitInputSchema>;
export type CreateTransactionInput = z.infer<typeof CreateTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof UpdateTransactionSchema>;

/**
 * Validates that splits sum to zero (double-entry accounting)
 */
function validateSplitsBalance(splits: SplitInput[]): void {
  const total = splits.reduce((sum, split) => {
    const value = split.value_num / split.value_denom;
    return sum + value;
  }, 0);
  // Allow for floating point imprecision (within 0.001)
  if (Math.abs(total) > 0.001) {
    throw new Error(`Transaction splits must sum to zero. Current sum: ${total.toFixed(2)}`);
  }
}

/**
 * Service class for transaction operations
 */
export class TransactionService {
  /**
   * Create a new transaction with splits
   */
  static async create(input: CreateTransactionInput) {
    // Validate input
    const data = CreateTransactionSchema.parse(input);

    // Validate double-entry
    validateSplitsBalance(data.splits);

    // Generate GUIDs
    const transactionGuid = generateGuid();
    const now = new Date();

    // Create transaction and splits atomically
    const transaction = await prisma.$transaction(async (tx) => {
      // Create transaction
      const newTransaction = await tx.transactions.create({
        data: {
          guid: transactionGuid,
          currency_guid: data.currency_guid,
          num: data.num,
          post_date: data.post_date,
          enter_date: now,
          description: data.description,
        },
      });

      // Create splits
      await tx.splits.createMany({
        data: data.splits.map((split) => ({
          guid: generateGuid(),
          tx_guid: transactionGuid,
          account_guid: split.account_guid,
          memo: split.memo || '',
          action: split.action || '',
          reconcile_state: split.reconcile_state || 'n',
          reconcile_date: null,
          value_num: BigInt(split.value_num),
          value_denom: BigInt(split.value_denom),
          quantity_num: BigInt(split.quantity_num ?? split.value_num),
          quantity_denom: BigInt(split.quantity_denom ?? split.value_denom),
          lot_guid: null,
        })),
      });

      // Return transaction with splits
      return tx.transactions.findUnique({
        where: { guid: transactionGuid },
        include: {
          splits: {
            include: {
              account: true,
            },
          },
        },
      });
    });

    return transaction;
  }

  /**
   * Update an existing transaction
   * Replaces all splits with new ones
   */
  static async update(input: UpdateTransactionInput) {
    // Validate input
    const data = UpdateTransactionSchema.parse(input);

    // Validate double-entry
    validateSplitsBalance(data.splits);

    // Check transaction exists
    const existing = await prisma.transactions.findUnique({
      where: { guid: data.guid },
      include: { splits: true },
    });

    if (!existing) {
      throw new Error(`Transaction not found: ${data.guid}`);
    }

    // Check for reconciled splits
    const hasReconciled = existing.splits.some(s => s.reconcile_state === 'y');
    if (hasReconciled) {
      throw new Error('Cannot modify transaction with reconciled splits. Unreconcile first.');
    }

    // Update transaction and replace splits atomically
    const transaction = await prisma.$transaction(async (tx) => {
      // Delete existing splits
      await tx.splits.deleteMany({
        where: { tx_guid: data.guid },
      });

      // Update transaction
      await tx.transactions.update({
        where: { guid: data.guid },
        data: {
          currency_guid: data.currency_guid,
          num: data.num,
          post_date: data.post_date,
          description: data.description,
        },
      });

      // Create new splits
      await tx.splits.createMany({
        data: data.splits.map((split) => ({
          guid: generateGuid(),
          tx_guid: data.guid,
          account_guid: split.account_guid,
          memo: split.memo || '',
          action: split.action || '',
          reconcile_state: split.reconcile_state || 'n',
          reconcile_date: null,
          value_num: BigInt(split.value_num),
          value_denom: BigInt(split.value_denom),
          quantity_num: BigInt(split.quantity_num ?? split.value_num),
          quantity_denom: BigInt(split.quantity_denom ?? split.value_denom),
          lot_guid: null,
        })),
      });

      // Return updated transaction
      return tx.transactions.findUnique({
        where: { guid: data.guid },
        include: {
          splits: {
            include: {
              account: true,
            },
          },
        },
      });
    });

    return transaction;
  }

  /**
   * Delete a transaction and its splits
   */
  static async delete(guid: string) {
    // Validate GUID format
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid transaction GUID');
    }

    // Check transaction exists
    const existing = await prisma.transactions.findUnique({
      where: { guid },
      include: { splits: true },
    });

    if (!existing) {
      throw new Error(`Transaction not found: ${guid}`);
    }

    // Check for reconciled splits
    const hasReconciled = existing.splits.some(s => s.reconcile_state === 'y');
    if (hasReconciled) {
      throw new Error('Cannot delete transaction with reconciled splits. Unreconcile first.');
    }

    // Delete transaction and splits atomically
    await prisma.$transaction(async (tx) => {
      // Delete splits first (due to foreign key)
      await tx.splits.deleteMany({
        where: { tx_guid: guid },
      });

      // Delete transaction
      await tx.transactions.delete({
        where: { guid },
      });
    });

    return { success: true, guid };
  }

  /**
   * Get a single transaction by GUID with full details
   */
  static async getById(guid: string) {
    const transaction = await prisma.transactions.findUnique({
      where: { guid },
      include: {
        currency: true,
        splits: {
          include: {
            account: {
              include: {
                commodity: true,
              },
            },
          },
        },
      },
    });

    if (!transaction) {
      return null;
    }

    // Transform to include computed decimals
    return {
      ...transaction,
      splits: transaction.splits.map(split => ({
        ...split,
        value_decimal: toDecimal(split.value_num, split.value_denom),
        quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
        account_name: split.account.name,
        commodity_mnemonic: split.account.commodity?.mnemonic,
      })),
    };
  }

  /**
   * List transactions with optional filtering and pagination
   */
  static async list(options: {
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    search?: string;
    accountTypes?: string[];
    reconcileStates?: string[];
    minAmount?: number;
    maxAmount?: number;
  } = {}) {
    const {
      limit = 100,
      offset = 0,
      startDate,
      endDate,
      search,
      accountTypes,
      reconcileStates,
      minAmount,
      maxAmount,
    } = options;

    // Build where clause
    const where: Prisma.transactionsWhereInput = {};

    // Date filtering
    if (startDate || endDate) {
      where.post_date = {};
      if (startDate) where.post_date.gte = startDate;
      if (endDate) where.post_date.lte = endDate;
    }

    // Search filtering
    if (search) {
      where.OR = [
        { description: { contains: search, mode: 'insensitive' } },
        { num: { contains: search, mode: 'insensitive' } },
        {
          splits: {
            some: {
              account: {
                name: { contains: search, mode: 'insensitive' },
              },
            },
          },
        },
      ];
    }

    // Account type filtering
    if (accountTypes && accountTypes.length > 0) {
      where.splits = {
        some: {
          account: {
            account_type: { in: accountTypes },
          },
        },
      };
    }

    // Reconcile state filtering
    if (reconcileStates && reconcileStates.length > 0) {
      where.splits = {
        ...where.splits,
        some: {
          ...((where.splits as { some?: object })?.some || {}),
          reconcile_state: { in: reconcileStates },
        },
      };
    }

    const transactions = await prisma.transactions.findMany({
      where,
      include: {
        splits: {
          include: {
            account: {
              include: {
                commodity: true,
              },
            },
          },
        },
      },
      orderBy: { post_date: 'desc' },
      take: limit,
      skip: offset,
    });

    // Filter by amount if needed (post-query filtering)
    let filtered = transactions;
    if (minAmount !== undefined || maxAmount !== undefined) {
      filtered = transactions.filter(tx => {
        const amounts = tx.splits.map(s =>
          Math.abs(Number(s.value_num) / Number(s.value_denom))
        );
        const maxSplitAmount = Math.max(...amounts);

        if (minAmount !== undefined && maxSplitAmount < minAmount) return false;
        if (maxAmount !== undefined && maxSplitAmount > maxAmount) return false;
        return true;
      });
    }

    // Transform to include computed decimals
    return filtered.map(tx => ({
      ...tx,
      splits: tx.splits.map(split => ({
        ...split,
        value_decimal: toDecimal(split.value_num, split.value_denom),
        quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
        account_name: split.account.name,
        commodity_mnemonic: split.account.commodity?.mnemonic,
      })),
    }));
  }
}

export default TransactionService;
