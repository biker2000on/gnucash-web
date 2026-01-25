/**
 * Account Service
 *
 * Handles CRUD operations for GnuCash accounts with:
 * - GnuCash-compatible GUID generation
 * - Validation for account types and parent relationships
 * - Safe deletion with transaction checks
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { generateGuid, serializeBigInts } from '@/lib/gnucash';

// Valid GnuCash account types
const ACCOUNT_TYPES = [
  'ASSET',
  'BANK',
  'CASH',
  'CREDIT',
  'EQUITY',
  'EXPENSE',
  'INCOME',
  'LIABILITY',
  'MUTUAL',
  'PAYABLE',
  'RECEIVABLE',
  'ROOT',
  'STOCK',
  'TRADING',
] as const;

// Validation schemas
export const CreateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048),
  account_type: z.enum(ACCOUNT_TYPES),
  parent_guid: z.string().length(32, 'Invalid parent GUID').nullable(),
  commodity_guid: z.string().length(32, 'Invalid commodity GUID'),
  code: z.string().max(2048).optional().default(''),
  description: z.string().max(2048).optional().default(''),
  hidden: z.number().int().min(0).max(1).optional().default(0),
  placeholder: z.number().int().min(0).max(1).optional().default(0),
  commodity_scu: z.number().int().optional().default(100),
  non_std_scu: z.number().int().optional().default(0),
});

export const UpdateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048).optional(),
  code: z.string().max(2048).optional(),
  description: z.string().max(2048).optional(),
  hidden: z.number().int().min(0).max(1).optional(),
  placeholder: z.number().int().min(0).max(1).optional(),
});

export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;
export type UpdateAccountInput = z.infer<typeof UpdateAccountSchema>;

/**
 * Service class for account operations
 */
export class AccountService {
  /**
   * Create a new account
   */
  static async create(input: CreateAccountInput) {
    const data = CreateAccountSchema.parse(input);

    // Validate parent exists if provided
    if (data.parent_guid) {
      const parent = await prisma.accounts.findUnique({
        where: { guid: data.parent_guid },
      });
      if (!parent) {
        throw new Error(`Parent account not found: ${data.parent_guid}`);
      }
    }

    // Validate commodity exists
    const commodity = await prisma.commodities.findUnique({
      where: { guid: data.commodity_guid },
    });
    if (!commodity) {
      throw new Error(`Commodity not found: ${data.commodity_guid}`);
    }

    // Generate GUID and create account
    const accountGuid = generateGuid();

    const account = await prisma.accounts.create({
      data: {
        guid: accountGuid,
        name: data.name,
        account_type: data.account_type,
        parent_guid: data.parent_guid,
        commodity_guid: data.commodity_guid,
        code: data.code,
        description: data.description,
        hidden: data.hidden,
        placeholder: data.placeholder,
        commodity_scu: data.commodity_scu,
        non_std_scu: data.non_std_scu,
      },
      include: {
        commodity: true,
        parent: true,
      },
    });

    return serializeBigInts(account);
  }

  /**
   * Update an existing account
   * Only allows updating safe fields (not type or parent)
   */
  static async update(guid: string, input: UpdateAccountInput) {
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid account GUID');
    }

    const data = UpdateAccountSchema.parse(input);

    // Check account exists
    const existing = await prisma.accounts.findUnique({
      where: { guid },
    });

    if (!existing) {
      throw new Error(`Account not found: ${guid}`);
    }

    const account = await prisma.accounts.update({
      where: { guid },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.code !== undefined && { code: data.code }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.hidden !== undefined && { hidden: data.hidden }),
        ...(data.placeholder !== undefined && { placeholder: data.placeholder }),
      },
      include: {
        commodity: true,
        parent: true,
      },
    });

    return serializeBigInts(account);
  }

  /**
   * Delete an account
   * Only allowed if account has no transactions
   */
  static async delete(guid: string) {
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid account GUID');
    }

    // Check account exists
    const account = await prisma.accounts.findUnique({
      where: { guid },
      include: {
        _count: {
          select: { splits: true },
        },
        children: true,
      },
    });

    if (!account) {
      throw new Error(`Account not found: ${guid}`);
    }

    // Check for transactions
    if (account._count.splits > 0) {
      throw new Error(
        `Cannot delete account with ${account._count.splits} transactions. Move or delete transactions first.`
      );
    }

    // Check for child accounts
    if (account.children.length > 0) {
      throw new Error(
        `Cannot delete account with ${account.children.length} child accounts. Move or delete children first.`
      );
    }

    await prisma.accounts.delete({
      where: { guid },
    });

    return { success: true, guid };
  }

  /**
   * Get a single account by GUID with full details
   */
  static async getById(guid: string) {
    const account = await prisma.accounts.findUnique({
      where: { guid },
      include: {
        commodity: true,
        parent: true,
        _count: {
          select: { splits: true, children: true },
        },
      },
    });

    if (!account) {
      return null;
    }

    return serializeBigInts(account);
  }

  /**
   * Move an account to a new parent
   */
  static async move(guid: string, newParentGuid: string | null) {
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid account GUID');
    }

    // Check account exists
    const account = await prisma.accounts.findUnique({
      where: { guid },
    });

    if (!account) {
      throw new Error(`Account not found: ${guid}`);
    }

    // Validate new parent if provided
    if (newParentGuid) {
      if (newParentGuid === guid) {
        throw new Error('Cannot move account to be its own parent');
      }

      const newParent = await prisma.accounts.findUnique({
        where: { guid: newParentGuid },
      });

      if (!newParent) {
        throw new Error(`New parent account not found: ${newParentGuid}`);
      }

      // Check for circular reference
      let ancestor = newParent;
      while (ancestor.parent_guid) {
        if (ancestor.parent_guid === guid) {
          throw new Error('Cannot move account: would create circular reference');
        }
        const nextAncestor = await prisma.accounts.findUnique({
          where: { guid: ancestor.parent_guid },
        });
        if (!nextAncestor) break;
        ancestor = nextAncestor;
      }
    }

    const updated = await prisma.accounts.update({
      where: { guid },
      data: { parent_guid: newParentGuid },
      include: {
        commodity: true,
        parent: true,
      },
    });

    return serializeBigInts(updated);
  }

  /**
   * Get all currencies/commodities for account creation
   */
  static async getCommodities() {
    const commodities = await prisma.commodities.findMany({
      where: {
        namespace: { in: ['CURRENCY', 'ISO4217'] },
      },
      orderBy: { mnemonic: 'asc' },
    });

    return commodities;
  }
}

export default AccountService;
