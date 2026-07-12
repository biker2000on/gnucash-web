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

// Valid retirement account types for account preferences
// (kept consistent with RETIREMENT_ACCOUNT_TYPES in src/lib/reports/irs-limits.ts)
const RETIREMENT_ACCOUNT_TYPE_VALUES = [
  '401k',
  '403b',
  '457',
  'traditional_ira',
  'roth_ira',
  'hsa',
  'hsa_family',
  'hra',
  'fsa',
  'brokerage',
  'sep_ira',
  'simple_ira',
  'education_529',
  'coverdell_esa',
] as const;

// Account owner attribution for per-spouse tax tracking and ownership reporting.
// 'joint' is valid for balance-sheet accounts; retirement accounts should stay
// 'self' | 'spouse' (IRAs/401ks are individually owned) — the UI enforces that.
const OWNER_VALUES = ['self', 'spouse', 'joint'] as const;

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
  notes: z.string().max(4096).optional(),
  tax_related: z.boolean().optional(),
  is_retirement: z.boolean().optional(),
  retirement_account_type: z.enum(RETIREMENT_ACCOUNT_TYPE_VALUES).nullable().optional(),
  owner: z.enum(OWNER_VALUES).nullable().optional(),
});

export const UpdateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048).optional(),
  code: z.string().max(2048).optional(),
  description: z.string().max(2048).optional(),
  hidden: z.number().int().min(0).max(1).optional(),
  placeholder: z.number().int().min(0).max(1).optional(),
  parent_guid: z.string().length(32).nullable().optional(),
  commodity_guid: z.string().length(32).optional(),
  commodity_scu: z.number().int().min(1).optional(),
  notes: z.string().max(4096).optional(),
  tax_related: z.boolean().optional(),
  is_retirement: z.boolean().optional(),
  retirement_account_type: z.enum(RETIREMENT_ACCOUNT_TYPE_VALUES).nullable().optional(),
  owner: z.enum(OWNER_VALUES).nullable().optional(),
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

    const account = await prisma.$transaction(async (tx) => {
      const acct = await tx.accounts.create({
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
        await tx.slots.create({
          data: {
            obj_guid: accountGuid,
            name: 'notes',
            slot_type: 4,
            string_val: data.notes,
          },
        });
      }

      // Write preferences if any preference fields are provided
      if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined || data.owner !== undefined) {
        await tx.$executeRaw`
          INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type, owner)
          VALUES (
            ${accountGuid},
            ${data.tax_related ?? false},
            ${data.is_retirement ?? false},
            ${data.retirement_account_type ?? null},
            ${data.owner ?? null}
          )
        `;
      }

      return acct;
    });

    const { logAudit } = await import('@/lib/services/audit.service');
    await logAudit('CREATE', 'ACCOUNT', account.guid, null, {
      name: account.name,
      account_type: account.account_type,
      parent_guid: account.parent_guid,
      commodity_guid: account.commodity_guid,
      code: account.code,
      description: account.description,
    });

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

    // Guard commodity change: only allowed when the account has no splits.
    // Changing commodity on an account with history would silently reinterpret
    // historical share quantities under the new commodity's units.
    if (data.commodity_guid !== undefined && data.commodity_guid !== existing.commodity_guid) {
      const commodity = await prisma.commodities.findUnique({
        where: { guid: data.commodity_guid },
      });
      if (!commodity) {
        throw new Error(`Commodity not found: ${data.commodity_guid}`);
      }
      const splitsCount = await prisma.splits.count({
        where: { account_guid: guid },
      });
      if (splitsCount > 0) {
        throw new Error(
          `Cannot change commodity: account has ${splitsCount} transaction split${splitsCount === 1 ? '' : 's'}. Remove all transactions referencing this account first.`
        );
      }
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

    const account = await prisma.$transaction(async (tx) => {
      const acct = await tx.accounts.update({
        where: { guid },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.code !== undefined && { code: data.code }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.hidden !== undefined && { hidden: data.hidden }),
          ...(data.placeholder !== undefined && { placeholder: data.placeholder }),
          ...(data.parent_guid !== undefined && { parent_guid: data.parent_guid }),
          ...(data.commodity_guid !== undefined && { commodity_guid: data.commodity_guid }),
          ...(data.commodity_scu !== undefined && { commodity_scu: data.commodity_scu }),
        },
        include: {
          commodity: true,
          parent: true,
        },
      });

      // Upsert notes in slots table
      if (data.notes !== undefined) {
        if (data.notes) {
          const existingSlot = await tx.slots.findFirst({
            where: { obj_guid: guid, name: 'notes' },
          });
          if (existingSlot) {
            await tx.slots.update({
              where: { id: existingSlot.id },
              data: { string_val: data.notes },
            });
          } else {
            await tx.slots.create({
              data: {
                obj_guid: guid,
                name: 'notes',
                slot_type: 4,
                string_val: data.notes,
              },
            });
          }
        } else {
          // Delete notes slot if cleared
          await tx.$executeRaw`
            DELETE FROM slots WHERE obj_guid = ${guid} AND name = 'notes'
          `;
        }
      }

      // Upsert preferences if any preference fields are provided
      // Uses CASE WHEN to only update fields present in the request,
      // preserving existing values for fields not included
      if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined || data.owner !== undefined) {
        const taxRelated = data.tax_related;
        const isRetirement = data.is_retirement;
        const retirementType = data.retirement_account_type;
        const owner = data.owner;
        const hasTaxRelated = data.tax_related !== undefined;
        const hasIsRetirement = data.is_retirement !== undefined;
        const hasRetirementType = data.retirement_account_type !== undefined;
        const hasOwner = data.owner !== undefined;

        await tx.$executeRaw`
          INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type, owner)
          VALUES (
            ${guid},
            ${taxRelated ?? false},
            ${isRetirement ?? false},
            ${retirementType ?? null},
            ${owner ?? null}
          )
          ON CONFLICT (account_guid)
          DO UPDATE SET
            tax_related = CASE WHEN ${hasTaxRelated}::boolean THEN ${taxRelated ?? false} ELSE gnucash_web_account_preferences.tax_related END,
            is_retirement = CASE WHEN ${hasIsRetirement}::boolean THEN ${isRetirement ?? false} ELSE gnucash_web_account_preferences.is_retirement END,
            retirement_account_type = CASE WHEN ${hasRetirementType}::boolean THEN ${retirementType ?? null} ELSE gnucash_web_account_preferences.retirement_account_type END,
            owner = CASE WHEN ${hasOwner}::boolean THEN ${owner ?? null} ELSE gnucash_web_account_preferences.owner END
        `;
      }

      return acct;
    });

    const { logAudit } = await import('@/lib/services/audit.service');
    await logAudit('UPDATE', 'ACCOUNT', guid, {
      name: existing.name,
      code: existing.code,
      description: existing.description,
      hidden: existing.hidden,
      placeholder: existing.placeholder,
      parent_guid: existing.parent_guid,
      commodity_guid: existing.commodity_guid,
    }, {
      name: account.name,
      code: account.code,
      description: account.description,
      hidden: account.hidden,
      placeholder: account.placeholder,
      parent_guid: account.parent_guid,
      commodity_guid: account.commodity_guid,
      preference_changes: {
        ...(data.tax_related !== undefined && { tax_related: data.tax_related }),
        ...(data.is_retirement !== undefined && { is_retirement: data.is_retirement }),
        ...(data.retirement_account_type !== undefined && { retirement_account_type: data.retirement_account_type }),
        ...(data.owner !== undefined && { owner: data.owner }),
        ...(data.notes !== undefined && { notes: data.notes }),
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

    const { logAudit } = await import('@/lib/services/audit.service');
    await logAudit('DELETE', 'ACCOUNT', guid, {
      name: account.name,
      account_type: account.account_type,
      parent_guid: account.parent_guid,
      commodity_guid: account.commodity_guid,
      code: account.code,
      description: account.description,
    }, null);

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
