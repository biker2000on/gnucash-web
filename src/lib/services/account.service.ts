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
  notes: z.string().optional(),
  tax_related: z.boolean().optional(),
  is_retirement: z.boolean().optional(),
  retirement_account_type: z.enum(['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage']).nullable().optional(),
});

export const UpdateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048).optional(),
  code: z.string().max(2048).optional(),
  description: z.string().max(2048).optional(),
  hidden: z.number().int().min(0).max(1).optional(),
  placeholder: z.number().int().min(0).max(1).optional(),
  parent_guid: z.string().length(32).nullable().optional(),
  notes: z.string().optional(),
  tax_related: z.boolean().optional(),
  is_retirement: z.boolean().optional(),
  retirement_account_type: z.enum(['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage']).nullable().optional(),
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

    // Write notes to slots table if provided
    if (data.notes) {
      await prisma.$executeRaw`
        INSERT INTO slots (id, obj_guid, name, slot_type, int64_val, string_val, double_val, timespec_val, guid_val, numeric_val_num, numeric_val_denom, gdate_val)
        VALUES (
          (SELECT COALESCE(MAX(id), 0) + 1 FROM slots),
          ${accountGuid}, 'notes', 4, 0, ${data.notes}, 0, '1970-01-01 00:00:00'::timestamp, NULL, 0, 1, NULL
        )
      `;
    }

    // Write preferences if any preference fields are provided
    if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type)
        VALUES (
          ${accountGuid},
          ${data.tax_related ?? false},
          ${data.is_retirement ?? false},
          ${data.retirement_account_type ?? null}
        )
        ON CONFLICT (account_guid)
        DO UPDATE SET
          tax_related = ${data.tax_related ?? false},
          is_retirement = ${data.is_retirement ?? false},
          retirement_account_type = ${data.retirement_account_type ?? null}
      `;
    }

    return serializeBigInts(account);
  }

  /**
   * Update an existing account
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

    // Handle reparenting if parent_guid is provided
    if (data.parent_guid !== undefined) {
      if (data.parent_guid !== null) {
        if (data.parent_guid === guid) {
          throw new Error('Cannot move account to be its own parent');
        }
        const newParent = await prisma.accounts.findUnique({
          where: { guid: data.parent_guid },
        });
        if (!newParent) {
          throw new Error(`New parent account not found: ${data.parent_guid}`);
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
    }

    const account = await prisma.accounts.update({
      where: { guid },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.code !== undefined && { code: data.code }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.hidden !== undefined && { hidden: data.hidden }),
        ...(data.placeholder !== undefined && { placeholder: data.placeholder }),
        ...(data.parent_guid !== undefined && { parent_guid: data.parent_guid }),
      },
      include: {
        commodity: true,
        parent: true,
      },
    });

    // Upsert notes in slots table
    if (data.notes !== undefined) {
      if (data.notes) {
        // Check if notes slot exists
        const existingSlot = await prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM slots WHERE obj_guid = ${guid} AND name = 'notes'
        `;
        if (existingSlot.length > 0) {
          await prisma.$executeRaw`
            UPDATE slots SET string_val = ${data.notes} WHERE obj_guid = ${guid} AND name = 'notes'
          `;
        } else {
          await prisma.$executeRaw`
            INSERT INTO slots (id, obj_guid, name, slot_type, int64_val, string_val, double_val, timespec_val, guid_val, numeric_val_num, numeric_val_denom, gdate_val)
            VALUES (
              (SELECT COALESCE(MAX(id), 0) + 1 FROM slots),
              ${guid}, 'notes', 4, 0, ${data.notes}, 0, '1970-01-01 00:00:00'::timestamp, NULL, 0, 1, NULL
            )
          `;
        }
      } else {
        // Delete notes slot if cleared
        await prisma.$executeRaw`
          DELETE FROM slots WHERE obj_guid = ${guid} AND name = 'notes'
        `;
      }
    }

    // Upsert preferences if any preference fields are provided
    if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined) {
      const taxRelated = data.tax_related;
      const isRetirement = data.is_retirement;
      const retirementType = data.retirement_account_type;
      const hasTaxRelated = data.tax_related !== undefined;
      const hasIsRetirement = data.is_retirement !== undefined;
      const hasRetirementType = data.retirement_account_type !== undefined;

      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type)
        VALUES (
          ${guid},
          ${taxRelated ?? false},
          ${isRetirement ?? false},
          ${retirementType ?? null}
        )
        ON CONFLICT (account_guid)
        DO UPDATE SET
          tax_related = CASE WHEN ${hasTaxRelated}::boolean THEN ${taxRelated ?? false} ELSE gnucash_web_account_preferences.tax_related END,
          is_retirement = CASE WHEN ${hasIsRetirement}::boolean THEN ${isRetirement ?? false} ELSE gnucash_web_account_preferences.is_retirement END,
          retirement_account_type = CASE WHEN ${hasRetirementType}::boolean THEN ${retirementType ?? null} ELSE gnucash_web_account_preferences.retirement_account_type END
      `;
    }

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
