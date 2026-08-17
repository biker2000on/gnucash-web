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
import {
    tryAcquireBookLock,
    resolveBookLockGuidForAccount,
    BookBusyError,
    accountNameLockKey,
    acquireNamedXactLock,
} from '@/lib/book-lock';

type PrismaTxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Claim a REAL account's `(parent_guid, name)` sibling key inside `tx`, or
 * refuse.
 *
 * Every path that can PUT an account on a sibling key — create, rename, move —
 * must come through here, because there is no database arbiter to fall back on:
 * a unique index on `accounts(parent_guid, name)` cannot exist while the same
 * table stores scheduled-transaction templates (see
 * `ACCOUNTS_SIBLING_NAME_INDEX` in src/lib/db-init.ts). The advisory lock IS
 * the constraint, so a writer that skips it is not "slightly racy", it is
 * unconstrained.
 *
 * ## Lock ordering
 *
 * Exactly ONE sibling-name lock is taken per operation, on the DESTINATION
 * `(parent, name)` only. A reparent touches two parents, but the source parent
 * needs no lock: vacating a key can never create a duplicate under it, only
 * remove one. With a single key there is no pair to order and no
 * opposite-direction deadlock to construct — two concurrent moves that swap
 * destinations contend on two independent keys and both make progress.
 *
 * Against the other lock in play, the rule is a strict two-level hierarchy,
 * taken in this order and never the reverse:
 *
 *     1. the per-book lock (`tryAcquireBookLock`), for reparents only
 *     2. this per-(parent, name) lock
 *
 * Every other holder of a named account lock (findOrCreateAccount,
 * trading-accounts, packages, the SimpleFin sync) takes no book lock at all,
 * and the XML importer takes the book lock first exactly as here — so the
 * wait-for graph has no cycle.
 *
 * `selfGuid` excludes the row being renamed/moved, so a no-op update and a
 * rename that only changes case-identical text do not refuse themselves.
 */
async function claimSiblingName(
    tx: PrismaTxClient,
    parentGuid: string | null,
    name: string,
    selfGuid: string | null,
): Promise<void> {
    // The ROOT account (parent_guid null) is a sibling of nothing.
    if (!parentGuid) return;
    // '' is the scheduled-transaction template shape: GnuCash stores one child
    // account PER SPLIT under a template root, every one of them named '', and
    // those duplicates are correct data. `CreateAccountSchema`/
    // `UpdateAccountSchema` both require a non-empty name, so this is only
    // reachable by moving an existing template row — which must not be
    // refused for being a duplicate of the template rows beside it.
    if (name === '') return;

    await acquireNamedXactLock(tx, accountNameLockKey(parentGuid, name));
    const clash = await tx.accounts.findFirst({
        where: {
            parent_guid: parentGuid,
            name,
            ...(selfGuid ? { guid: { not: selfGuid } } : {}),
        },
        select: { guid: true },
    });
    if (clash) {
        throw new Error(
            `An account named "${name}" already exists under this parent`,
        );
    }
}

/**
 * Validate a reparent on the transaction client, while the per-book advisory
 * lock is held: parent must exist and must not be a descendant of the moved
 * account (which would create a cycle that bricks every recursive CTE over
 * the tree). Serializing all reparents per book makes the classic
 * A→under→B / B→under→A race impossible.
 */
async function assertReparentIsAcyclic(
    tx: Pick<typeof prisma, 'accounts'>,
    guid: string,
    newParentGuid: string,
): Promise<void> {
    if (newParentGuid === guid) {
        throw new Error('Cannot move account to be its own parent');
    }
    const newParent = await tx.accounts.findUnique({
        where: { guid: newParentGuid },
    });
    if (!newParent) {
        throw new Error(`New parent account not found: ${newParentGuid}`);
    }
    // Check for circular reference (bounded + cycle-safe even on an
    // already-corrupted tree)
    const visited = new Set<string>([newParent.guid]);
    let ancestor = newParent;
    while (ancestor.parent_guid) {
        if (ancestor.parent_guid === guid) {
            throw new Error('Cannot move account: would create circular reference');
        }
        if (visited.has(ancestor.parent_guid)) break;
        visited.add(ancestor.parent_guid);
        const nextAncestor = await tx.accounts.findUnique({
            where: { guid: ancestor.parent_guid },
        });
        if (!nextAncestor) break;
        ancestor = nextAncestor;
    }
}

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
  is_card_payment_source: z.boolean().optional(),
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
  is_card_payment_source: z.boolean().optional(),
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
      // Sibling-name uniqueness for REAL accounts has no DB arbiter — a
      // unique index on accounts(parent_guid, name) cannot exist because
      // scheduled-transaction templates share (parent, '') by design (see
      // src/lib/db-init.ts, ACCOUNTS_SIBLING_NAME_INDEX). Serialize on the
      // same per-(parent, name) key the create-if-missing paths use, and
      // re-check under it: without this, two concurrent creates of the same
      // name under the same parent both commit and the book quietly grows a
      // duplicate. `AccountService.update`/`move` claim the same key — see
      // `claimSiblingName`.
      await claimSiblingName(tx, data.parent_guid, data.name, null);

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
      if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined || data.owner !== undefined || data.is_card_payment_source !== undefined) {
        await tx.$executeRaw`
          INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type, owner, is_card_payment_source)
          VALUES (
            ${accountGuid},
            ${data.tax_related ?? false},
            ${data.is_retirement ?? false},
            ${data.retirement_account_type ?? null},
            ${data.owner ?? null},
            ${data.is_card_payment_source ?? false}
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

    // Reparenting is serialized on the per-book advisory lock, and the
    // cycle check runs INSIDE the transaction while the lock is held —
    // two concurrent moves (X under Y, Y under X) can no longer both pass
    // validation and commit a cycle. The lock is a NON-BLOCKING try-lock:
    // when another book-wide operation (e.g. a minutes-long scrub-all)
    // holds it, queueing would just blow Prisma's transaction timeout and
    // surface as an opaque P2028/500 — throw BookBusyError instead so the
    // route returns a clean 409 "another operation in progress".
    const isReparent = data.parent_guid !== undefined;
    const bookLockGuid = isReparent
      ? await resolveBookLockGuidForAccount(guid)
      : null;

    // Where this update LANDS the account on the sibling key. A rename moves
    // it within the same parent; a reparent moves it under a new one; both
    // can land it on a key another real sibling already holds — the exact
    // duplicate `create()` refuses. Only claim when the key actually changes,
    // so an update that touches neither field pays for no lock.
    const destParentGuid =
      data.parent_guid !== undefined ? data.parent_guid : existing.parent_guid;
    const destName = data.name !== undefined ? data.name : existing.name;
    const changesSiblingKey =
      destParentGuid !== existing.parent_guid || destName !== existing.name;

    const account = await prisma.$transaction(async (tx) => {
      if (isReparent && bookLockGuid) {
        const locked = await tryAcquireBookLock(tx, bookLockGuid);
        if (!locked) {
          throw new BookBusyError(bookLockGuid, 'account-reparent');
        }
      }
      if (data.parent_guid !== undefined && data.parent_guid !== null) {
        await assertReparentIsAcyclic(tx, guid, data.parent_guid);
      }
      // Book lock first, then the sibling-name lock — see `claimSiblingName`
      // for why that order is the one every caller uses.
      if (changesSiblingKey) {
        await claimSiblingName(tx, destParentGuid, destName, guid);
      }

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
      if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined || data.owner !== undefined || data.is_card_payment_source !== undefined) {
        const taxRelated = data.tax_related;
        const isRetirement = data.is_retirement;
        const retirementType = data.retirement_account_type;
        const owner = data.owner;
        const hasTaxRelated = data.tax_related !== undefined;
        const hasIsRetirement = data.is_retirement !== undefined;
        const hasRetirementType = data.retirement_account_type !== undefined;
        const hasOwner = data.owner !== undefined;
        const cardPaymentSource = data.is_card_payment_source;
        const hasCardPaymentSource = data.is_card_payment_source !== undefined;

        await tx.$executeRaw`
          INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type, owner, is_card_payment_source)
          VALUES (
            ${guid},
            ${taxRelated ?? false},
            ${isRetirement ?? false},
            ${retirementType ?? null},
            ${owner ?? null},
            ${cardPaymentSource ?? false}
          )
          ON CONFLICT (account_guid)
          DO UPDATE SET
            tax_related = CASE WHEN ${hasTaxRelated}::boolean THEN ${taxRelated ?? false} ELSE gnucash_web_account_preferences.tax_related END,
            is_retirement = CASE WHEN ${hasIsRetirement}::boolean THEN ${isRetirement ?? false} ELSE gnucash_web_account_preferences.is_retirement END,
            retirement_account_type = CASE WHEN ${hasRetirementType}::boolean THEN ${retirementType ?? null} ELSE gnucash_web_account_preferences.retirement_account_type END,
            owner = CASE WHEN ${hasOwner}::boolean THEN ${owner ?? null} ELSE gnucash_web_account_preferences.owner END,
            is_card_payment_source = CASE WHEN ${hasCardPaymentSource}::boolean THEN ${cardPaymentSource ?? false} ELSE gnucash_web_account_preferences.is_card_payment_source END
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
        ...(data.is_card_payment_source !== undefined && { is_card_payment_source: data.is_card_payment_source }),
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

    // Validation + update run in ONE transaction holding the per-book
    // advisory lock so concurrent reparents cannot commit a cycle. Try-lock
    // (not blocking): when a book-wide operation holds the lock, fail fast
    // with BookBusyError → 409 instead of timing out with a P2028/500.
    const bookLockGuid = await resolveBookLockGuidForAccount(guid);

    const updated = await prisma.$transaction(async (tx) => {
      const locked = await tryAcquireBookLock(tx, bookLockGuid);
      if (!locked) {
        throw new BookBusyError(bookLockGuid, 'account-move');
      }

      if (newParentGuid) {
        await assertReparentIsAcyclic(tx, guid, newParentGuid);
      }

      // Same claim `create()` and `update()` make, on the DESTINATION parent
      // and this account's (unchanged) name. Book lock is already held above;
      // this is the second and last level of the ordering — see
      // `claimSiblingName`.
      if (newParentGuid !== account.parent_guid) {
        await claimSiblingName(tx, newParentGuid, account.name, guid);
      }

      return tx.accounts.update({
        where: { guid },
        data: { parent_guid: newParentGuid },
        include: {
          commodity: true,
          parent: true,
        },
      });
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
