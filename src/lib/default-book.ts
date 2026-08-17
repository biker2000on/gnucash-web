/**
 * Default Book Creation
 *
 * Creates a new book seeded with the account hierarchy recommended for the
 * chosen entity type (household, sole proprietorship, LLC, corporation, or
 * nonprofit). Templates live in src/lib/book-templates.ts.
 */

import prisma from './prisma';
import { generateGuid } from './gnucash';
import {
  accountNameLockKey,
  acquireBookLock,
  acquireNamedXactLock,
  commodityLockKey,
  SiblingKeyAdoptedError,
  withAdoptionRetry,
} from './book-lock';
import { getCurrencyName } from './currencies';
import { getEntityAccountTemplate, type TemplateAccountDef } from './book-templates';
import type { BusinessActivity, EntityType } from '@/lib/services/entity.service';

export async function createDefaultBook(
  bookName: string = 'My Finances',
  bookDescription?: string,
  entityType: EntityType = 'household',
  currency: string = 'USD',
  businessActivity: BusinessActivity = 'general'
): Promise<string> {
  const mnemonic = currency.toUpperCase();
  const hierarchy = getEntityAccountTemplate(entityType, businessActivity);

  const bookGuid = generateGuid();
  const rootGuid = generateGuid();
  const templateRootGuid = generateGuid();

  await prisma.$transaction(async (tx) => {
    // Ensure the currency commodity exists — inside the transaction, guarded
    // by a per-commodity advisory lock with a post-lock re-check, so two
    // concurrent book creations can't both insert the same currency (there
    // is not yet a unique index on (namespace, mnemonic)).
    let currencyCommodity = await tx.commodities.findFirst({
      where: { namespace: 'CURRENCY', mnemonic },
    });

    if (!currencyCommodity) {
      const locked = await acquireNamedXactLock(tx, commodityLockKey('CURRENCY', mnemonic));
      if (locked) {
        currencyCommodity = await tx.commodities.findFirst({
          where: { namespace: 'CURRENCY', mnemonic },
        });
      }
      if (!currencyCommodity) {
        currencyCommodity = await tx.commodities.create({
          data: {
            guid: generateGuid(),
            namespace: 'CURRENCY',
            mnemonic,
            fullname: getCurrencyName(mnemonic),
            cusip: '',
            fraction: 100,
            quote_flag: 1,
            quote_source: 'currency',
            quote_tz: '',
          },
        });
      }
    }

    const commodityScu = Number(currencyCommodity.fraction) || 100;

    // Create root account
    await tx.accounts.create({
      data: {
        guid: rootGuid,
        name: bookName,
        account_type: 'ROOT',
        commodity_guid: currencyCommodity.guid,
        commodity_scu: commodityScu,
        non_std_scu: 0,
        parent_guid: null,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
      },
    });

    // Create template root
    await tx.accounts.create({
      data: {
        guid: templateRootGuid,
        name: 'Template Root',
        account_type: 'ROOT',
        commodity_guid: currencyCommodity.guid,
        commodity_scu: commodityScu,
        non_std_scu: 0,
        parent_guid: null,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
      },
    });

    // Create book
    await tx.books.create({
      data: {
        guid: bookGuid,
        root_account_guid: rootGuid,
        root_template_guid: templateRootGuid,
        name: bookName,
        description: bookDescription || null,
      },
    });

    // Recursively create accounts
    const currencyGuid = currencyCommodity.guid;
    async function createAccounts(
      defs: TemplateAccountDef[],
      parentGuid: string
    ) {
      for (const def of defs) {
        const accountGuid = generateGuid();
        await tx.accounts.create({
          data: {
            guid: accountGuid,
            name: def.name,
            account_type: def.type,
            commodity_guid: currencyGuid,
            commodity_scu: commodityScu,
            non_std_scu: 0,
            parent_guid: parentGuid,
            code: '',
            description: '',
            hidden: 0,
            placeholder: def.children && def.children.length > 0 ? 1 : 0,
          },
        });

        if (def.children) {
          await createAccounts(def.children, accountGuid);
        }
      }
    }

    await createAccounts(hierarchy, rootGuid);
  }, {
    // Entity templates create up to a few hundred accounts sequentially;
    // the default 5s interactive timeout is too tight.
    timeout: 60_000,
    maxWait: 10_000,
  });

  return bookGuid;
}

export interface AddTemplateAccountsResult {
  created: number;
  existing: number;
}

function assertTemplateType(def: TemplateAccountDef, actualType: string): void {
  if (actualType !== def.type) {
    throw new Error(
      `Cannot add ${def.name}: existing account is ${actualType}, template requires ${def.type}.`,
    );
  }
}

/**
 * Idempotently graft a typed template beneath an existing book account.
 * Existing siblings are matched by exact name and must have the requested
 * account type; newly created descendants inherit the book currency.
 *
 * ## Lock ordering: why this runs in two phases
 *
 * The graft holds a transaction-scoped sibling-name lock from the moment it
 * claims one until COMMIT — `pg_advisory_xact_lock` has no early release. So
 * an implementation that interleaves "claim a missing sibling" with "update an
 * account that already exists" ends up taking a ROW lock while holding a NAME
 * lock, which is the reverse of the order `AccountService.update`/`.move` use
 * (row lock first, then the destination name lock — see `lockAccountKey` in
 * src/lib/services/account.service.ts). Those two orders close a cycle:
 *
 *     T1 addTemplateAccounts   claims (P,'A') to create a missing sibling,
 *                              then blocks updating existing account E
 *     T2 AccountService.update takes FOR UPDATE on E, then blocks claiming
 *                              (P,'A') as the destination of a rename
 *
 * and Postgres aborts one of them with a deadlock (SQLSTATE 40P01). The book
 * lock does not prevent it: a plain rename takes no book lock at all.
 *
 * So the work is split, and the split is the invariant:
 *
 *   PHASE 2 — reconcile what EXISTS. Reads and row-level UPDATEs only. No
 *             name lock is held anywhere in this phase, so acquiring row
 *             locks here is level 2 with nothing above it.
 *   PHASE 3 — create what is MISSING. Claims one sibling-name lock per
 *             missing node and INSERTs under it. It never updates an account
 *             row: the only row it could want to update is one adopted from a
 *             concurrent creator, and that case retries the whole transaction
 *             instead (see `SiblingKeyAdoptedError` in src/lib/book-lock.ts).
 *
 * Phase 2 never descends into a node it did not find, and phase 3 never looks
 * up anything beneath a node it just created: a guid generated in this
 * transaction is invisible to every other session until COMMIT, so no other
 * transaction can hold or want `account:<thatGuid>:<name>`, and the whole
 * subtree below a newly created node is missing by construction. That is also
 * why phase 3 claims a key only for the ROOT of each missing subtree — the
 * descendants need no lock, which keeps a several-hundred-account graft from
 * filling the shared lock table with advisory entries that guard nothing.
 */
export async function addTemplateAccounts(
  bookGuid: string,
  defs: TemplateAccountDef[],
  parentName?: string,
): Promise<AddTemplateAccountsResult> {
  const book = await prisma.books.findUnique({
    where: { guid: bookGuid },
    select: { root_account_guid: true },
  });
  if (!book) throw new Error('Book not found');

  const root = await prisma.accounts.findUnique({
    where: { guid: book.root_account_guid },
    select: { guid: true, commodity_guid: true, commodity_scu: true },
  });
  if (!root?.commodity_guid) throw new Error('Book root has no commodity');

  let parentGuid = root.guid;
  if (parentName) {
    const parent = await prisma.accounts.findFirst({
      where: { parent_guid: root.guid, name: parentName },
      select: { guid: true },
    });
    if (!parent) throw new Error(`Parent account not found: ${parentName}`);
    parentGuid = parent.guid;
  }

  const graft = () => prisma.$transaction(async (tx) => {
    // Serialize concurrent template grafts (and other book-level operations)
    // on the per-book advisory lock; the graft is idempotent but its
    // find-or-create pairs are not otherwise race-safe. Always the FIRST lock
    // taken, and taken while holding nothing.
    await acquireBookLock(tx, bookGuid, 'add-template-accounts');

    let created = 0;
    let existing = 0;

    /** Root of a subtree that has no row yet: created in phase 3. */
    const missing: Array<{ parent: string; def: TemplateAccountDef }> = [];

    // ---- PHASE 2 — reconcile the accounts that already exist -------------
    // Reads and row-level UPDATEs. No sibling-name lock is held at any point
    // in here, which is precisely what makes taking row locks safe.
    const reconcile = async (accounts: TemplateAccountDef[], parent: string) => {
      for (const def of accounts) {
        const current = await tx.accounts.findFirst({
          where: { parent_guid: parent, name: def.name },
          select: { guid: true, account_type: true, placeholder: true },
        });
        if (!current) {
          // Defer to phase 3, and do NOT descend: everything beneath a node
          // that does not exist yet will be created wholesale under a guid
          // generated in this transaction, so none of it can need a row lock.
          missing.push({ parent, def });
          continue;
        }
        assertTemplateType(def, current.account_type);
        existing++;
        if (def.children?.length) {
          if (current.placeholder === 0) {
            await tx.accounts.update({
              where: { guid: current.guid },
              data: { placeholder: 1 },
            });
          }
          await reconcile(def.children, current.guid);
        }
      }
    };
    await reconcile(defs, parentGuid);

    // ---- PHASE 3 — create what is missing --------------------------------
    // From the first claim below until COMMIT this transaction holds sibling-
    // name locks, so it must not take a row lock on any account it did not
    // itself INSERT. Nothing here does.

    /**
     * Insert a subtree under a parent guid this transaction just generated.
     * No lookup and no name lock: the parent is invisible to every other
     * session until COMMIT, so nothing can exist beneath it and nothing can
     * contend for `account:<parent>:<name>`.
     */
    const createFresh = async (accounts: TemplateAccountDef[], parent: string) => {
      for (const def of accounts) {
        const guid = generateGuid();
        await tx.accounts.create({
          data: {
            guid,
            name: def.name,
            account_type: def.type,
            commodity_guid: root.commodity_guid,
            commodity_scu: root.commodity_scu,
            non_std_scu: 0,
            parent_guid: parent,
            code: '',
            description: '',
            hidden: 0,
            placeholder: def.children?.length ? 1 : 0,
          },
        });
        created++;
        if (def.children?.length) await createFresh(def.children, guid);
      }
    };

    for (const { parent, def } of missing) {
      // The book lock above serializes this graft against other BOOK-LOCKED
      // operations only. Account creation is not one of them: AccountService
      // .create, findOrCreateAccount and the SimpleFin sync all take the
      // per-(parent, name) lock and no book lock, so without claiming that key
      // here a concurrent create lands a duplicate real sibling — and
      // accounts(parent_guid, name) has no unique index to catch it
      // (src/lib/db-init.ts, ACCOUNTS_SIBLING_NAME_INDEX).
      await acquireNamedXactLock(tx, accountNameLockKey(parent, def.name));
      const won = await tx.accounts.findFirst({
        where: { parent_guid: parent, name: def.name },
        select: { guid: true, account_type: true },
      });
      if (won) {
        // Adopted: a concurrent creator committed between phase 2's read and
        // this claim. A leaf is fully reconciled by the type check alone, so
        // it needs no row lock and is simply counted. A node with children
        // would need its placeholder fixed and its subtree walked, both of
        // which belong in phase 2 — retry the transaction rather than reach
        // for a row lock from underneath this name lock.
        assertTemplateType(def, won.account_type);
        if (def.children?.length) throw new SiblingKeyAdoptedError(def.name);
        existing++;
        continue;
      }
      const guid = generateGuid();
      await tx.accounts.create({
        data: {
          guid,
          name: def.name,
          account_type: def.type,
          commodity_guid: root.commodity_guid,
          commodity_scu: root.commodity_scu,
          non_std_scu: 0,
          parent_guid: parent,
          code: '',
          description: '',
          hidden: 0,
          placeholder: def.children?.length ? 1 : 0,
        },
      });
      created++;
      if (def.children?.length) await createFresh(def.children, guid);
    }

    return { created, existing };
  });

  return withAdoptionRetry(graft);
}
