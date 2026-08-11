/**
 * GnuCash XML Exporter
 *
 * Exports data from the PostgreSQL database into the GnuCashXmlData format
 * suitable for building into GnuCash XML files.
 */

import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import {
  dbRowsToSlots,
  indexDbSlotRows,
  type LoadedSlotRow,
} from './slots';
import type {
  GnuCashXmlData,
  GnuCashCommodity,
  GnuCashPrice,
  GnuCashAccount,
  GnuCashTransaction,
  GnuCashBudget,
  GnuCashBudgetAmount,
  GnuCashLot,
  GnuCashSlot,
  GnuCashSchedXAction,
  GnuCashRecurrence,
} from './types';

/**
 * Format BigInt numerator and denominator as a fraction string "num/denom".
 */
function toFractionString(num: bigint, denom: bigint): string {
  return `${num}/${denom}`;
}

/**
 * Format a Date as a GnuCash timestamp string.
 */
function formatGnuCashDate(date: Date | null): string {
  if (!date) return '';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000');
}

/**
 * Load all slots rows for the given object guids, chasing frame/list
 * children (their rows live under the guid stored in guid_val, the way
 * upstream gnc-slots-sql.cpp lays them out) until the tree is complete.
 */
async function loadSlotRowsRecursive(objGuids: string[]): Promise<LoadedSlotRow[]> {
  const CHUNK = 5000;
  const all: LoadedSlotRow[] = [];
  const seen = new Set(objGuids);
  let frontier = objGuids;
  while (frontier.length > 0) {
    const batch: LoadedSlotRow[] = [];
    for (let i = 0; i < frontier.length; i += CHUNK) {
      const rows = await prisma.slots.findMany({
        where: { obj_guid: { in: frontier.slice(i, i + CHUNK) } },
      });
      batch.push(...(rows as LoadedSlotRow[]));
    }
    all.push(...batch);
    const next: string[] = [];
    for (const row of batch) {
      // 8 = list, 9 = frame — children live under guid_val
      if ((row.slot_type === 8 || row.slot_type === 9) && row.guid_val && !seen.has(row.guid_val)) {
        seen.add(row.guid_val);
        next.push(row.guid_val);
      }
    }
    frontier = next;
  }
  return all;
}

/**
 * Export all data for a book (identified by root account GUID) into GnuCashXmlData.
 */
export async function exportBookData(rootAccountGuid: string): Promise<GnuCashXmlData> {
  // Get the book record
  const book = await prisma.books.findFirst({
    where: { root_account_guid: rootAccountGuid },
  });

  if (!book) {
    throw new Error('Book not found for the given root account');
  }

  // Get all account GUIDs recursively under the root
  const accountRows = await prisma.$queryRaw<{ guid: string }[]>`
    WITH RECURSIVE account_tree AS (
      SELECT guid FROM accounts WHERE parent_guid = ${rootAccountGuid}
      UNION ALL
      SELECT a.guid FROM accounts a
      JOIN account_tree t ON a.parent_guid = t.guid
    )
    SELECT guid FROM account_tree
  `;

  const guids = accountRows.map((a) => a.guid);

  // Include the root account itself
  guids.push(rootAccountGuid);

  // Fetch all accounts with their commodities
  const accounts = await prisma.accounts.findMany({
    where: { guid: { in: guids } },
    include: { commodity: true },
  });

  // Collect all commodity GUIDs used by accounts and transactions
  const commodityGuids = new Set<string>();
  for (const acc of accounts) {
    if (acc.commodity_guid) commodityGuids.add(acc.commodity_guid);
  }

  // Fetch transactions that have splits in our accounts
  // Use the non-root account guids (exclude root for split matching)
  const nonRootGuids = guids.filter((g) => g !== rootAccountGuid);
  const transactions = await prisma.transactions.findMany({
    where: {
      splits: { some: { account_guid: { in: nonRootGuids } } },
    },
    include: {
      splits: true,
      currency: true,
    },
  });

  // Add transaction currency commodity GUIDs
  for (const tx of transactions) {
    commodityGuids.add(tx.currency_guid);
  }

  // Fetch all referenced commodities
  const commodities = await prisma.commodities.findMany({
    where: { guid: { in: Array.from(commodityGuids) } },
  });

  // Fetch prices only for commodities actually used by this book's accounts
  // Use AND (both commodity and currency must be in our set) to avoid pulling
  // prices from other books that happen to share a currency
  const prices = await prisma.prices.findMany({
    where: {
      commodity_guid: { in: Array.from(commodityGuids) },
      currency_guid: { in: Array.from(commodityGuids) },
    },
    include: {
      commodity: true,
      currency: true,
    },
  });

  // Export only budgets explicitly owned by this book. The native budgets table
  // has no book GUID, so account membership remains a defense-in-depth filter
  // on each budget's amounts rather than the primary scope check.
  const ownershipRows = await prisma.gnucash_web_budget_ownership.findMany({
    where: { book_guid: book.guid },
    select: { budget_guid: true },
  });
  const ownedBudgetGuids = ownershipRows.map((row) => row.budget_guid);
  const allBudgets = ownedBudgetGuids.length > 0
    ? await prisma.budgets.findMany({
      where: { guid: { in: ownedBudgetGuids } },
      include: {
        amounts: { where: { account_guid: { in: guids } } },
        recurrences: true,
      },
    })
    : [];
  const guidSet = new Set(guids);
  const budgets = allBudgets
    .filter((b) => ownedBudgetGuids.includes(b.guid))
    .map((b) => ({
      ...b,
      amounts: b.amounts.filter((a) => guidSet.has(a.account_guid)),
    }));

  // Fetch lots owned by this book's accounts (title/notes live in slots).
  const lots = await prisma.lots.findMany({
    where: { account_guid: { in: guids } },
  });

  // Template tree: the book's DISTINCT template root and its descendants
  // (SX template accounts and their template transactions). Books written
  // by the pre-wave-2 importer pointed root_template_guid at the real root
  // account — for those there is no separate template tree to export.
  const templateRootGuid =
    book.root_template_guid && book.root_template_guid !== rootAccountGuid
      ? book.root_template_guid
      : null;
  let templateTreeGuids: string[] = [];
  if (templateRootGuid) {
    const templateRows = await prisma.$queryRaw<{ guid: string }[]>`
      WITH RECURSIVE template_tree AS (
        SELECT guid FROM accounts WHERE guid = ${templateRootGuid}
        UNION ALL
        SELECT a.guid FROM accounts a
        JOIN template_tree t ON a.parent_guid = t.guid
      )
      SELECT guid FROM template_tree
    `;
    templateTreeGuids = templateRows.map((r) => r.guid);
  }
  const templateAccountRows = templateTreeGuids.length
    ? await prisma.accounts.findMany({ where: { guid: { in: templateTreeGuids } } })
    : [];
  const templateTransactionRows = templateTreeGuids.length
    ? await prisma.transactions.findMany({
        where: { splits: { some: { account_guid: { in: templateTreeGuids } } } },
        include: { splits: true },
      })
    : [];

  // Template transactions are posted in a real currency (the book currency
  // in practice); make sure it is present in the commodity lookup.
  const knownCommodityGuids = new Set(commodities.map((c) => c.guid));
  const missingTemplateCurrencyGuids = [
    ...new Set(
      templateTransactionRows
        .map((t) => t.currency_guid)
        .filter((g) => !knownCommodityGuids.has(g)),
    ),
  ];
  if (missingTemplateCurrencyGuids.length > 0) {
    const extra = await prisma.commodities.findMany({
      where: { guid: { in: missingTemplateCurrencyGuids } },
    });
    commodities.push(...extra);
  }

  // Scheduled transactions whose template account lives in this book's
  // template tree, plus their recurrence rows (obj_guid = sx guid).
  const sxRows = templateTreeGuids.length
    ? await prisma.schedxactions.findMany({
        where: { template_act_guid: { in: templateTreeGuids } },
        orderBy: { guid: 'asc' },
      })
    : [];
  const sxRecurrenceRows = sxRows.length
    ? await prisma.recurrences.findMany({
        where: { obj_guid: { in: sxRows.map((s) => s.guid) } },
        orderBy: { id: 'asc' },
      })
    : [];
  const recurrencesBySx = new Map<string, typeof sxRecurrenceRows>();
  for (const row of sxRecurrenceRows) {
    const list = recurrencesBySx.get(row.obj_guid);
    if (list) list.push(row);
    else recurrencesBySx.set(row.obj_guid, [row]);
  }

  // Load every KVP slot tree in one recursive pass: book, accounts,
  // transactions, splits, lots, commodities, budgets, template accounts,
  // template transactions/splits, scheduled transactions.
  const slotOwnerGuids = [
    book.guid,
    ...guids,
    ...transactions.map((t) => t.guid),
    ...transactions.flatMap((t) => t.splits.map((s) => s.guid)),
    ...lots.map((l) => l.guid),
    ...commodities.map((c) => c.guid),
    ...budgets.map((b) => b.guid),
    ...templateTreeGuids,
    ...templateTransactionRows.map((t) => t.guid),
    ...templateTransactionRows.flatMap((t) => t.splits.map((s) => s.guid)),
    ...sxRows.map((s) => s.guid),
  ];
  const loadedSlotRows = await loadSlotRowsRecursive(slotOwnerGuids);

  // App-created SX templates (scheduled-tx-create) store the real-account
  // mapping as an account-owned row: name 'account', slot_type 4 (string),
  // guid_val = the real account. Capture the mapping for sched-xaction
  // frame synthesis below, and keep the rows out of the exported act:slots
  // (they are an app-internal mirror, not GnuCash KVP — a type-4 row with
  // no string_val would round-trip as a junk empty-string slot).
  const templateTreeGuidSet = new Set(templateTreeGuids);
  const appTemplateAccountMirror = new Map<string, string>();
  const slotIndex = indexDbSlotRows(
    loadedSlotRows.filter((row) => {
      const isAppMirror =
        templateTreeGuidSet.has(row.obj_guid) &&
        row.name === 'account' &&
        row.slot_type === 4 &&
        Boolean(row.guid_val);
      if (isAppMirror) {
        appTemplateAccountMirror.set(row.obj_guid, row.guid_val!);
      }
      return !isAppMirror;
    }),
  );
  const slotsFor = (objGuid: string): GnuCashSlot[] | undefined => {
    const tree = dbRowsToSlots(slotIndex, objGuid);
    return tree.length > 0 ? tree : undefined;
  };

  // Group lots by account for act:lots emission.
  const lotsByAccount = new Map<string, GnuCashLot[]>();
  for (const lot of lots) {
    if (!lot.account_guid) continue;
    const entry: GnuCashLot = { id: lot.guid };
    const lotSlots = slotsFor(lot.guid);
    if (lotSlots) entry.slots = lotSlots;
    const list = lotsByAccount.get(lot.account_guid);
    if (list) list.push(entry);
    else lotsByAccount.set(lot.account_guid, [entry]);
  }

  // Build the commodity namespace:mnemonic -> guid lookup
  const commodityLookup = new Map<string, { namespace: string; mnemonic: string }>();
  for (const c of commodities) {
    commodityLookup.set(c.guid, { namespace: c.namespace, mnemonic: c.mnemonic });
  }

  // Map commodities to export format
  const exportCommodities: GnuCashCommodity[] = commodities.map((c) => ({
    space: c.namespace,
    id: c.mnemonic,
    name: c.fullname || undefined,
    xcode: c.cusip || undefined,
    fraction: c.fraction,
    quoteFlag: c.quote_flag || undefined,
    quoteSource: c.quote_source || undefined,
    quoteTz: c.quote_tz || undefined,
    slots: slotsFor(c.guid),
  }));

  // Topologically sort accounts: ROOT first, then parents before children
  const sortedAccounts = topologicalSortAccounts(accounts, rootAccountGuid);

  // Map accounts to export format. hidden/placeholder come from their
  // columns (builder synthesizes the mirror slots only when the KVP
  // passthrough doesn't already carry them); notes travel inside slots.
  const exportAccounts: GnuCashAccount[] = sortedAccounts.map((acc) => {
    const commodity = acc.commodity_guid ? commodityLookup.get(acc.commodity_guid) : undefined;
    return {
      name: acc.name,
      id: acc.guid,
      type: acc.account_type,
      commodity: commodity
        ? { space: commodity.namespace, id: commodity.mnemonic }
        : undefined,
      commodityScu: acc.commodity_scu,
      description: acc.description || undefined,
      parentId: acc.parent_guid || undefined,
      hidden: acc.hidden === 1 ? true : undefined,
      placeholder: acc.placeholder === 1 ? true : undefined,
      nonStdScu: acc.non_std_scu === 1 ? true : undefined,
      slots: slotsFor(acc.guid),
      lots: lotsByAccount.get(acc.guid),
    };
  });

  // Map transactions to export format
  const exportTransactions: GnuCashTransaction[] = transactions.map((tx) => {
    const currency = commodityLookup.get(tx.currency_guid);
    return {
      id: tx.guid,
      currency: currency
        ? { space: currency.namespace, id: currency.mnemonic }
        : { space: 'CURRENCY', id: 'USD' },
      num: tx.num || undefined,
      datePosted: formatGnuCashDate(tx.post_date),
      dateEntered: formatGnuCashDate(tx.enter_date),
      description: tx.description || '',
      slots: slotsFor(tx.guid),
      splits: tx.splits.map((split) => ({
        id: split.guid,
        reconciledState: split.reconcile_state,
        reconcileDate: split.reconcile_date
          ? formatGnuCashDate(split.reconcile_date)
          : undefined,
        value: toFractionString(split.value_num, split.value_denom),
        quantity: toFractionString(split.quantity_num, split.quantity_denom),
        accountId: split.account_guid,
        memo: split.memo || undefined,
        action: split.action || undefined,
        lotId: split.lot_guid || undefined,
        slots: slotsFor(split.guid),
      })),
    };
  });

  // Map template accounts (template root first). Template accounts are
  // encoded with the `template` namespace commodity regardless of the
  // commodity_guid stored on their rows (inventory §3); the ROOT carries
  // no commodity, matching native GnuCash files.
  const sortedTemplateAccounts = templateRootGuid
    ? topologicalSortAccounts(templateAccountRows, templateRootGuid)
    : [];
  const exportTemplateAccounts: GnuCashAccount[] = sortedTemplateAccounts.map((acc) => ({
    name: acc.name,
    id: acc.guid,
    type: acc.account_type,
    commodity:
      acc.account_type === 'ROOT' ? undefined : { space: 'template', id: 'template' },
    commodityScu: acc.account_type === 'ROOT' ? undefined : acc.commodity_scu,
    description: acc.description || undefined,
    parentId: acc.parent_guid || undefined,
    hidden: acc.hidden === 1 ? true : undefined,
    placeholder: acc.placeholder === 1 ? true : undefined,
    nonStdScu: acc.non_std_scu === 1 ? true : undefined,
    slots: slotsFor(acc.guid),
  }));

  // Map template transactions. Splits imported from GnuCash XML carry their
  // sched-xaction frame in the slots passthrough already; splits created by
  // the app's own scheduled-tx-create (which stores the real-account mapping
  // on the template child account and the amount in the split value) get an
  // equivalent frame synthesized so GnuCash desktop can resolve them.
  const exportTemplateTransactions: GnuCashTransaction[] = templateTransactionRows.map(
    (tx) => {
      const currency = commodityLookup.get(tx.currency_guid);
      return {
        id: tx.guid,
        currency: currency
          ? { space: currency.namespace, id: currency.mnemonic }
          : { space: 'CURRENCY', id: 'USD' },
        num: tx.num || undefined,
        datePosted: formatGnuCashDate(tx.post_date),
        dateEntered: formatGnuCashDate(tx.enter_date),
        description: tx.description || '',
        slots: slotsFor(tx.guid),
        splits: tx.splits.map((split) => {
          let slots = slotsFor(split.guid);
          const mirrorAccountGuid = appTemplateAccountMirror.get(split.account_guid);
          const hasFrame = slots?.some((slot) => slot.key === 'sched-xaction') ?? false;
          if (!hasFrame && mirrorAccountGuid) {
            slots = [
              ...(slots ?? []),
              buildSchedXactionFrame(mirrorAccountGuid, split.value_num, split.value_denom),
            ];
          }
          return {
            id: split.guid,
            reconciledState: split.reconcile_state,
            reconcileDate: split.reconcile_date
              ? formatGnuCashDate(split.reconcile_date)
              : undefined,
            value: toFractionString(split.value_num, split.value_denom),
            quantity: toFractionString(split.quantity_num, split.quantity_denom),
            accountId: split.account_guid,
            memo: split.memo || undefined,
            action: split.action || undefined,
            lotId: split.lot_guid || undefined,
            slots,
          };
        }),
      };
    },
  );
  const hasTemplateDescendants = exportTemplateAccounts.some((a) => a.type !== 'ROOT');

  // Map scheduled transactions. num_occur > 0 means the SX has an
  // occurrence-count definition (num-occur/rem-occur are emitted and the
  // end date is not — the trio is mutually exclusive); the app itself
  // writes num_occur -1 for "no limit", which correctly falls through.
  const gdateOf = (date: Date | null): string | undefined =>
    date ? date.toISOString().slice(0, 10) : undefined;
  const exportSchedxactions: GnuCashSchedXAction[] = sxRows.map((sx) => {
    const schedule: GnuCashRecurrence[] = (recurrencesBySx.get(sx.guid) ?? []).map(
      (recurrence) => ({
        mult: recurrence.recurrence_mult,
        periodType: recurrence.recurrence_period_type,
        periodStart: recurrence.recurrence_period_start.toISOString().slice(0, 10),
        ...(recurrence.recurrence_weekend_adjust &&
        recurrence.recurrence_weekend_adjust !== 'none'
          ? { weekendAdjust: recurrence.recurrence_weekend_adjust }
          : {}),
      }),
    );
    const hasOccurDef = sx.num_occur > 0;
    const end = gdateOf(sx.end_date);
    return {
      id: sx.guid,
      name: sx.name ?? '',
      enabled: sx.enabled === 1,
      autoCreate: sx.auto_create === 1,
      autoCreateNotify: sx.auto_notify === 1,
      advanceCreateDays: sx.adv_creation,
      advanceRemindDays: sx.adv_notify,
      instanceCount: sx.instance_count,
      start: gdateOf(sx.start_date) ?? schedule[0]?.periodStart ?? '1970-01-01',
      last: gdateOf(sx.last_occur),
      ...(hasOccurDef
        ? { numOccur: sx.num_occur, remOccur: sx.rem_occur }
        : end
          ? { end }
          : {}),
      templateAccountId: sx.template_act_guid,
      schedule,
      slots: slotsFor(sx.guid),
    };
  });

  // The template namespace commodity is declared alongside the real ones
  // whenever template accounts are emitted, matching the native writer
  // (the commodity table always contains it once SX templates exist).
  if (hasTemplateDescendants) {
    exportCommodities.push({
      space: 'template',
      id: 'template',
      name: 'template',
      xcode: 'template',
      fraction: 1,
    });
  }

  // Map prices to export format, skipping any with unresolvable commodities
  const exportPrices: GnuCashPrice[] = [];
  for (const p of prices) {
    const commodity = commodityLookup.get(p.commodity_guid);
    const currency = commodityLookup.get(p.currency_guid);
    if (!commodity || !currency) continue;
    exportPrices.push({
      id: p.guid,
      commodity: { space: commodity.namespace, id: commodity.mnemonic },
      currency: { space: currency.namespace, id: currency.mnemonic },
      date: formatGnuCashDate(p.date),
      source: p.source || '',
      type: p.type || undefined,
      value: toFractionString(p.value_num, p.value_denom),
    });
  }

  // Map budgets to export format
  const exportBudgets: GnuCashBudget[] = budgets.map((b) => {
    const amounts: GnuCashBudgetAmount[] = b.amounts.map((a) => ({
      accountId: a.account_guid,
      periodNum: a.period_num,
      amount: toFractionString(a.amount_num, a.amount_denom),
    }));

    const recurrence = b.recurrences[0];
    return {
      id: b.guid,
      name: b.name,
      description: b.description || undefined,
      numPeriods: b.num_periods,
      recurrence: recurrence ? {
        mult: recurrence.recurrence_mult,
        periodType: recurrence.recurrence_period_type,
        periodStart: recurrence.recurrence_period_start.toISOString().slice(0, 10),
        ...(recurrence.recurrence_weekend_adjust && recurrence.recurrence_weekend_adjust !== 'none'
          ? { weekendAdjust: recurrence.recurrence_weekend_adjust }
          : {}),
      } : undefined,
      amounts,
      // Native budget amounts live in budget_amounts, so every slots-table
      // row on a budget guid is non-amount passthrough KVP.
      slots: slotsFor(b.guid),
    };
  });

  return {
    book: {
      id: book.guid,
      idType: 'guid',
      slots: slotsFor(book.guid),
    },
    commodities: exportCommodities,
    pricedb: exportPrices,
    accounts: exportAccounts,
    transactions: exportTransactions,
    budgets: exportBudgets,
    schedxactions: exportSchedxactions,
    templateAccounts: hasTemplateDescendants ? exportTemplateAccounts : [],
    templateTransactions: hasTemplateDescendants ? exportTemplateTransactions : [],
    countData: {
      account: exportAccounts.length,
      transaction: exportTransactions.length,
      commodity: exportCommodities.length,
      schedxaction: exportSchedxactions.length,
      budget: exportBudgets.length,
      price: exportPrices.length,
    },
  };
}

/**
 * Synthesize the sched-xaction split frame for a template split created by
 * the app's own scheduled-tx-create service (which stores the real-account
 * mapping on the template child account and the signed amount in the split
 * value, instead of the native KVP frame). Positive values are the debit
 * side, negative the credit side; the counterpart formula stays empty and
 * its numeric zero, matching the native writer.
 */
function buildSchedXactionFrame(
  realAccountGuid: string,
  valueNum: bigint,
  valueDenom: bigint,
): GnuCashSlot {
  const isCredit = valueNum < 0n;
  const abs = isCredit ? -valueNum : valueNum;
  const formula = toDecimal(abs, valueDenom);
  const absFraction = `${abs}/${valueDenom}`;
  return {
    key: 'sched-xaction',
    value: {
      type: 'frame',
      slots: [
        { key: 'account', value: { type: 'guid', value: realAccountGuid } },
        { key: 'credit-formula', value: { type: 'string', value: isCredit ? formula : '' } },
        {
          key: 'credit-numeric',
          value: { type: 'numeric', value: isCredit ? absFraction : '0/1' },
        },
        { key: 'debit-formula', value: { type: 'string', value: isCredit ? '' : formula } },
        {
          key: 'debit-numeric',
          value: { type: 'numeric', value: isCredit ? '0/1' : absFraction },
        },
      ],
    },
  };
}

/**
 * Topologically sort accounts so ROOT comes first, then parents before children.
 * GnuCash desktop requires parent accounts to appear before their children.
 */
function topologicalSortAccounts<T extends { guid: string; parent_guid: string | null }>(
  accounts: T[],
  rootAccountGuid: string,
): T[] {
  const byGuid = new Map<string, T>();
  const childrenOf = new Map<string, T[]>();

  for (const acc of accounts) {
    byGuid.set(acc.guid, acc);
    const parentKey = acc.parent_guid || '';
    const siblings = childrenOf.get(parentKey) || [];
    siblings.push(acc);
    childrenOf.set(parentKey, siblings);
  }

  const sorted: T[] = [];
  const visited = new Set<string>();

  function visit(guid: string) {
    if (visited.has(guid)) return;
    visited.add(guid);
    const acc = byGuid.get(guid);
    if (acc) sorted.push(acc);
    const children = childrenOf.get(guid) || [];
    for (const child of children) {
      visit(child.guid);
    }
  }

  // Start from root
  visit(rootAccountGuid);

  // Pick up any orphans (shouldn't happen, but safety)
  for (const acc of accounts) {
    if (!visited.has(acc.guid)) {
      sorted.push(acc);
    }
  }

  return sorted;
}
