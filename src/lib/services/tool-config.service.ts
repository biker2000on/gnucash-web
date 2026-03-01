/**
 * Tool Configuration Service Layer
 *
 * Handles CRUD operations for tool configurations with:
 * - Book-scoped storage
 * - User ownership validation
 * - Zod validation for inputs
 * - Support for optional account association
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';

/**
 * Validation schemas
 */
export const CreateToolConfigSchema = z.object({
  toolType: z.string().min(1).max(50),
  name: z.string().min(1).max(255),
  accountGuid: z.string().length(32).optional().nullable(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const UpdateToolConfigSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  accountGuid: z.string().length(32).optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type CreateToolConfigInput = z.infer<typeof CreateToolConfigSchema>;
export type UpdateToolConfigInput = z.infer<typeof UpdateToolConfigSchema>;

/**
 * Service class for tool configuration operations
 */
export class ToolConfigService {
  /**
   * List all tool configurations for a user in a specific book
   * Optionally filter by tool type
   */
  static async listByUser(userId: number, bookGuid: string, toolType?: string) {
    const where: { user_id: number; book_guid: string; tool_type?: string } = {
      user_id: userId,
      book_guid: bookGuid,
    };

    if (toolType) {
      where.tool_type = toolType;
    }

    const configs = await prisma.gnucash_web_tool_config.findMany({
      where,
      orderBy: { updated_at: 'desc' },
    });

    return configs;
  }

  /**
   * Get a single tool configuration by ID
   * Validates ownership and book context
   */
  static async getById(id: number, userId: number, bookGuid: string) {
    const config = await prisma.gnucash_web_tool_config.findUnique({
      where: {
        id,
        user_id: userId,
        book_guid: bookGuid,
      },
    });

    return config;
  }

  /**
   * Create a new tool configuration
   */
  static async create(userId: number, bookGuid: string, data: CreateToolConfigInput) {
    const validated = CreateToolConfigSchema.parse(data);

    // If account GUID provided, validate it exists in this book
    if (validated.accountGuid) {
      const account = await prisma.accounts.findUnique({
        where: { guid: validated.accountGuid },
      });

      if (!account) {
        throw new Error(`Account not found: ${validated.accountGuid}`);
      }

      // Verify account belongs to this book by checking root account
      // (In GnuCash, all accounts are descendants of a root account specific to the book)
      const bookRoot = await prisma.accounts.findFirst({
        where: {
          account_type: 'ROOT',
          name: bookGuid, // Root accounts are named with book GUID
        },
      });

      if (bookRoot) {
        // Walk up the parent chain to verify it reaches this book's root
        let current = account;
        let maxDepth = 100; // Safety limit

        while (current.parent_guid && maxDepth > 0) {
          if (current.parent_guid === bookRoot.guid) {
            break; // Found connection to book root
          }
          const parent = await prisma.accounts.findUnique({
            where: { guid: current.parent_guid },
          });
          if (!parent) break;
          current = parent;
          maxDepth--;
        }

        // If we didn't find the root, account doesn't belong to this book
        if (current.parent_guid !== bookRoot.guid && current.guid !== bookRoot.guid) {
          throw new Error(`Account ${validated.accountGuid} does not belong to book ${bookGuid}`);
        }
      }
    }

    const config = await prisma.gnucash_web_tool_config.create({
      data: {
        user_id: userId,
        book_guid: bookGuid,
        tool_type: validated.toolType,
        name: validated.name,
        account_guid: validated.accountGuid ?? null,
        config: validated.config,
      },
    });

    return config;
  }

  /**
   * Update an existing tool configuration
   * Validates ownership and book context before mutation
   */
  static async update(
    id: number,
    userId: number,
    bookGuid: string,
    data: UpdateToolConfigInput
  ) {
    const validated = UpdateToolConfigSchema.parse(data);

    // Check ownership and book context
    const existing = await prisma.gnucash_web_tool_config.findUnique({
      where: { id },
    });

    if (!existing || existing.user_id !== userId || existing.book_guid !== bookGuid) {
      return null; // Not found or not owned by this user in this book
    }

    // If account GUID provided, validate it exists and belongs to book
    if (validated.accountGuid) {
      const account = await prisma.accounts.findUnique({
        where: { guid: validated.accountGuid },
      });

      if (!account) {
        throw new Error(`Account not found: ${validated.accountGuid}`);
      }

      // Simple book validation (same logic as create)
      const bookRoot = await prisma.accounts.findFirst({
        where: {
          account_type: 'ROOT',
          name: bookGuid,
        },
      });

      if (bookRoot) {
        let current = account;
        let maxDepth = 100;

        while (current.parent_guid && maxDepth > 0) {
          if (current.parent_guid === bookRoot.guid) {
            break;
          }
          const parent = await prisma.accounts.findUnique({
            where: { guid: current.parent_guid },
          });
          if (!parent) break;
          current = parent;
          maxDepth--;
        }

        if (current.parent_guid !== bookRoot.guid && current.guid !== bookRoot.guid) {
          throw new Error(`Account ${validated.accountGuid} does not belong to book ${bookGuid}`);
        }
      }
    }

    // Build update data
    const updateData: { updated_at: Date; name?: string; account_guid?: string | null; config?: Record<string, unknown> } = {
      updated_at: new Date(),
    };

    if (validated.name !== undefined) {
      updateData.name = validated.name;
    }
    if (validated.accountGuid !== undefined) {
      updateData.account_guid = validated.accountGuid;
    }
    if (validated.config !== undefined) {
      updateData.config = validated.config;
    }

    const updated = await prisma.gnucash_web_tool_config.update({
      where: { id },
      data: updateData,
    });

    return updated;
  }

  /**
   * Delete a tool configuration
   * Validates ownership and book context before deletion
   */
  static async delete(id: number, userId: number, bookGuid: string) {
    // Check ownership and book context
    const existing = await prisma.gnucash_web_tool_config.findUnique({
      where: { id },
    });

    if (!existing || existing.user_id !== userId || existing.book_guid !== bookGuid) {
      return false; // Not found or not owned by this user in this book
    }

    await prisma.gnucash_web_tool_config.delete({
      where: { id },
    });

    return true;
  }
}

export default ToolConfigService;
