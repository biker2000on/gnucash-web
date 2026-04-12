/**
 * GnuCash XML Importer
 *
 * Imports parsed GnuCash XML data into PostgreSQL via Prisma.
 * Handles commodity lookup/creation, topological account ordering,
 * and fraction string parsing for BigInt fields.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import type { GnuCashXmlData, ImportSummary } from './types';

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
async function clearCollisionRows(tx: any, data: GnuCashXmlData) {
  const transactionGuids = data.transactions.map((t) => t.id).filter(Boolean);
  const budgetGuids = data.budgets.map((b) => b.id).filter(Boolean);
  const priceGuids = data.pricedb.map((p) => p.id).filter((g): g is string => Boolean(g));

  const lotGuids = new Set<string>();
  for (const t of data.transactions) {
    for (const s of t.splits) if (s.lotId) lotGuids.add(s.lotId);
  }

  // Prices — collide on guid when the same book is re-imported.
  if (priceGuids.length) {
    await tx.prices.deleteMany({ where: { guid: { in: priceGuids } } });
  }

  // Budgets — budget_amounts cascade via FK onDelete: Cascade.
  if (budgetGuids.length) {
    await tx.budgets.deleteMany({ where: { guid: { in: budgetGuids } } });
  }

  // Transactions from the XML — splits cascade via FK onDelete: Cascade.
  // Non-XML transactions (e.g. SimpleFin imports) are NOT touched; their
  // splits still reference accounts that will be upserted (not deleted),
  // so the FK stays valid.
  if (transactionGuids.length) {
    await tx.transactions.deleteMany({ where: { guid: { in: transactionGuids } } });
  }

  // Lots referenced by the splits we just deleted.
  if (lotGuids.size) {
    await tx.lots.deleteMany({ where: { guid: { in: Array.from(lotGuids) } } });
  }

  // Accounts and the book row are NOT deleted — the import path upserts
  // them instead, so SimpleFin transactions, account mappings, and
  // permission grants all stay intact.
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

export interface ImportOptions {
  /**
   * If true and the book GUID from the XML already exists, delete the book
   * and every row the incoming XML references before re-importing. If false
   * and the book exists, throw BookAlreadyExistsError.
   */
  overwrite?: boolean;
}

export async function importGnuCashData(
  data: GnuCashXmlData,
  bookName?: string,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    commodities: 0,
    accounts: 0,
    transactions: 0,
    splits: 0,
    prices: 0,
    budgets: 0,
    budgetAmounts: 0,
    skipped: [],
    warnings: [],
  };

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
    const xmlBookGuid = data.book?.id;
    let isOverwrite = false;
    if (xmlBookGuid) {
      const existing = await tx.books.findUnique({ where: { guid: xmlBookGuid } });
      if (existing) {
        if (!options.overwrite) {
          throw new BookAlreadyExistsError(xmlBookGuid);
        }
        isOverwrite = true;
        await clearCollisionRows(tx, data);
      }
    }

    // 1. Create/find commodities
    // Build a map of (space:id) -> database GUID
    const commodityMap = new Map<string, string>();

    // First, load all existing commodities
    const existingCommodities = await tx.commodities.findMany();
    for (const c of existingCommodities) {
      commodityMap.set(`${c.namespace}:${c.mnemonic}`, c.guid);
    }

    // Create missing commodities
    for (const commodity of data.commodities) {
      const key = `${commodity.space}:${commodity.id}`;
      if (commodityMap.has(key)) {
        summary.skipped.push(`Commodity ${key} already exists`);
        continue;
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
      // Create a USD commodity as fallback
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
      commodityMap.set('CURRENCY:USD', rootCommodityGuid);
    }

    const bookGuid = data.book?.id || generateGuid();
    createdBookGuid = bookGuid;

    // On overwrite, reuse the existing root account; on fresh import, create one.
    let rootAccountGuid: string;
    if (isOverwrite) {
      const existingBook = await tx.books.findUnique({ where: { guid: bookGuid } });
      rootAccountGuid = existingBook!.root_account_guid;
      // Update the root account's commodity in case it changed
      await tx.accounts.update({
        where: { guid: rootAccountGuid },
        data: { commodity_guid: rootCommodityGuid },
      });
      // Update the book name
      await tx.books.update({
        where: { guid: bookGuid },
        data: { name: bookName || 'Imported Book' },
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
      await tx.books.create({
        data: {
          guid: bookGuid,
          root_account_guid: rootAccountGuid,
          root_template_guid: rootAccountGuid,
          name: bookName || 'Imported Book',
        },
      });
    }

    // 3. Create accounts in topological order (parents before children)
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
        non_std_scu: 0,
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
      summary.accounts++;
    }

    // 4. Create lots referenced by splits.
    // GnuCash splits can carry a lot_guid; the schema enforces a FK to lots,
    // so lot rows must exist before their splits are inserted. Collect the
    // distinct (lotId, accountGuid) pairs from all splits and insert them
    // up front. A lot belongs to the account of the split that references it.
    const lotAccountMap = new Map<string, string>();
    for (const transaction of data.transactions) {
      for (const split of transaction.splits) {
        if (!split.lotId) continue;
        if (lotAccountMap.has(split.lotId)) continue;
        const accountGuid = accountGuidMap.get(split.accountId);
        if (!accountGuid) continue;
        lotAccountMap.set(split.lotId, accountGuid);
      }
    }
    if (lotAccountMap.size > 0) {
      await tx.lots.createMany({
        data: Array.from(lotAccountMap, ([guid, account_guid]) => ({
          guid,
          account_guid,
          is_closed: 0,
        })),
        skipDuplicates: true,
      });
    }

    // 5. Build transaction + split rows in memory, then createMany them.
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

    for (const transaction of data.transactions) {
      const currencyKey = `${transaction.currency.space}:${transaction.currency.id}`;
      let currencyGuid = commodityMap.get(currencyKey);
      if (!currencyGuid) {
        summary.warnings.push(`Currency ${currencyKey} not found for transaction "${transaction.description}"`);
        currencyGuid = rootCommodityGuid;
      }

      transactionRows.push({
        guid: transaction.id,
        currency_guid: currencyGuid,
        num: transaction.num || '',
        post_date: parseGnuCashDate(transaction.datePosted),
        enter_date: parseGnuCashDate(transaction.dateEntered),
        description: transaction.description,
      });
      summary.transactions++;

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
        summary.splits++;
      }
    }

    // Chunk very large inserts. Postgres caps parameter count at ~65k,
    // so with ~12 columns per row we cap each batch at ~5000 rows.
    const CHUNK = 2000;
    for (let i = 0; i < transactionRows.length; i += CHUNK) {
      await tx.transactions.createMany({ data: transactionRows.slice(i, i + CHUNK) });
    }
    for (let i = 0; i < splitRows.length; i += CHUNK) {
      await tx.splits.createMany({ data: splitRows.slice(i, i + CHUNK) });
    }

    // 6. Create prices
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

    // 7. Create budgets and budget amounts
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
  }, {
    // Large books routinely ship 10k+ splits; default 5s interactive
    // timeout isn't enough. 5 minutes should cover any realistic book.
    maxWait: 10_000,
    timeout: 300_000,
  });

  summary.bookGuid = createdBookGuid;
  return summary;
}
