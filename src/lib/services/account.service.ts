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
 * Against the other locks in play, the rule is a strict three-level hierarchy,
 * taken in this order and never the reverse:
 *
 *     1. the per-book lock (`tryAcquireBookLock`), for reparents only
 *     2. the row lock on the account being changed (`lockAccountKey`), for
 *        rename/reparent only
 *     3. this per-(parent, name) lock
 *
 * Every other holder of a named account lock is bound by the rule documented
 * on `accountNameLockKey` in src/lib/book-lock.ts: while holding one it may
 * not take a row lock on an account row it did not itself INSERT. That
 * document enumerates each holder and how it satisfies the rule — it is a rule
 * the other side has to keep, not a property they happen to have, and
 * `addTemplateAccounts` broke it before the two-phase rewrite. The XML
 * importer takes the book lock first exactly as here. So the wait-for graph
 * has no cycle across levels 2 and 3; `lockAccountKey` works the argument
 * through case by case.
 *
 * ## Which (parent, name) to pass
 *
 * The DESTINATION key, computed from the account's state AS LOCKED at level 2,
 * never from a read taken before the transaction: each half of the key is
 * written by a different operation, so a pre-transaction snapshot can be
 * invalidated by a concurrent write to the half this operation is not
 * touching. `lockAccountKey` has the worked example.
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
 * Row that a sibling key is computed FROM: the account's own
 * `(parent_guid, name)`, read under a row-level lock inside the caller's
 * transaction.
 */
interface LockedAccountKey {
    name: string;
    parent_guid: string | null;
}

/**
 * Take `SELECT ... FOR UPDATE` on the account being renamed/reparented and
 * return its CURRENT `(parent_guid, name)`.
 *
 * ## Why the destination key cannot be derived from a pre-transaction read
 *
 * A sibling key has two halves and every mutation writes only one of them, so
 * a snapshot taken before the transaction can be invalidated by a concurrent
 * write to the OTHER half — and the resulting key is then one that nobody
 * locked and nobody re-checked:
 *
 *     update(X, {name: 'New'})  reads X = (P1, 'Old'), plans (P1, 'New')
 *     move(X, P2)               commits parent_guid = P2
 *     update(X, ...)            writes name only -> X is now (P2, 'New')
 *     create(P2, 'New')         claims (P2, 'New'), finds it free, commits
 *                               -> two real siblings named 'New' under P2
 *
 * and symmetrically, a rename landing between `move`'s read and its claim makes
 * `move` lock the OLD name under the new parent while the row lands on the new
 * one. The advisory lock is real in both cases; it just guards the wrong key.
 *
 * So the state the key is computed from is read HERE, inside the transaction,
 * under a lock that a concurrent writer must wait behind — and the claim and
 * re-check follow immediately, with nothing in between that could move the
 * account again.
 *
 * ## Ordering, against the two locks already in play
 *
 * Strict three-level hierarchy, taken in this order and never the reverse:
 *
 *     1. the per-book advisory lock (`tryAcquireBookLock`), reparents only
 *     2. this row lock, on the account being changed
 *     3. the per-(parent, name) advisory lock (`claimSiblingName`)
 *
 * Level 1 is a NON-BLOCKING try-lock, so nobody ever queues on it; the only
 * waits are at levels 2 and 3, and every operation takes at most one lock at
 * each level, always 2 before 3. That is what keeps the wait-for graph acyclic:
 *
 *   - Two operations on the SAME account serialize entirely at level 2. The
 *     winner holds the row lock from before its claim until its own UPDATE
 *     commits, so the loser cannot be holding a name lock the winner wants.
 *   - Operations on DIFFERENT accounts take disjoint level-2 locks.
 *   - Every OTHER holder of a name lock is forbidden to acquire a level-2 lock
 *     on a row it did not itself INSERT while holding that level-3 lock. That
 *     is the rule stated and enumerated holder-by-holder on `accountNameLockKey`
 *     in src/lib/book-lock.ts, and `SiblingKeyAdoptedError` is what enforces it
 *     where a post-claim re-check adopts a concurrently created row. It is not
 *     self-evident and it has been broken: `addTemplateAccounts` and
 *     `bootstrapInventoryAccounts` both used to update an existing account from
 *     underneath a claimed key. The resulting deadlock is reproduced against
 *     the pre-fix code, as a real SQLSTATE 40P01, in
 *     account-lock-hierarchy-deadlock.integration.test.ts.
 *
 * This covers ordering ACROSS levels 2 and 3. Ordering between two level-3
 * keys is a separate question, and only partly settled — see the closing
 * section of `accountNameLockKey`.
 *
 * The one edge worth naming: `UPDATE accounts SET parent_guid = P` takes a
 * `FOR KEY SHARE` lock on parent row P for the foreign key, which conflicts
 * with a `FOR UPDATE` held by a concurrent rename OF P. Closing that into a
 * cycle would require an operation whose destination parent is the very
 * account it is moving — rejected by {@link assertReparentIsAcyclic} before any
 * name is claimed.
 *
 * Returns null when the account no longer exists (deleted between the caller's
 * existence pre-check and this lock).
 *
 * The lock is skipped, and the read degrades to an unlocked one, only for
 * in-memory test doubles with no `$queryRaw` — the same degradation
 * `acquireNamedXactLock` documents. A double cannot demonstrate row-level
 * exclusion no matter what it returns, so the proof that this actually
 * serializes lives in the integration tier
 * (account-rename-reparent-race.integration.test.ts), against real Postgres
 * and two real connections.
 */
async function lockAccountKey(
    tx: PrismaTxClient,
    guid: string,
): Promise<LockedAccountKey | null> {
    if (typeof tx.$queryRaw === 'function') {
        // Lock and read are two statements on purpose. The lock has to be raw
        // (Prisma has no `FOR UPDATE`), but the VALUES come back through the
        // same Prisma decoding as every other read in this service, so a raw
        // driver's column typing can never make `parent_guid` compare unequal
        // to a Prisma-read one. Under READ COMMITTED the second statement takes
        // a fresh snapshot, so it sees whatever the writer we just waited out
        // committed.
        await tx.$queryRaw`SELECT 1 AS locked FROM accounts WHERE guid = ${guid} FOR UPDATE`;
    }
    return tx.accounts.findUnique({
        where: { guid },
        select: { name: true, parent_guid: true },
    });
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

    // Does this update touch EITHER half of the sibling key? Only then is
    // there a destination to claim, and only then is the row lock worth
    // taking — an update that writes neither `name` nor `parent_guid` cannot
    // move the account onto a different key no matter what else commits
    // concurrently, so it pays for no lock.
    const touchesSiblingKey =
      data.name !== undefined || data.parent_guid !== undefined;

    // The account's (parent, name) as read under the row lock inside the
    // transaction — the authoritative "before" for both the key claim and the
    // audit entry. `existing` above is a pre-transaction snapshot and may be
    // stale by the time the transaction runs; see `lockAccountKey`.
    let lockedBefore: LockedAccountKey | null = null;

    const account = await prisma.$transaction(async (tx) => {
      if (isReparent && bookLockGuid) {
        const locked = await tryAcquireBookLock(tx, bookLockGuid);
        if (!locked) {
          throw new BookBusyError(bookLockGuid, 'account-reparent');
        }
      }

      // Book lock, then the row lock, then the sibling-name lock — see
      // `lockAccountKey` for why the key MUST come from a read taken here
      // rather than from `existing`, and why that order is the one every
      // caller uses.
      if (touchesSiblingKey) {
        lockedBefore = await lockAccountKey(tx, guid);
        if (!lockedBefore) {
          // Deleted between the pre-check above and this lock.
          throw new Error(`Account not found: ${guid}`);
        }
      }

      if (data.parent_guid !== undefined && data.parent_guid !== null) {
        await assertReparentIsAcyclic(tx, guid, data.parent_guid);
      }

      if (lockedBefore) {
        // Where this update LANDS the account on the sibling key. A rename
        // moves it within its CURRENT parent; a reparent moves it under a new
        // one; both can land it on a key another real sibling already holds —
        // the exact duplicate `create()` refuses. Each half falls back to the
        // locked row, never to the pre-transaction snapshot.
        const current: LockedAccountKey = lockedBefore;
        const destParentGuid =
          data.parent_guid !== undefined ? data.parent_guid : current.parent_guid;
        const destName = data.name !== undefined ? data.name : current.name;
        if (destParentGuid !== current.parent_guid || destName !== current.name) {
          await claimSiblingName(tx, destParentGuid, destName, guid);
        }
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
    // `lockedBefore` (read under the row lock) beats `existing` (read before
    // the transaction) for the two fields a concurrent writer can have changed
    // in between — otherwise the audit trail records a "before" that was
    // already false when the update ran.
    const before = lockedBefore as LockedAccountKey | null;
    await logAudit('UPDATE', 'ACCOUNT', guid, {
      name: before?.name ?? existing.name,
      code: existing.code,
      description: existing.description,
      hidden: existing.hidden,
      placeholder: existing.placeholder,
      parent_guid: before ? before.parent_guid : existing.parent_guid,
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

    // Existence PRE-check only, for a clean error before any lock is taken.
    // It is not authoritative for the sibling key: the name it reads can be
    // changed by a concurrent rename before this transaction claims anything,
    // which is why the key comes from `lockAccountKey` below instead.
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

      // Level 2 of the ordering: serialize the account row before deriving the
      // key from it. A rename that commits between the pre-check above and
      // this point would otherwise make the claim below lock the account's OLD
      // name under the new parent — a lock on a key the row never lands on.
      // See `lockAccountKey`.
      const current = await lockAccountKey(tx, guid);
      if (!current) {
        throw new Error(`Account not found: ${guid}`);
      }

      if (newParentGuid) {
        await assertReparentIsAcyclic(tx, guid, newParentGuid);
      }

      // Same claim `create()` and `update()` make, on the DESTINATION parent
      // and this account's name AS LOCKED. Book lock and row lock are already
      // held above; this is the third and last level of the ordering — see
      // `claimSiblingName` and `lockAccountKey`.
      if (newParentGuid !== current.parent_guid) {
        await claimSiblingName(tx, newParentGuid, current.name, guid);
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
