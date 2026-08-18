/**
 * GnuCash XML Importer
 *
 * Imports parsed GnuCash XML data into PostgreSQL via Prisma.
 * Handles commodity lookup/creation, topological account ordering,
 * and fraction string parsing for BigInt fields.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { acquireBookLock, acquireNamedXactLock, commodityLockKey } from '@/lib/book-lock';
import { createBudgetOwnership } from '@/lib/budget-ownership';
import { slotsToDbRows, type DbSlotRow } from './slots';
import { deleteAvgBasisHistoryForDeletedLots } from '../avg-basis-history';
import {
  OWNER_TYPE_INT_BY_STRING,
  TAXINCLUDED_INT_BY_STRING,
  AMT_TYPE_INT_BY_STRING,
  PAYMENT_INT_BY_STRING,
  TERM_TYPE_DAYS,
  TERM_TYPE_PROXIMO,
  noteAddressSlotSkips,
} from './business';
import type { GnuCashXmlData, GnuCashOwner, ImportSummary } from './types';

/**
 * Parse a GnuCash fraction string like "1234/100" into BigInt numerator and denominator.
 */
function parseFraction(fractionStr: string): { num: bigint; denom: bigint } {
  const parts = fractionStr.split('/');
  if (parts.length === 2) {
    return {
      num: BigInt(parts[0].trim()),
      denom: BigInt(parts[1].trim()),
    };
  }
  // If no slash, treat as whole number with denom 1
  return {
    num: BigInt(parts[0].trim() || '0'),
    denom: 1n,
  };
}

/**
 * Parse a GnuCash date string into a JavaScript Date.
 * GnuCash dates look like: "2024-01-15 10:30:00 +0000"
 */
function parseGnuCashDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  // Try direct ISO parse first
  const trimmed = dateStr.trim();
  // Replace space between date and time with 'T' for ISO format
  const isoLike = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2');
  const date = new Date(isoLike);
  if (!isNaN(date.getTime())) return date;
  // Fallback: try as-is
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) return fallback;
  return null;
}

/**
 * Topologically sort accounts so parents come before children.
 */
function topologicalSortAccounts(
  accounts: GnuCashXmlData['accounts']
): GnuCashXmlData['accounts'] {
  const sorted: GnuCashXmlData['accounts'] = [];
  const visited = new Set<string>();
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  function visit(id: string) {
    if (visited.has(id)) return;
    const account = accountById.get(id);
    if (!account) return;

    // Visit parent first
    if (account.parentId && accountById.has(account.parentId)) {
      visit(account.parentId);
    }

    visited.add(id);
    sorted.push(account);
  }

  for (const account of accounts) {
    visit(account.id);
  }

  return sorted;
}

/**
 * Delete slots rows for the given object guids, following frame/list
 * children the way upstream gnc_sql_slots_delete does: frame and list
 * rows carry a child guid in guid_val, and the children's rows live
 * under that guid — a flat obj_guid delete would orphan them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deleteSlotsRecursive(tx: any, objGuids: string[]) {
  if (objGuids.length === 0) return;
  const CHUNK = 5000;
  const seen = new Set(objGuids);
  let frontier = objGuids;
  const allGuids = [...objGuids];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += CHUNK) {
      const rows = await tx.slots.findMany({
        where: {
          obj_guid: { in: frontier.slice(i, i + CHUNK) },
          slot_type: { in: [8, 9] }, // list, frame
        },
        select: { guid_val: true },
      });
      for (const row of rows as Array<{ guid_val: string | null }>) {
        if (row.guid_val && !seen.has(row.guid_val)) {
          seen.add(row.guid_val);
          next.push(row.guid_val);
        }
      }
    }
    allGuids.push(...next);
    frontier = next;
  }
  for (let i = 0; i < allGuids.length; i += CHUNK) {
    await tx.slots.deleteMany({ where: { obj_guid: { in: allGuids.slice(i, i + CHUNK) } } });
  }
}

/**
 * Delete every row that the incoming XML would collide with, in the
 * order the FK graph requires. Used when re-importing a book with
 * overwrite: true. Runs inside the caller's interactive transaction.
 *
 * Commodities are deliberately left alone — they're shared across
 * books and the insert path already skips duplicates. Prices collide
 * on their own guid if the same book is re-imported, so we delete the
 * specific price rows the incoming XML is about to re-insert.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function clearCollisionRows(tx: any, data: GnuCashXmlData, bookGuid: string) {
  // Template transactions collide exactly like ordinary transactions (they
  // share the transactions/splits tables), so clear them in the same pass.
  const transactionGuids = [
    ...data.transactions.map((t) => t.id),
    ...(data.templateTransactions ?? []).map((t) => t.id),
  ].filter(Boolean);
  const budgetGuids = data.budgets.map((b) => b.id).filter(Boolean);
  const priceGuids = data.pricedb.map((p) => p.id).filter((g): g is string => Boolean(g));
  const sxGuids = (data.schedxactions ?? []).map((s) => s.id).filter(Boolean);

  // Validate every native budget collision before deleting ANY rows. An
  // overwrite may replace a budget only when its immutable owner is the same
  // book. Missing ownership is also unsafe: legacy ambiguous budgets must
  // remain quarantined instead of being guessed and re-homed.
  if (budgetGuids.length) {
    const existingBudgets = await tx.budgets.findMany({
      where: { guid: { in: budgetGuids } },
      select: { guid: true },
    });
    const existingBudgetGuids = existingBudgets.map((budget: { guid: string }) => budget.guid);
    if (existingBudgetGuids.length) {
      const ownershipRows = await tx.gnucash_web_budget_ownership.findMany({
        where: { budget_guid: { in: existingBudgetGuids } },
        select: { budget_guid: true, book_guid: true },
      });
      const ownerByBudget = new Map<string, string>(
        ownershipRows.map((row: { budget_guid: string; book_guid: string }) => [
          row.budget_guid,
          row.book_guid,
        ]),
      );
      const unsafeBudgetGuid = existingBudgetGuids.find(
        (budgetGuid: string) => ownerByBudget.get(budgetGuid) !== bookGuid,
      );
      if (unsafeBudgetGuid) {
        throw new BudgetOwnershipConflictError(unsafeBudgetGuid, bookGuid);
      }
    }
  }

  const lotGuids = new Set<string>();
  for (const t of data.transactions) {
    for (const s of t.splits) if (s.lotId) lotGuids.add(s.lotId);
  }
  // Lots declared under act:lots also collide on re-import.
  for (const a of data.accounts) {
    for (const lot of a.lots ?? []) if (lot.id) lotGuids.add(lot.id);
  }

  // Business entities — child-first, mirroring the ordering in
  // deleteOwnedBusinessEntitiesForBook (entity-ownership.ts): entries →
  // invoices/orders → jobs → customers/vendors/employees → taxtables/
  // billterms. None of these tables carry FKs, so the ordering is about
  // never leaving a parentless child behind if the delete is interrupted.
  // Their slots and ownership rows go with them; ownership is re-recorded
  // by the insert phase.
  const guidsOf = (items: Array<{ guid: string }> | undefined) =>
    (items ?? []).map((item) => item.guid).filter(Boolean);
  const businessGuids = {
    entry: guidsOf(data.entries),
    invoice: guidsOf(data.invoices),
    order: guidsOf(data.orders),
    job: guidsOf(data.jobs),
    customer: guidsOf(data.customers),
    vendor: guidsOf(data.vendors),
    employee: guidsOf(data.employees),
    taxtable: guidsOf(data.taxtables),
    billterm: guidsOf(data.billterms),
  };
  const hasBusinessCollisions = Object.values(businessGuids).some((g) => g.length > 0);
  if (hasBusinessCollisions) {
    await deleteSlotsRecursive(tx, Object.values(businessGuids).flat());
    // Entries attached to incoming invoices/bills/orders are cleared too,
    // even when their own guids differ (a re-import replaces the document's
    // line items wholesale — leftovers would double the invoice).
    const entryOr: Array<Record<string, unknown>> = [];
    if (businessGuids.entry.length) entryOr.push({ guid: { in: businessGuids.entry } });
    if (businessGuids.invoice.length) {
      entryOr.push({ invoice: { in: businessGuids.invoice } });
      entryOr.push({ bill: { in: businessGuids.invoice } });
    }
    if (businessGuids.order.length) entryOr.push({ order_guid: { in: businessGuids.order } });
    if (entryOr.length) await tx.entries.deleteMany({ where: { OR: entryOr } });
    if (businessGuids.invoice.length) {
      await tx.invoices.deleteMany({ where: { guid: { in: businessGuids.invoice } } });
    }
    if (businessGuids.order.length) {
      await tx.orders.deleteMany({ where: { guid: { in: businessGuids.order } } });
    }
    if (businessGuids.job.length) {
      await tx.jobs.deleteMany({ where: { guid: { in: businessGuids.job } } });
    }
    if (businessGuids.customer.length) {
      await tx.customers.deleteMany({ where: { guid: { in: businessGuids.customer } } });
    }
    if (businessGuids.vendor.length) {
      await tx.vendors.deleteMany({ where: { guid: { in: businessGuids.vendor } } });
    }
    if (businessGuids.employee.length) {
      await tx.employees.deleteMany({ where: { guid: { in: businessGuids.employee } } });
    }
    if (businessGuids.taxtable.length) {
      await tx.taxtable_entries.deleteMany({
        where: { taxtable: { in: businessGuids.taxtable } },
      });
      await tx.taxtables.deleteMany({ where: { guid: { in: businessGuids.taxtable } } });
    }
    if (businessGuids.billterm.length) {
      await tx.billterms.deleteMany({ where: { guid: { in: businessGuids.billterm } } });
    }
    const ownershipOr = Object.entries(businessGuids)
      .filter(([type, guids]) => type !== 'entry' && guids.length > 0)
      .map(([type, guids]) => ({ entity_type: type, entity_guid: { in: guids } }));
    if (ownershipOr.length) {
      await tx.gnucash_web_business_entity_ownership.deleteMany({
        where: { OR: ownershipOr },
      });
    }
  }

  // Prices — collide on guid when the same book is re-imported.
  if (priceGuids.length) {
    await tx.prices.deleteMany({ where: { guid: { in: priceGuids } } });
  }

  // Budgets — budget_amounts cascade via FK onDelete: Cascade. Recurrences
  // must go FIRST: their obj_guid FK to budgets is ON DELETE RESTRICT, so
  // deleting a budget that still has its recurrence row would fail. Budget
  // slots have no FK, so clear them explicitly before the row goes away.
  if (budgetGuids.length) {
    await deleteSlotsRecursive(tx, budgetGuids);
    await tx.recurrences.deleteMany({ where: { obj_guid: { in: budgetGuids } } });
    await tx.budgets.deleteMany({ where: { guid: { in: budgetGuids } } });
  }

  // Scheduled transactions — recurrences (obj_guid = sx guid) and sx:slots
  // rows first, then the schedxactions rows themselves.
  if (sxGuids.length) {
    await deleteSlotsRecursive(tx, sxGuids);
    await tx.recurrences.deleteMany({ where: { obj_guid: { in: sxGuids } } });
    await tx.schedxactions.deleteMany({ where: { guid: { in: sxGuids } } });
  }

  // Transactions from the XML — splits cascade via FK onDelete: Cascade.
  // Non-XML transactions (e.g. SimpleFin imports) are NOT touched; their
  // splits still reference accounts that will be upserted (not deleted),
  // so the FK stays valid.
  if (transactionGuids.length) {
    // The slots table has no FK on obj_guid: collect the split guids the
    // cascade is about to remove and delete their slots plus the
    // transactions' own slots, or they leak as orphans.
    const splitRows = await tx.splits.findMany({
      where: { tx_guid: { in: transactionGuids } },
      select: { guid: true },
    });
    const slotObjGuids = [
      ...splitRows.map((row: { guid: string }) => row.guid),
      ...transactionGuids,
    ];
    await deleteSlotsRecursive(tx, slotObjGuids);
    await tx.transactions.deleteMany({ where: { guid: { in: transactionGuids } } });
  }

  // Lots referenced by the splits we just deleted — slots first (no FK).
  if (lotGuids.size) {
    const lotGuidList = Array.from(lotGuids);
    await deleteSlotsRecursive(tx, lotGuidList);
    // The average-cost write history is app-owned and keyed by lot GUID, with
    // no FK to `lots`. Lot GUIDs survive an export/import round trip unchanged,
    // so without this the incoming lot inherits the outgoing lot's pooled-basis
    // stack — and a restored book then trips the repair-required guard on a
    // basis that is not actually damaged.
    await deleteAvgBasisHistoryForDeletedLots(lotGuidList, tx);
    await tx.lots.deleteMany({ where: { guid: { in: lotGuidList } } });
  }

  // Accounts and the book row are NOT deleted — the import path upserts
  // them instead, so SimpleFin transactions, account mappings, and
  // permission grants all stay intact. Their slot frames ARE replaced:
  // the incoming XML carries the authoritative KVP for these objects and
  // re-inserting without clearing would duplicate every slot row.
  // Template accounts follow the same upsert-and-replace-slots rule.
  const accountGuids = [
    ...data.accounts,
    ...(data.templateAccounts ?? []),
  ]
    .filter((a) => a.type !== 'ROOT')
    .map((a) => a.id)
    .filter(Boolean);
  await deleteSlotsRecursive(tx, [...accountGuids, bookGuid]);
}

/**
 * Import parsed GnuCash XML data into the database.
 */
export class BookAlreadyExistsError extends Error {
  readonly code = 'BOOK_EXISTS';
  constructor(public readonly bookGuid: string) {
    super(`Book ${bookGuid} already exists. Pass overwrite: true to replace it.`);
    this.name = 'BookAlreadyExistsError';
  }
}

export class BudgetOwnershipConflictError extends Error {
  readonly code = 'BUDGET_OWNERSHIP_CONFLICT';
  constructor(
    public readonly budgetGuid: string,
    public readonly bookGuid: string,
  ) {
    super(`Budget ${budgetGuid} cannot be overwritten by book ${bookGuid}`);
    this.name = 'BudgetOwnershipConflictError';
  }
}

export interface ImportProgress {
  phase: string;
  progress: number;
  detail?: string;
}

export interface ImportOptions {
  overwrite?: boolean;
  onProgress?: (progress: ImportProgress) => void;
}

export async function importGnuCashData(
  data: GnuCashXmlData,
  bookName?: string,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const emit = options.onProgress ?? (() => {});
  const summary: ImportSummary = {
    commodities: 0,
    accounts: 0,
    transactions: 0,
    splits: 0,
    prices: 0,
    budgets: 0,
    budgetAmounts: 0,
    slots: 0,
    lots: 0,
    schedxactions: 0,
    billterms: 0,
    taxtables: 0,
    customers: 0,
    vendors: 0,
    employees: 0,
    jobs: 0,
    invoices: 0,
    entries: 0,
    orders: 0,
    skipped: [],
    warnings: [],
  };

  const templateAccounts = data.templateAccounts ?? [];
  const templateTransactions = data.templateTransactions ?? [];
  const schedxactions = data.schedxactions ?? [];

  // Parse-time skips (binary slot values etc.) surface here so nothing
  // that was recognized-but-unmodeled disappears silently.
  if (data.skipped?.length) {
    summary.skipped.push(...data.skipped);
  }

  let createdBookGuid = '';

  await prisma.$transaction(async (tx) => {
    // The import fans out into thousands of inserts per book. We keep a
    // single transaction for atomic rollback, but batch the hot loops with
    // createMany so we don't blow past Prisma's interactive timeout.

    // 0. Re-import guard. Books, accounts, transactions etc. preserve
    // their original XML guids as primary keys, so importing the same
    // XML twice collides. If the caller opted in to overwrite, delete
    // every row the incoming XML references (in the correct FK order)
    // before re-inserting; otherwise bail with a structured error so
    // the API can surface a confirmation prompt.
    emit({ phase: 'Preparing', progress: 0 });

    const xmlBookGuid = data.book?.id;
    let isOverwrite = false;
    if (xmlBookGuid) {
      // Serialize against other book-level operations (scrub-all, book
      // delete, reparenting, a second import of the same book). Blocking
      // acquire: the transaction itself provides atomicity; the lock keeps
      // other LOCKED operations from interleaving with a long overwrite
      // import. Must be taken BEFORE the BookAlreadyExistsError check so
      // two concurrent imports of the same book serialize on it.
      await acquireBookLock(tx, xmlBookGuid, 'xml-import');
      const existing = await tx.books.findUnique({ where: { guid: xmlBookGuid } });
      if (existing) {
        if (!options.overwrite) {
          throw new BookAlreadyExistsError(xmlBookGuid);
        }
        isOverwrite = true;
        emit({ phase: 'Clearing old data', progress: 2 });
        await clearCollisionRows(tx, data, xmlBookGuid);
      }
    }

    // KVP slot rows accumulated across all stages, inserted in one batched
    // pass at the end (the slots table has no FKs, so order is free).
    const slotRowsBuffer: DbSlotRow[] = [];

    // 1. Create/find commodities
    emit({ phase: 'Commodities', progress: 5, detail: `${data.commodities.length} commodities` });
    // Build a map of (space:id) -> database GUID
    const commodityMap = new Map<string, string>();

    // First, load all existing commodities
    const existingCommodities = await tx.commodities.findMany();
    for (const c of existingCommodities) {
      commodityMap.set(`${c.namespace}:${c.mnemonic}`, c.guid);
    }

    // Create missing commodities. Commodities are shared across books and
    // there is (not yet) a unique index on (namespace, mnemonic), so the
    // check-then-insert is guarded by a per-commodity advisory lock with a
    // re-check after acquiring it — a concurrent import creating the same
    // commodity serializes here instead of inserting a duplicate.
    for (const commodity of data.commodities) {
      // The `template` namespace commodity is GnuCash's internal marker for
      // SX template accounts — never a real commodity to create or price.
      // Template accounts resolve their commodity separately below.
      if (commodity.space === 'template') {
        continue;
      }
      const key = `${commodity.space}:${commodity.id}`;
      if (commodityMap.has(key)) {
        summary.skipped.push(`Commodity ${key} already exists`);
        if (commodity.slots?.length) {
          summary.skipped.push(`cmdty:slots for ${key} skipped (commodity already exists)`);
        }
        continue;
      }

      const locked = await acquireNamedXactLock(tx, commodityLockKey(commodity.space, commodity.id));
      if (locked) {
        const existingNow = await tx.commodities.findFirst({
          where: { namespace: commodity.space, mnemonic: commodity.id },
        });
        if (existingNow) {
          commodityMap.set(key, existingNow.guid);
          summary.skipped.push(`Commodity ${key} already exists`);
          if (commodity.slots?.length) {
            summary.skipped.push(`cmdty:slots for ${key} skipped (commodity already exists)`);
          }
          continue;
        }
      }

      const guid = generateGuid();
      await tx.commodities.create({
        data: {
          guid,
          namespace: commodity.space,
          mnemonic: commodity.id,
          fullname: commodity.name || null,
          cusip: commodity.xcode || null,
          fraction: commodity.fraction || 100,
          quote_flag: commodity.quoteFlag || 0,
          quote_source: commodity.quoteSource || null,
          quote_tz: commodity.quoteTz || null,
        },
      });
      commodityMap.set(key, guid);
      if (commodity.slots?.length) {
        slotRowsBuffer.push(...slotsToDbRows(guid, commodity.slots));
      }
      summary.commodities++;
    }

    // 2. Create a new book with root account
    // Find USD commodity for root account (fallback to first CURRENCY commodity)
    let rootCommodityGuid = commodityMap.get('CURRENCY:USD');
    if (!rootCommodityGuid) {
      // Try to find any currency commodity
      for (const [key, guid] of commodityMap) {
        if (key.startsWith('CURRENCY:')) {
          rootCommodityGuid = guid;
          break;
        }
      }
    }
    if (!rootCommodityGuid) {
      // Create a USD commodity as fallback (same advisory-lock guard as above)
      const locked = await acquireNamedXactLock(tx, commodityLockKey('CURRENCY', 'USD'));
      const existingUsd = locked
        ? await tx.commodities.findFirst({
            where: { namespace: 'CURRENCY', mnemonic: 'USD' },
          })
        : null;
      if (existingUsd) {
        rootCommodityGuid = existingUsd.guid;
      } else {
        rootCommodityGuid = generateGuid();
        await tx.commodities.create({
          data: {
            guid: rootCommodityGuid,
            namespace: 'CURRENCY',
            mnemonic: 'USD',
            fullname: 'US Dollar',
            cusip: null,
            fraction: 100,
            quote_flag: 1,
            quote_source: 'currency',
            quote_tz: null,
          },
        });
      }
      commodityMap.set('CURRENCY:USD', rootCommodityGuid);
    }

    const bookGuid = data.book?.id || generateGuid();
    createdBookGuid = bookGuid;

    // Native GnuCash SQL databases carry a template:template commodity row;
    // when one exists, template accounts point at it. We never CREATE one —
    // on databases without it, template accounts fall back to the book
    // currency (the same convention scheduled-tx-create uses).
    const templateCommodityGuid = commodityMap.get('template:template');
    const templateAccountCommodityGuid = () => templateCommodityGuid ?? rootCommodityGuid!;

    // The XML template root (under gnc:template-transactions) keeps its guid
    // on fresh imports so sx:templ-acct references and re-exports stay
    // stable. It is always DISTINCT from the real root account.
    const xmlTemplateRoot = templateAccounts.find((a) => a.type === 'ROOT');

    // On overwrite, reuse the existing root account; on fresh import, create one.
    let rootAccountGuid: string;
    let templateRootGuid: string;
    if (isOverwrite) {
      const existingBook = await tx.books.findUnique({ where: { guid: bookGuid } });
      rootAccountGuid = existingBook!.root_account_guid;
      templateRootGuid = existingBook!.root_template_guid;
      // Update the root account's commodity in case it changed
      await tx.accounts.update({
        where: { guid: rootAccountGuid },
        data: { commodity_guid: rootCommodityGuid },
      });
      // Repair books written by the pre-wave-2 importer, which pointed
      // root_template_guid at the real root account: give the book a
      // distinct template root so SX templates have a home of their own.
      const needsTemplateRootRepair =
        !templateRootGuid || templateRootGuid === rootAccountGuid;
      if (needsTemplateRootRepair) {
        templateRootGuid = xmlTemplateRoot?.id || generateGuid();
      }
      await tx.accounts.upsert({
        where: { guid: templateRootGuid },
        create: {
          guid: templateRootGuid,
          name: xmlTemplateRoot?.name || 'Template Root',
          account_type: 'ROOT',
          commodity_guid: templateAccountCommodityGuid(),
          commodity_scu: xmlTemplateRoot?.commodityScu || 100,
          non_std_scu: 0,
          parent_guid: null,
          hidden: 0,
          placeholder: 0,
        },
        update: {},
      });
      // Update the book name (and the repaired template root, if any)
      await tx.books.update({
        where: { guid: bookGuid },
        data: {
          name: bookName || 'Imported Book',
          ...(needsTemplateRootRepair ? { root_template_guid: templateRootGuid } : {}),
        },
      });
    } else {
      rootAccountGuid = generateGuid();
      await tx.accounts.create({
        data: {
          guid: rootAccountGuid,
          name: 'Root Account',
          account_type: 'ROOT',
          commodity_guid: rootCommodityGuid,
          commodity_scu: 100,
          non_std_scu: 0,
          parent_guid: null,
          hidden: 0,
          placeholder: 0,
        },
      });
      templateRootGuid = xmlTemplateRoot?.id || generateGuid();
      await tx.accounts.create({
        data: {
          guid: templateRootGuid,
          name: xmlTemplateRoot?.name || 'Template Root',
          account_type: 'ROOT',
          commodity_guid: templateAccountCommodityGuid(),
          commodity_scu: xmlTemplateRoot?.commodityScu || 100,
          non_std_scu: 0,
          parent_guid: null,
          hidden: 0,
          placeholder: 0,
        },
      });
      await tx.books.create({
        data: {
          guid: bookGuid,
          root_account_guid: rootAccountGuid,
          root_template_guid: templateRootGuid,
          name: bookName || 'Imported Book',
        },
      });
    }

    // book:slots (options, counters, features) — obj_guid is the book guid.
    // On overwrite the old book slots were cleared in clearCollisionRows.
    if (data.book?.slots?.length) {
      slotRowsBuffer.push(...slotsToDbRows(bookGuid, data.book.slots));
    }

    // 3. Create accounts in topological order (parents before children)
    emit({ phase: 'Accounts', progress: 15, detail: `${data.accounts.length} accounts` });
    const sortedAccounts = topologicalSortAccounts(data.accounts);
    const accountGuidMap = new Map<string, string>(); // old GUID -> new GUID (preserve originals)

    // Find the XML root account (the one with no parent or type ROOT)
    const xmlRootAccounts = data.accounts.filter(
      (a) => a.type === 'ROOT' || !a.parentId
    );
    const xmlRootIds = new Set(xmlRootAccounts.map((a) => a.id));

    for (const account of sortedAccounts) {
      // Skip ROOT accounts from the XML - we've already created our own
      if (account.type === 'ROOT') {
        accountGuidMap.set(account.id, rootAccountGuid);
        summary.skipped.push(`Root account "${account.name}" mapped to new root`);
        if (account.slots?.length) {
          summary.skipped.push(
            `act:slots for root account "${account.name}" skipped (root is remapped)`,
          );
        }
        continue;
      }

      // Determine parent GUID
      let parentGuid: string | null = null;
      if (account.parentId) {
        if (xmlRootIds.has(account.parentId)) {
          // Parent is the XML root, map to our root
          parentGuid = rootAccountGuid;
        } else {
          parentGuid = accountGuidMap.get(account.parentId) || null;
        }
      } else {
        // No parent -> child of root
        parentGuid = rootAccountGuid;
      }

      // Resolve commodity GUID
      let commodityGuid: string | null = null;
      if (account.commodity) {
        const key = `${account.commodity.space}:${account.commodity.id}`;
        commodityGuid = commodityMap.get(key) || null;
        if (!commodityGuid) {
          summary.warnings.push(`Commodity ${key} not found for account "${account.name}"`);
          commodityGuid = rootCommodityGuid; // fallback to root commodity
        }
      } else {
        commodityGuid = rootCommodityGuid;
      }

      // Preserve original GUID from XML
      const accountGuid = account.id;
      accountGuidMap.set(account.id, accountGuid);

      const accountData = {
        name: account.name,
        account_type: account.type,
        commodity_guid: commodityGuid,
        commodity_scu: account.commodityScu || 100,
        non_std_scu: account.nonStdScu ? 1 : 0,
        parent_guid: parentGuid,
        code: account.code || null,
        description: account.description || null,
        hidden: account.hidden ? 1 : 0,
        placeholder: account.placeholder ? 1 : 0,
      };

      if (isOverwrite) {
        await tx.accounts.upsert({
          where: { guid: accountGuid },
          create: { guid: accountGuid, ...accountData },
          update: accountData,
        });
      } else {
        await tx.accounts.create({
          data: { guid: accountGuid, ...accountData },
        });
      }
      // Full act:slots passthrough (hidden/placeholder/notes stay mirrored
      // in their columns above, matching the native GnuCash SQL backend
      // which stores both the columns and the KVP rows).
      if (account.slots?.length) {
        slotRowsBuffer.push(...slotsToDbRows(accountGuid, account.slots));
      }
      summary.accounts++;
    }

    // 3b. Template accounts (gnc:template-transactions) — preserved guids so
    // sx:templ-acct references resolve; parented under the book's DISTINCT
    // template root. Their `template` namespace commodity maps to the native
    // template commodity row when the database has one, else the book
    // currency. Not counted in summary.accounts (they are not book accounts,
    // matching gnc:count-data which never counts template contents).
    if (templateAccounts.length > 0) {
      emit({
        phase: 'Template accounts',
        progress: 28,
        detail: `${templateAccounts.length} template accounts`,
      });
    }
    for (const account of topologicalSortAccounts(templateAccounts)) {
      if (account.type === 'ROOT') {
        // The XML template root maps to the book's template root (same guid
        // on fresh imports; the pre-existing one on overwrite).
        accountGuidMap.set(account.id, templateRootGuid);
        if (account.id !== templateRootGuid && account.slots?.length) {
          summary.skipped.push(
            `act:slots for template root "${account.name}" skipped (template root is remapped)`,
          );
        } else if (account.slots?.length) {
          slotRowsBuffer.push(...slotsToDbRows(templateRootGuid, account.slots));
        }
        continue;
      }

      const parentGuid = account.parentId
        ? accountGuidMap.get(account.parentId) ?? templateRootGuid
        : templateRootGuid;

      let commodityGuid: string;
      if (!account.commodity || account.commodity.space === 'template') {
        commodityGuid = templateAccountCommodityGuid();
      } else {
        const key = `${account.commodity.space}:${account.commodity.id}`;
        commodityGuid = commodityMap.get(key) ?? templateAccountCommodityGuid();
      }

      const accountGuid = account.id;
      accountGuidMap.set(account.id, accountGuid);

      const accountData = {
        name: account.name,
        account_type: account.type,
        commodity_guid: commodityGuid,
        commodity_scu: account.commodityScu || 100,
        non_std_scu: account.nonStdScu ? 1 : 0,
        parent_guid: parentGuid,
        code: account.code || null,
        description: account.description || null,
        hidden: account.hidden ? 1 : 0,
        placeholder: account.placeholder ? 1 : 0,
      };

      if (isOverwrite) {
        await tx.accounts.upsert({
          where: { guid: accountGuid },
          create: { guid: accountGuid, ...accountData },
          update: accountData,
        });
      } else {
        await tx.accounts.create({ data: { guid: accountGuid, ...accountData } });
      }
      if (account.slots?.length) {
        slotRowsBuffer.push(...slotsToDbRows(accountGuid, account.slots));
      }
    }

    // 4. Create lots: declared act:lots first (they carry title/notes in
    // lot:slots), then any lot referenced only via split:lot. The schema
    // enforces a FK from splits.lot_guid to lots, so all lot rows must
    // exist before splits are inserted.
    emit({ phase: 'Lots', progress: 30 });

    // A lot is closed when its splits' quantities sum to zero (there is no
    // is_closed element in XML — closure is derived, see the lot section of
    // the schema inventory). Sum the raw fractions exactly with bigints.
    const lotBalances = new Map<string, { num: bigint; denom: bigint }>();
    for (const transaction of data.transactions) {
      for (const split of transaction.splits) {
        if (!split.lotId) continue;
        const quantity = parseFraction(split.quantity);
        const balance = lotBalances.get(split.lotId);
        if (!balance) {
          lotBalances.set(split.lotId, { num: quantity.num, denom: quantity.denom });
        } else {
          // a/b + c/d = (ad + cb) / bd — exact, no reduction needed for a
          // zero test.
          balance.num = balance.num * quantity.denom + quantity.num * balance.denom;
          balance.denom = balance.denom * quantity.denom;
        }
      }
    }
    const lotIsClosed = (lotGuid: string): number => {
      const balance = lotBalances.get(lotGuid);
      return balance && balance.num === 0n ? 1 : 0;
    };

    const lotRowMap = new Map<string, { account_guid: string; is_closed: number }>();
    // Declared lots (act:lots > gnc:lot) — the owning account is explicit.
    for (const account of data.accounts) {
      for (const lot of account.lots ?? []) {
        const accountGuid = accountGuidMap.get(account.id);
        if (!accountGuid) {
          summary.skipped.push(
            `Lot ${lot.id} skipped: owning account ${account.id} was not imported`,
          );
          continue;
        }
        lotRowMap.set(lot.id, { account_guid: accountGuid, is_closed: lotIsClosed(lot.id) });
        if (lot.slots?.length) {
          slotRowsBuffer.push(...slotsToDbRows(lot.id, lot.slots));
        }
      }
    }
    // Undeclared lots referenced by split:lot — a lot belongs to the
    // account of the split that references it.
    for (const transaction of data.transactions) {
      for (const split of transaction.splits) {
        if (!split.lotId) continue;
        if (lotRowMap.has(split.lotId)) continue;
        const accountGuid = accountGuidMap.get(split.accountId);
        if (!accountGuid) continue;
        lotRowMap.set(split.lotId, {
          account_guid: accountGuid,
          is_closed: lotIsClosed(split.lotId),
        });
      }
    }
    if (lotRowMap.size > 0) {
      await tx.lots.createMany({
        data: Array.from(lotRowMap, ([guid, row]) => ({ guid, ...row })),
        skipDuplicates: true,
      });
    }
    summary.lots = lotRowMap.size;

    // 5. Build transaction + split rows in memory, then createMany them.
    emit({ phase: 'Transactions', progress: 35, detail: `${data.transactions.length} transactions` });
    // Splits FK-reference transactions, so transactions must be inserted
    // first — but within each table we can batch a single INSERT.
    const transactionRows: Array<{
      guid: string;
      currency_guid: string;
      num: string;
      post_date: Date | null;
      enter_date: Date | null;
      description: string;
    }> = [];
    const splitRows: Array<{
      guid: string;
      tx_guid: string;
      account_guid: string;
      memo: string;
      action: string;
      reconcile_state: string;
      reconcile_date: Date | null;
      value_num: bigint;
      value_denom: bigint;
      quantity_num: bigint;
      quantity_denom: bigint;
      lot_guid: string | null;
    }> = [];

    // Template transactions ride the same batched insert: they live in the
    // same tables, only their splits reference template accounts and carry
    // the sched-xaction KVP frame in split:slots (written through the
    // generic codec below, matching the native SQL layout). They are not
    // counted in summary.transactions/splits.
    const addTransactionRows = (
      transaction: GnuCashXmlData['transactions'][0],
      isTemplate: boolean,
    ) => {
      const currencyKey = `${transaction.currency.space}:${transaction.currency.id}`;
      let currencyGuid = commodityMap.get(currencyKey);
      if (!currencyGuid) {
        summary.warnings.push(`Currency ${currencyKey} not found for transaction "${transaction.description}"`);
        currencyGuid = rootCommodityGuid!;
      }

      transactionRows.push({
        guid: transaction.id,
        currency_guid: currencyGuid,
        num: transaction.num || '',
        post_date: parseGnuCashDate(transaction.datePosted),
        enter_date: parseGnuCashDate(transaction.dateEntered),
        description: transaction.description,
      });
      // trn:slots passthrough — includes the date-posted gdate slot, which
      // is preserved as a slot; post_date above keeps coming from the
      // trn:date-posted timespec, unchanged.
      if (transaction.slots?.length) {
        slotRowsBuffer.push(...slotsToDbRows(transaction.id, transaction.slots));
      }
      if (!isTemplate) summary.transactions++;

      for (const split of transaction.splits) {
        const accountGuid = accountGuidMap.get(split.accountId);
        if (!accountGuid) {
          summary.warnings.push(
            `Account ${split.accountId} not found for split in transaction "${transaction.description}"`
          );
          continue;
        }

        const value = parseFraction(split.value);
        const quantity = parseFraction(split.quantity);

        if (split.slots?.length) {
          slotRowsBuffer.push(...slotsToDbRows(split.id, split.slots));
        }

        splitRows.push({
          guid: split.id,
          tx_guid: transaction.id,
          account_guid: accountGuid,
          memo: split.memo || '',
          action: split.action || '',
          reconcile_state: split.reconciledState || 'n',
          reconcile_date: split.reconcileDate ? parseGnuCashDate(split.reconcileDate) : null,
          value_num: value.num,
          value_denom: value.denom,
          quantity_num: quantity.num,
          quantity_denom: quantity.denom,
          lot_guid: split.lotId || null,
        });
        if (!isTemplate) summary.splits++;
      }
    };

    for (const transaction of data.transactions) {
      addTransactionRows(transaction, false);
    }
    for (const transaction of templateTransactions) {
      addTransactionRows(transaction, true);
    }

    // Chunk very large inserts. Postgres caps parameter count at ~65k,
    // so with ~12 columns per row we cap each batch at ~5000 rows.
    const CHUNK = 2000;
    emit({ phase: 'Writing transactions', progress: 50, detail: `${transactionRows.length} transactions` });
    for (let i = 0; i < transactionRows.length; i += CHUNK) {
      await tx.transactions.createMany({ data: transactionRows.slice(i, i + CHUNK) });
      emit({ phase: 'Writing transactions', progress: 50 + Math.round((i / Math.max(transactionRows.length, 1)) * 10), detail: `${Math.min(i + CHUNK, transactionRows.length)}/${transactionRows.length}` });
    }
    emit({ phase: 'Writing splits', progress: 60, detail: `${splitRows.length} splits` });
    for (let i = 0; i < splitRows.length; i += CHUNK) {
      await tx.splits.createMany({ data: splitRows.slice(i, i + CHUNK) });
      emit({ phase: 'Writing splits', progress: 60 + Math.round((i / Math.max(splitRows.length, 1)) * 15), detail: `${Math.min(i + CHUNK, splitRows.length)}/${splitRows.length}` });
    }

    // 6. Scheduled transactions — after template accounts/transactions so
    // template_act_guid targets exist; one recurrences row per
    // gnc:recurrence (obj_guid = sx guid; composite/semi-monthly SXs have
    // several — the app evaluates all of them, ASI-1-006).
    if (schedxactions.length > 0) {
      emit({
        phase: 'Scheduled transactions',
        progress: 76,
        detail: `${schedxactions.length} scheduled transactions`,
      });
    }
    const gdateToDbDate = (gdate: string): Date | null =>
      /^\d{4}-\d{2}-\d{2}$/.test(gdate) ? new Date(`${gdate}T00:00:00.000Z`) : null;
    for (const sx of schedxactions) {
      const templateActGuid = accountGuidMap.get(sx.templateAccountId);
      if (!templateActGuid) {
        summary.warnings.push(
          `Scheduled transaction "${sx.name}" skipped: template account ` +
            `${sx.templateAccountId} was not found under gnc:template-transactions`,
        );
        continue;
      }
      await tx.schedxactions.create({
        data: {
          guid: sx.id,
          name: sx.name,
          enabled: sx.enabled ? 1 : 0,
          start_date: gdateToDbDate(sx.start),
          end_date: sx.end ? gdateToDbDate(sx.end) : null,
          last_occur: sx.last ? gdateToDbDate(sx.last) : null,
          // num_occur 0 = no occurrence-count definition, matching the
          // native SQL backend (the XML omits num-occur/rem-occur then).
          num_occur: sx.numOccur ?? 0,
          rem_occur: sx.remOccur ?? 0,
          auto_create: sx.autoCreate ? 1 : 0,
          auto_notify: sx.autoCreateNotify ? 1 : 0,
          adv_creation: sx.advanceCreateDays,
          adv_notify: sx.advanceRemindDays,
          instance_count: sx.instanceCount,
          template_act_guid: templateActGuid,
        },
      });
      for (const recurrence of sx.schedule) {
        await tx.recurrences.create({
          data: {
            obj_guid: sx.id,
            recurrence_mult: recurrence.mult,
            recurrence_period_type: recurrence.periodType,
            recurrence_period_start: new Date(`${recurrence.periodStart}T00:00:00.000Z`),
            recurrence_weekend_adjust: recurrence.weekendAdjust || 'none',
          },
        });
      }
      if (sx.schedule.length === 0) {
        summary.warnings.push(
          `Scheduled transaction "${sx.name}" has no recurrence schedule — imported without one`,
        );
      }
      // sx:deferredInstance has NO representation in the native SQL schema
      // (gnc-schedxaction-sql.cpp persists none of it) — record as skipped.
      if (sx.deferredInstances?.length) {
        summary.skipped.push(
          `Scheduled transaction "${sx.name}": ${sx.deferredInstances.length} deferred ` +
            'instance(s) skipped (sx:deferredInstance has no representation in the ' +
            'GnuCash SQL schema)',
        );
      }
      if (sx.slots?.length) {
        slotRowsBuffer.push(...slotsToDbRows(sx.id, sx.slots));
      }
      summary.schedxactions++;
    }

    // 7. Create prices
    emit({ phase: 'Prices', progress: 78, detail: `${data.pricedb.length} prices` });
    const priceRows: Array<{
      guid: string;
      commodity_guid: string;
      currency_guid: string;
      date: Date;
      source: string | null;
      type: string | null;
      value_num: bigint;
      value_denom: bigint;
    }> = [];
    for (const price of data.pricedb) {
      const commodityKey = `${price.commodity.space}:${price.commodity.id}`;
      const currencyKey = `${price.currency.space}:${price.currency.id}`;
      const commodityGuid = commodityMap.get(commodityKey);
      const currencyGuid = commodityMap.get(currencyKey);

      if (!commodityGuid || !currencyGuid) {
        summary.warnings.push(
          `Price skipped: commodity ${commodityKey} or currency ${currencyKey} not found`
        );
        continue;
      }

      const priceDate = parseGnuCashDate(price.date);
      if (!priceDate) {
        summary.warnings.push(`Price skipped: invalid date "${price.date}"`);
        continue;
      }

      const value = parseFraction(price.value);
      priceRows.push({
        guid: price.id || generateGuid(),
        commodity_guid: commodityGuid,
        currency_guid: currencyGuid,
        date: priceDate,
        source: price.source || null,
        type: price.type || null,
        value_num: value.num,
        value_denom: value.denom,
      });
      summary.prices++;
    }
    for (let i = 0; i < priceRows.length; i += CHUNK) {
      await tx.prices.createMany({ data: priceRows.slice(i, i + CHUNK) });
    }

    // 8. Create budgets and budget amounts
    emit({ phase: 'Budgets', progress: 90, detail: `${data.budgets.length} budgets` });
    const budgetAmountRows: Array<{
      budget_guid: string;
      account_guid: string;
      period_num: number;
      amount_num: bigint;
      amount_denom: bigint;
    }> = [];
    for (const budget of data.budgets) {
      await tx.budgets.create({
        data: {
          guid: budget.id,
          name: budget.name,
          description: budget.description || null,
          num_periods: budget.numPeriods,
        },
      });
      await createBudgetOwnership(tx, budget.id, bookGuid);
      // Budget recurrence (period calendar) — after the budget row, since
      // recurrences.obj_guid has an FK to budgets.guid. GnuCash always
      // writes one; without it start dates, current-budget picks, and
      // seasonal estimates degrade to fallbacks.
      if (budget.recurrence) {
        await tx.recurrences.create({
          data: {
            obj_guid: budget.id,
            recurrence_mult: budget.recurrence.mult,
            recurrence_period_type: budget.recurrence.periodType,
            recurrence_period_start: new Date(`${budget.recurrence.periodStart}T00:00:00.000Z`),
            recurrence_weekend_adjust: budget.recurrence.weekendAdjust || 'none',
          },
        });
      }
      // Non-amount bgt:slots passthrough (amounts go to budget_amounts).
      if (budget.slots?.length) {
        slotRowsBuffer.push(...slotsToDbRows(budget.id, budget.slots));
      }
      summary.budgets++;

      // GnuCash leaves orphaned budget slots behind when an account is
      // deleted, so a single missing account can appear under many
      // periods (up to num-periods). Count them per budget and emit one
      // summary warning instead of flooding the summary with duplicates.
      const orphanAccountCounts = new Map<string, number>();

      for (const amount of budget.amounts) {
        const accountGuid = accountGuidMap.get(amount.accountId);
        if (!accountGuid) {
          orphanAccountCounts.set(
            amount.accountId,
            (orphanAccountCounts.get(amount.accountId) ?? 0) + 1,
          );
          continue;
        }
        const amountFraction = parseFraction(amount.amount);
        budgetAmountRows.push({
          budget_guid: budget.id,
          account_guid: accountGuid,
          period_num: amount.periodNum,
          amount_num: amountFraction.num,
          amount_denom: amountFraction.denom,
        });
        summary.budgetAmounts++;
      }

      if (orphanAccountCounts.size > 0) {
        const totalSkipped = Array.from(orphanAccountCounts.values()).reduce((a, b) => a + b, 0);
        summary.warnings.push(
          `Budget "${budget.name}": skipped ${totalSkipped} amount(s) across ${orphanAccountCounts.size} deleted account(s) — these are orphan slots GnuCash left behind when the accounts were removed.`,
        );
      }
    }
    for (let i = 0; i < budgetAmountRows.length; i += CHUNK) {
      await tx.budget_amounts.createMany({ data: budgetAmountRows.slice(i, i + CHUNK) });
    }

    // 9. Business objects — dependency order: billterms + taxtables first
    // (leaf dependencies), then customers/vendors/employees, then jobs,
    // then invoices, then entries, then orders. The native business tables
    // have no FKs, so this ordering is about referential hygiene, not
    // constraints; forward references inside the XML (upstream writes
    // business objects last and allows refs in any direction) are handled
    // by resolving every ref against the full incoming sets built up
    // front. Every entity gets a gnucash_web_business_entity_ownership row
    // in this same transaction — missing ownership means the entity is
    // invisible to every book (entity-ownership.ts).
    const billterms = data.billterms ?? [];
    const taxtables = data.taxtables ?? [];
    const customers = data.customers ?? [];
    const vendors = data.vendors ?? [];
    const employees = data.employees ?? [];
    const jobs = data.jobs ?? [];
    const invoices = data.invoices ?? [];
    const entries = data.entries ?? [];
    const orders = data.orders ?? [];
    const businessTotal =
      billterms.length + taxtables.length + customers.length + vendors.length +
      employees.length + jobs.length + invoices.length + entries.length + orders.length;

    if (businessTotal > 0) {
      emit({ phase: 'Business objects', progress: 93, detail: `${businessTotal} business objects` });

      // Incoming-XML reference sets. References are resolved ONLY against
      // this import, never against pre-existing rows: a guid that happens
      // to collide with another book's data must not silently link to it.
      const billtermGuids = new Set(billterms.map((t) => t.guid));
      const taxtableGuids = new Set(taxtables.map((t) => t.guid));
      const customerGuids = new Set(customers.map((c) => c.guid));
      const vendorGuids = new Set(vendors.map((v) => v.guid));
      const employeeGuids = new Set(employees.map((e) => e.guid));
      const jobGuids = new Set(jobs.map((j) => j.guid));
      const invoiceGuids = new Set(invoices.map((i) => i.guid));
      const orderGuids = new Set(orders.map((o) => o.guid));
      const transactionGuids = new Set(data.transactions.map((t) => t.id));
      const importedLotGuids = new Set(lotRowMap.keys());
      const ownerSetByType: Record<string, Set<string>> = {
        gncCustomer: customerGuids,
        gncJob: jobGuids,
        gncVendor: vendorGuids,
        gncEmployee: employeeGuids,
      };

      /** Resolve a guid ref against an incoming set; dangling → warn + null. */
      const resolveRef = (
        guid: string | undefined,
        validGuids: Set<string>,
        context: string,
        refName: string,
      ): string | null => {
        if (!guid) return null;
        if (validGuids.has(guid)) return guid;
        summary.warnings.push(`${context}: dangling ${refName} reference ${guid} dropped`);
        return null;
      };

      /**
       * Resolve an account ref through accountGuidMap (XML guid → DB guid;
       * identical except for remapped roots); dangling → warn + null.
       */
      const resolveAccountRef = (
        guid: string | undefined,
        context: string,
        refName: string,
      ): string | null => {
        if (!guid) return null;
        const mapped = accountGuidMap.get(guid);
        if (mapped) return mapped;
        summary.warnings.push(`${context}: dangling ${refName} reference ${guid} dropped`);
        return null;
      };

      /** Resolve an owner (type string + guid) to native int columns. */
      const resolveOwner = (
        owner: GnuCashOwner | undefined,
        context: string,
      ): { owner_type: number; owner_guid: string } | null => {
        if (!owner) return null;
        const ownerTypeInt = OWNER_TYPE_INT_BY_STRING[owner.type];
        if (ownerTypeInt === undefined) {
          summary.warnings.push(`${context}: unknown owner type "${owner.type}" dropped`);
          return null;
        }
        if (!ownerSetByType[owner.type].has(owner.id)) {
          summary.warnings.push(
            `${context}: dangling ${owner.type} owner reference ${owner.id} dropped`,
          );
          return null;
        }
        return { owner_type: ownerTypeInt, owner_guid: owner.id };
      };

      /** Resolve a currency commodity ref, falling back to the book currency. */
      const resolveCurrency = (
        currency: { space: string; id: string },
        context: string,
      ): string => {
        const key = `${currency.space}:${currency.id}`;
        const guid = commodityMap.get(key);
        if (guid) return guid;
        summary.warnings.push(`${context}: currency ${key} not found — using book currency`);
        return rootCommodityGuid!;
      };

      const ownershipRows: Array<{
        entity_type: string;
        entity_guid: string;
        book_guid: string;
      }> = [];
      const own = (entityType: string, entityGuid: string) => {
        ownershipRows.push({
          entity_type: entityType,
          entity_guid: entityGuid,
          book_guid: bookGuid,
        });
      };
      const pushSlots = (guid: string, slots: GnuCashXmlData['book']['slots']) => {
        if (slots?.length) slotRowsBuffer.push(...slotsToDbRows(guid, slots));
      };

      // 9a. Bill terms. billterm:child is not persisted (the native SQL
      // backend has no column for it either — the child pointer is derived
      // from the children's parent refs on load).
      if (billterms.length > 0) {
        await tx.billterms.createMany({
          data: billterms.map((term) => {
            const context = `Bill term "${term.name}"`;
            if (term.childId) {
              summary.skipped.push(
                `${context}: billterm:child ref skipped (no native column; GnuCash re-derives it from parent refs)`,
              );
            }
            const variant = term.proximo ?? term.days ?? {};
            const discount = 'discount' in variant && variant.discount
              ? parseFraction(variant.discount)
              : null;
            own('billterm', term.guid);
            pushSlots(term.guid, term.slots);
            return {
              guid: term.guid,
              name: term.name,
              description: term.description,
              refcount: term.refcount,
              invisible: term.invisible ? 1 : 0,
              parent: resolveRef(term.parentId, billtermGuids, context, 'billterm:parent'),
              type: term.proximo ? TERM_TYPE_PROXIMO : TERM_TYPE_DAYS,
              duedays: term.proximo ? term.proximo.dueDay ?? 0 : term.days?.dueDays ?? 0,
              discountdays: term.proximo
                ? term.proximo.discountDay ?? 0
                : term.days?.discountDays ?? 0,
              discount_num: discount ? discount.num : 0n,
              discount_denom: discount ? discount.denom : 1n,
              cutoff: term.proximo ? term.proximo.cutoffDay ?? 0 : null,
            };
          }),
        });
        summary.billterms = billterms.length;
      }

      // 9b. Tax tables + entries. taxtable:child is derived, like billterm.
      if (taxtables.length > 0) {
        const taxtableEntryRows: Array<{
          taxtable: string;
          account: string;
          amount_num: bigint;
          amount_denom: bigint;
          type: number;
        }> = [];
        await tx.taxtables.createMany({
          data: taxtables.map((table) => {
            const context = `Tax table "${table.name}"`;
            if (table.childId) {
              summary.skipped.push(
                `${context}: taxtable:child ref skipped (no native column; GnuCash re-derives it from parent refs)`,
              );
            }
            for (const entry of table.entries) {
              const account = entry.accountId && accountGuidMap.has(entry.accountId)
                ? accountGuidMap.get(entry.accountId)!
                : null;
              if (!account) {
                summary.warnings.push(
                  `${context}: entry skipped — tax account ${entry.accountId ?? '(none)'} was not imported`,
                );
                continue;
              }
              const amount = parseFraction(entry.amount);
              taxtableEntryRows.push({
                taxtable: table.guid,
                account,
                amount_num: amount.num,
                amount_denom: amount.denom,
                type: AMT_TYPE_INT_BY_STRING[entry.type] ?? 1,
              });
            }
            own('taxtable', table.guid);
            pushSlots(table.guid, table.slots);
            return {
              guid: table.guid,
              name: table.name,
              refcount: BigInt(table.refcount),
              invisible: table.invisible ? 1 : 0,
              parent: resolveRef(table.parentId, taxtableGuids, context, 'taxtable:parent'),
            };
          }),
        });
        if (taxtableEntryRows.length > 0) {
          await tx.taxtable_entries.createMany({ data: taxtableEntryRows });
        }
        summary.taxtables = taxtables.length;
      }

      // 9c. Customers.
      if (customers.length > 0) {
        await tx.customers.createMany({
          data: customers.map((customer) => {
            const context = `Customer "${customer.name}"`;
            const discount = parseFraction(customer.discount);
            const credit = parseFraction(customer.credit);
            noteAddressSlotSkips(context, summary.skipped, customer.addr, customer.shipaddr);
            own('customer', customer.guid);
            pushSlots(customer.guid, customer.slots);
            return {
              guid: customer.guid,
              name: customer.name,
              id: customer.id,
              notes: customer.notes ?? '',
              active: customer.active ? 1 : 0,
              discount_num: discount.num,
              discount_denom: discount.denom,
              credit_num: credit.num,
              credit_denom: credit.denom,
              currency: resolveCurrency(customer.currency, context),
              tax_override: customer.useTaxTable ? 1 : 0,
              addr_name: customer.addr.name ?? null,
              addr_addr1: customer.addr.addr1 ?? null,
              addr_addr2: customer.addr.addr2 ?? null,
              addr_addr3: customer.addr.addr3 ?? null,
              addr_addr4: customer.addr.addr4 ?? null,
              addr_phone: customer.addr.phone ?? null,
              addr_fax: customer.addr.fax ?? null,
              addr_email: customer.addr.email ?? null,
              shipaddr_name: customer.shipaddr.name ?? null,
              shipaddr_addr1: customer.shipaddr.addr1 ?? null,
              shipaddr_addr2: customer.shipaddr.addr2 ?? null,
              shipaddr_addr3: customer.shipaddr.addr3 ?? null,
              shipaddr_addr4: customer.shipaddr.addr4 ?? null,
              shipaddr_phone: customer.shipaddr.phone ?? null,
              shipaddr_fax: customer.shipaddr.fax ?? null,
              shipaddr_email: customer.shipaddr.email ?? null,
              terms: resolveRef(customer.termsId, billtermGuids, context, 'cust:terms'),
              tax_included:
                TAXINCLUDED_INT_BY_STRING[customer.taxIncluded] ??
                TAXINCLUDED_INT_BY_STRING.USEGLOBAL,
              taxtable: resolveRef(customer.taxTableId, taxtableGuids, context, 'cust:taxtable'),
            };
          }),
        });
        summary.customers = customers.length;
      }

      // 9d. Vendors. tax_inc is stored as the upstream string
      // (YES/NO/USEGLOBAL — gncTaxIncludedTypeToString), matching the
      // native SQL backend's tax-included-string column.
      if (vendors.length > 0) {
        await tx.vendors.createMany({
          data: vendors.map((vendor) => {
            const context = `Vendor "${vendor.name}"`;
            noteAddressSlotSkips(context, summary.skipped, vendor.addr);
            own('vendor', vendor.guid);
            pushSlots(vendor.guid, vendor.slots);
            return {
              guid: vendor.guid,
              name: vendor.name,
              id: vendor.id,
              notes: vendor.notes ?? '',
              currency: resolveCurrency(vendor.currency, context),
              active: vendor.active ? 1 : 0,
              tax_override: vendor.useTaxTable ? 1 : 0,
              addr_name: vendor.addr.name ?? null,
              addr_addr1: vendor.addr.addr1 ?? null,
              addr_addr2: vendor.addr.addr2 ?? null,
              addr_addr3: vendor.addr.addr3 ?? null,
              addr_addr4: vendor.addr.addr4 ?? null,
              addr_phone: vendor.addr.phone ?? null,
              addr_fax: vendor.addr.fax ?? null,
              addr_email: vendor.addr.email ?? null,
              terms: resolveRef(vendor.termsId, billtermGuids, context, 'vendor:terms'),
              tax_inc: vendor.taxIncluded,
              tax_table: resolveRef(vendor.taxTableId, taxtableGuids, context, 'vendor:taxtable'),
            };
          }),
        });
        summary.vendors = vendors.length;
      }

      // 9e. Employees. ccard resolves against the imported account tree.
      if (employees.length > 0) {
        await tx.employees.createMany({
          data: employees.map((employee) => {
            const context = `Employee "${employee.username}"`;
            const workday = parseFraction(employee.workday);
            const rate = parseFraction(employee.rate);
            noteAddressSlotSkips(context, summary.skipped, employee.addr);
            own('employee', employee.guid);
            pushSlots(employee.guid, employee.slots);
            return {
              guid: employee.guid,
              username: employee.username,
              id: employee.id,
              language: employee.language ?? '',
              acl: employee.acl ?? '',
              active: employee.active ? 1 : 0,
              currency: resolveCurrency(employee.currency, context),
              ccard_guid: resolveAccountRef(employee.ccardId, context, 'employee:ccard'),
              workday_num: workday.num,
              workday_denom: workday.denom,
              rate_num: rate.num,
              rate_denom: rate.denom,
              addr_name: employee.addr.name ?? null,
              addr_addr1: employee.addr.addr1 ?? null,
              addr_addr2: employee.addr.addr2 ?? null,
              addr_addr3: employee.addr.addr3 ?? null,
              addr_addr4: employee.addr.addr4 ?? null,
              addr_phone: employee.addr.phone ?? null,
              addr_fax: employee.addr.fax ?? null,
              addr_email: employee.addr.email ?? null,
            };
          }),
        });
        summary.employees = employees.length;
      }

      // 9f. Jobs — owner is a customer or vendor.
      if (jobs.length > 0) {
        await tx.jobs.createMany({
          data: jobs.map((job) => {
            const context = `Job "${job.name}"`;
            const owner = resolveOwner(job.owner, context);
            own('job', job.guid);
            pushSlots(job.guid, job.slots);
            return {
              guid: job.guid,
              id: job.id,
              name: job.name,
              reference: job.reference ?? '',
              active: job.active ? 1 : 0,
              owner_type: owner?.owner_type ?? null,
              owner_guid: owner?.owner_guid ?? null,
            };
          }),
        });
        summary.jobs = jobs.length;
      }

      // 9g. Invoices. posttxn/postlot/postacc must resolve against the
      // already-imported transactions/lots/accounts of THIS import; a
      // dangling ref becomes a warning and a null column, never a crash.
      if (invoices.length > 0) {
        await tx.invoices.createMany({
          data: invoices.map((invoice) => {
            const context = `Invoice "${invoice.id || invoice.guid}"`;
            const owner = resolveOwner(invoice.owner, context);
            const billTo = resolveOwner(invoice.billTo, context);
            const chargeAmt = invoice.chargeAmt ? parseFraction(invoice.chargeAmt) : null;
            own('invoice', invoice.guid);
            pushSlots(invoice.guid, invoice.slots);
            return {
              guid: invoice.guid,
              id: invoice.id,
              date_opened: parseGnuCashDate(invoice.opened),
              date_posted: invoice.posted ? parseGnuCashDate(invoice.posted) : null,
              notes: invoice.notes ?? '',
              active: invoice.active ? 1 : 0,
              currency: resolveCurrency(invoice.currency, context),
              owner_type: owner?.owner_type ?? null,
              owner_guid: owner?.owner_guid ?? null,
              terms: resolveRef(invoice.termsId, billtermGuids, context, 'invoice:terms'),
              billing_id: invoice.billingId ?? null,
              post_txn: resolveRef(invoice.postTxnId, transactionGuids, context, 'invoice:posttxn'),
              post_lot: resolveRef(invoice.postLotId, importedLotGuids, context, 'invoice:postlot'),
              post_acc: resolveAccountRef(invoice.postAccId, context, 'invoice:postacc'),
              billto_type: billTo?.owner_type ?? null,
              billto_guid: billTo?.owner_guid ?? null,
              charge_amt_num: chargeAmt ? chargeAmt.num : null,
              charge_amt_denom: chargeAmt ? chargeAmt.denom : null,
            };
          }),
        });
        summary.invoices = invoices.length;
      }

      // 9h. Entries. An entry with no surviving attachment (invoice, bill,
      // and order all missing or dangling) is skipped: entries carry no
      // ownership row of their own — book scope reaches them through their
      // document — so an unattached row would be permanently orphaned.
      if (entries.length > 0) {
        const entryRows: Array<{
          guid: string;
          date: Date;
          date_entered: Date | null;
          description: string | null;
          action: string | null;
          notes: string | null;
          quantity_num: bigint | null;
          quantity_denom: bigint | null;
          i_acct: string | null;
          i_price_num: bigint | null;
          i_price_denom: bigint | null;
          i_discount_num: bigint | null;
          i_discount_denom: bigint | null;
          invoice: string | null;
          i_disc_type: string | null;
          i_disc_how: string | null;
          i_taxable: number | null;
          i_taxincluded: number | null;
          i_taxtable: string | null;
          b_acct: string | null;
          b_price_num: bigint | null;
          b_price_denom: bigint | null;
          bill: string | null;
          b_taxable: number | null;
          b_taxincluded: number | null;
          b_taxtable: string | null;
          b_paytype: number | null;
          billable: number | null;
          billto_type: number | null;
          billto_guid: string | null;
          order_guid: string | null;
        }> = [];
        for (const entry of entries) {
          const context = `Entry ${entry.guid}`;
          const invoiceRef = resolveRef(entry.invoiceId, invoiceGuids, context, 'entry:invoice');
          const billRef = resolveRef(entry.billId, invoiceGuids, context, 'entry:bill');
          const orderRef = resolveRef(entry.orderId, orderGuids, context, 'entry:order');
          if (!invoiceRef && !billRef && !orderRef) {
            summary.warnings.push(
              `${context} skipped: no resolvable invoice/bill/order attachment (an unattached entry would be invisible to every book)`,
            );
            continue;
          }
          const billTo = resolveOwner(entry.billTo, context);
          const quantity = entry.quantity ? parseFraction(entry.quantity) : null;
          const iPrice = entry.iPrice ? parseFraction(entry.iPrice) : null;
          const iDiscount = entry.iDiscount ? parseFraction(entry.iDiscount) : null;
          const bPrice = entry.bPrice ? parseFraction(entry.bPrice) : null;
          pushSlots(entry.guid, entry.slots);
          entryRows.push({
            guid: entry.guid,
            date: parseGnuCashDate(entry.date) ?? new Date(0),
            date_entered: entry.entered ? parseGnuCashDate(entry.entered) : null,
            description: entry.description ?? null,
            action: entry.action ?? null,
            notes: entry.notes ?? null,
            quantity_num: quantity ? quantity.num : null,
            quantity_denom: quantity ? quantity.denom : null,
            i_acct: resolveAccountRef(entry.iAcctId, context, 'entry:i-acct'),
            i_price_num: iPrice ? iPrice.num : null,
            i_price_denom: iPrice ? iPrice.denom : null,
            i_discount_num: iDiscount ? iDiscount.num : null,
            i_discount_denom: iDiscount ? iDiscount.denom : null,
            invoice: invoiceRef,
            i_disc_type: entry.iDiscType ?? null,
            i_disc_how: entry.iDiscHow ?? null,
            i_taxable: entry.iTaxable === undefined ? null : entry.iTaxable ? 1 : 0,
            i_taxincluded: entry.iTaxIncluded === undefined ? null : entry.iTaxIncluded ? 1 : 0,
            i_taxtable: resolveRef(entry.iTaxTableId, taxtableGuids, context, 'entry:i-taxtable'),
            b_acct: resolveAccountRef(entry.bAcctId, context, 'entry:b-acct'),
            b_price_num: bPrice ? bPrice.num : null,
            b_price_denom: bPrice ? bPrice.denom : null,
            bill: billRef,
            b_taxable: entry.bTaxable === undefined ? null : entry.bTaxable ? 1 : 0,
            b_taxincluded: entry.bTaxIncluded === undefined ? null : entry.bTaxIncluded ? 1 : 0,
            b_taxtable: resolveRef(entry.bTaxTableId, taxtableGuids, context, 'entry:b-taxtable'),
            b_paytype: entry.bPayment ? PAYMENT_INT_BY_STRING[entry.bPayment] ?? null : null,
            billable: entry.billable === undefined ? null : entry.billable ? 1 : 0,
            billto_type: billTo?.owner_type ?? null,
            billto_guid: billTo?.owner_guid ?? null,
            order_guid: orderRef,
          });
          summary.entries++;
        }
        if (entryRows.length > 0) {
          for (let i = 0; i < entryRows.length; i += CHUNK) {
            await tx.entries.createMany({ data: entryRows.slice(i, i + CHUNK) });
          }
        }
      }

      // 9i. Orders — near-dead upstream, but fully round-tripped. The
      // native orders table requires an owner and a date_closed; an order
      // whose owner cannot be resolved is skipped (warned), and a missing
      // order:closed is stored as epoch 0 (the unset time64 convention).
      if (orders.length > 0) {
        const orderRows: Array<{
          guid: string;
          id: string;
          notes: string;
          reference: string;
          active: number;
          date_opened: Date;
          date_closed: Date;
          owner_type: number;
          owner_guid: string;
        }> = [];
        for (const order of orders) {
          const context = `Order "${order.id || order.guid}"`;
          const owner = resolveOwner(order.owner, context);
          if (!owner) {
            summary.warnings.push(`${context} skipped: owner did not resolve`);
            continue;
          }
          own('order', order.guid);
          pushSlots(order.guid, order.slots);
          orderRows.push({
            guid: order.guid,
            id: order.id,
            notes: order.notes ?? '',
            reference: order.reference ?? '',
            active: order.active ? 1 : 0,
            date_opened: parseGnuCashDate(order.opened) ?? new Date(0),
            date_closed: order.closed
              ? parseGnuCashDate(order.closed) ?? new Date(0)
              : new Date(0),
            owner_type: owner.owner_type,
            owner_guid: owner.owner_guid,
          });
          summary.orders++;
        }
        if (orderRows.length > 0) {
          await tx.orders.createMany({ data: orderRows });
        }
      }

      // Ownership rows — same transaction as the entity inserts, so no
      // entity can commit unowned (invisible-forever) rows.
      if (ownershipRows.length > 0) {
        for (let i = 0; i < ownershipRows.length; i += CHUNK) {
          await tx.gnucash_web_business_entity_ownership.createMany({
            data: ownershipRows.slice(i, i + CHUNK),
          });
        }
      }
    }

    // 10. Write accumulated KVP slot rows (book, commodity, account, lot,
    // transaction, split, schedxaction, budget, business entities). No FKs
    // on the slots table, so a single batched pass at the end is safe.
    if (slotRowsBuffer.length > 0) {
      emit({ phase: 'Slots', progress: 96, detail: `${slotRowsBuffer.length} slot rows` });
      for (let i = 0; i < slotRowsBuffer.length; i += CHUNK) {
        await tx.slots.createMany({ data: slotRowsBuffer.slice(i, i + CHUNK) });
      }
    }
    summary.slots = slotRowsBuffer.length;
  }, {
    // Large books routinely ship 10k+ splits; default 5s interactive
    // timeout isn't enough. 5 minutes should cover any realistic book.
    maxWait: 10_000,
    timeout: 300_000,
  });

  emit({ phase: 'Complete', progress: 100 });
  summary.bookGuid = createdBookGuid;
  return summary;
}
