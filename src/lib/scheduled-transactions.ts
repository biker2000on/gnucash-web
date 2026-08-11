import prisma from '@/lib/prisma';
import type { ExtendedPrismaClient } from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { computeNextOccurrencesForPatterns, RecurrencePattern } from '@/lib/recurrence';

/**
 * Either the global Prisma client or an interactive-transaction client
 * (the callback argument of `prisma.$transaction`). Lets query helpers run
 * INSIDE a caller's transaction instead of escaping it via the global client.
 */
export type DbClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface TemplateAccount {
  guid: string;
  name: string;
}

export interface ResolvedSplit {
  accountGuid: string;
  accountName: string;
  amount: number;
  templateAccountGuid: string;
}

/**
 * Parse a GnuCash date string (YYYYMMDD or YYYY-MM-DD or Date object) into a Date.
 */
export function parseGnuCashDate(value: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).replace(/-/g, '');
  if (s.length >= 8) {
    const y = parseInt(s.substring(0, 4));
    const m = parseInt(s.substring(4, 6)) - 1;
    const d = parseInt(s.substring(6, 8));
    return new Date(y, m, d);
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().split('T')[0];
}

/**
 * Resolve template splits for a scheduled transaction.
 * GnuCash stores scheduled transaction templates as account hierarchies under a template root.
 *
 * Pass `client` to run inside a caller's `$transaction` (e.g. the FOR UPDATE
 * block in scheduled-tx-execute); defaults to the global client for callers
 * that don't need transactional consistency.
 */
export async function resolveTemplateSplits(
  templateActGuid: string,
  client: DbClient = prisma,
): Promise<ResolvedSplit[]> {
  const byTemplate = await resolveTemplateSplitsBatch([templateActGuid], client);
  return byTemplate.get(templateActGuid) ?? [];
}

/**
 * Batched variant of resolveTemplateSplits: resolves the template splits for
 * MANY scheduled transactions in 4 total queries (child template accounts,
 * their splits, their 'account' slots, the referenced real accounts) instead
 * of 4 queries PER scheduled transaction. Returns a map keyed by the input
 * template root guid; every requested guid is present (empty array when the
 * template has no resolvable splits).
 *
 * Two storage layouts are supported:
 * - App layout (scheduled-tx-create): one child account per split under the
 *   SX's template account, each carrying an account-owned `account` slot
 *   (slot_type 4, guid_val = real account) with the signed amount in the
 *   split value. Tried first; unchanged behavior.
 * - Native GnuCash layout (SQL backend / XML importer): the SX's template
 *   account holds the splits DIRECTLY (no children), and each split carries
 *   a split-owned `sched-xaction` KVP frame — `sched-xaction/account`
 *   (guid), `credit-numeric`/`debit-numeric` (numeric), and the formula
 *   strings. Used as a fallback for any template account the app layout
 *   resolved nothing for.
 */
export async function resolveTemplateSplitsBatch(
  templateActGuids: string[],
  client: DbClient = prisma,
): Promise<Map<string, ResolvedSplit[]>> {
  const result = new Map<string, ResolvedSplit[]>();
  const uniqueRoots = [...new Set(templateActGuids)];
  for (const g of uniqueRoots) result.set(g, []);
  if (uniqueRoots.length === 0) return result;

  // Step 1: Find child accounts of every template root
  const templateAccounts = await client.accounts.findMany({
    where: { parent_guid: { in: uniqueRoots } },
    select: { guid: true, name: true, parent_guid: true },
  });

  if (templateAccounts.length > 0) {
    const templateGuids = templateAccounts.map(a => a.guid);
    const rootByTemplate = new Map<string, string>();
    for (const a of templateAccounts) {
      if (a.parent_guid) rootByTemplate.set(a.guid, a.parent_guid);
    }

    // Step 2: Find splits for transactions referencing template accounts
    const splits = await client.splits.findMany({
      where: { account_guid: { in: templateGuids } },
      select: { account_guid: true, value_num: true, value_denom: true },
    });

    // Step 3: Resolve real account GUIDs from slots
    const slots = await client.slots.findMany({
      where: {
        obj_guid: { in: templateGuids },
        slot_type: 4,
        name: 'account',
      },
      select: { obj_guid: true, guid_val: true },
    });

    const templateToReal = new Map<string, string>();
    for (const slot of slots) {
      if (slot.guid_val) templateToReal.set(slot.obj_guid, slot.guid_val);
    }

    // Step 4: Look up real account names
    const realGuids = [...new Set(
      slots.map(s => s.guid_val).filter((g): g is string => g !== null),
    )];
    const accountNames = new Map<string, string>();

    if (realGuids.length > 0) {
      const accounts = await client.accounts.findMany({
        where: { guid: { in: realGuids } },
        select: { guid: true, name: true },
      });
      for (const acc of accounts) {
        accountNames.set(acc.guid, acc.name);
      }
    }

    // Step 5: Combine results, grouped by template root
    for (const split of splits) {
      const realGuid = templateToReal.get(split.account_guid);
      if (!realGuid) continue;
      const rootGuid = rootByTemplate.get(split.account_guid);
      if (!rootGuid) continue;

      const amount = parseFloat(toDecimal(split.value_num, split.value_denom));
      result.get(rootGuid)!.push({
        accountGuid: realGuid,
        accountName: accountNames.get(realGuid) || 'Unknown',
        amount,
        templateAccountGuid: split.account_guid,
      });
    }
  }

  // Native-layout fallback for template accounts the app layout resolved
  // nothing for (GnuCash desktop/SQL books and XML-imported books store the
  // splits directly on the template account with split-owned KVP frames).
  const flatRoots = uniqueRoots.filter(g => result.get(g)!.length === 0);
  if (flatRoots.length === 0) return result;

  const directSplits = await client.splits.findMany({
    where: { account_guid: { in: flatRoots } },
    select: { guid: true, account_guid: true, value_num: true, value_denom: true },
  });
  if (directSplits.length === 0) return result;

  // The frame row on each split carries the KVP instance guid in guid_val;
  // the frame's children live under that guid with path-prefixed names.
  const frameRows = await client.slots.findMany({
    where: {
      obj_guid: { in: directSplits.map(s => s.guid) },
      name: 'sched-xaction',
      slot_type: 9,
    },
    select: { obj_guid: true, guid_val: true },
  });
  const frameGuidBySplit = new Map<string, string>();
  for (const row of frameRows) {
    if (row.guid_val) frameGuidBySplit.set(row.obj_guid, row.guid_val);
  }

  const frameChildren = frameGuidBySplit.size > 0
    ? await client.slots.findMany({
        where: { obj_guid: { in: [...frameGuidBySplit.values()] } },
        select: {
          obj_guid: true,
          name: true,
          slot_type: true,
          guid_val: true,
          string_val: true,
          numeric_val_num: true,
          numeric_val_denom: true,
        },
      })
    : [];
  type FrameChild = (typeof frameChildren)[number];
  const childrenByFrame = new Map<string, FrameChild[]>();
  for (const row of frameChildren) {
    const rows = childrenByFrame.get(row.obj_guid) ?? [];
    rows.push(row);
    childrenByFrame.set(row.obj_guid, rows);
  }

  const nativeRealGuids = [...new Set(
    frameChildren
      .filter(row => row.name === 'sched-xaction/account')
      .map(row => row.guid_val)
      .filter((g): g is string => g !== null),
  )];
  const nativeAccountNames = new Map<string, string>();
  if (nativeRealGuids.length > 0) {
    const accounts = await client.accounts.findMany({
      where: { guid: { in: nativeRealGuids } },
      select: { guid: true, name: true },
    });
    for (const acc of accounts) {
      nativeAccountNames.set(acc.guid, acc.name);
    }
  }

  const numericOf = (row: FrameChild | undefined): number =>
    row ? parseFloat(toDecimal(row.numeric_val_num ?? 0n, row.numeric_val_denom ?? 1n)) : 0;
  // Formulas are only consulted when the numerics are absent (pre-2.6
  // files), and only when they are plain numbers — formulas with variables
  // are legitimately unresolvable to a fixed amount and yield 0.
  const plainFormulaOf = (row: FrameChild | undefined): number => {
    const formula = row?.string_val?.trim();
    if (!formula || !/^-?\d+([.,]\d+)?$/.test(formula)) return 0;
    return parseFloat(formula.replace(',', '.'));
  };

  for (const split of directSplits) {
    const frameGuid = frameGuidBySplit.get(split.guid);
    if (!frameGuid) continue;
    const children = childrenByFrame.get(frameGuid) ?? [];
    const child = (suffix: string) =>
      children.find(row => row.name === `sched-xaction/${suffix}`);
    const realGuid = child('account')?.guid_val;
    if (!realGuid) continue;

    // Native template splits carry zero value; the amount lives in the
    // numerics (debit positive, credit negative — verified against
    // GnuCash-created schedules).
    let amount = parseFloat(toDecimal(split.value_num, split.value_denom));
    if (amount === 0) {
      const debitNumeric = child('debit-numeric');
      const creditNumeric = child('credit-numeric');
      if (debitNumeric || creditNumeric) {
        amount = numericOf(debitNumeric) - numericOf(creditNumeric);
      } else {
        amount = plainFormulaOf(child('debit-formula')) - plainFormulaOf(child('credit-formula'));
      }
    }

    result.get(split.account_guid)!.push({
      accountGuid: realGuid,
      accountName: nativeAccountNames.get(realGuid) || 'Unknown',
      amount,
      templateAccountGuid: split.account_guid,
    });
  }

  return result;
}
interface ScheduledTransactionRow {
  guid: string;
  name: string;
  enabled: number;
  start_date: Date | string | null;
  end_date: Date | string | null;
  last_occur: Date | string | null;
  num_occur: number;
  rem_occur: number;
  auto_create: number;
  auto_notify: number;
  template_act_guid: string;
  recurrence_mult: number | null;
  recurrence_period_type: string | null;
  recurrence_period_start: Date | string | null;
  recurrence_weekend_adjust: string | null;
}

export interface ScheduledTransaction {
  guid: string;
  name: string;
  enabled: boolean;
  startDate: string | null;
  endDate: string | null;
  lastOccur: string | null;
  remainingOccurrences: number;
  autoCreate: boolean;
  autoNotify: boolean;
  recurrence: {
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  } | null;
  /** All native recurrence rows. Composite desktop schedules have 2+. */
  recurrences?: Array<{
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  }>;
  nextOccurrence: string | null;
  splits: Array<{
    accountGuid: string;
    accountName: string;
    amount: number;
  }>;
}

/**
 * Fetch all scheduled transactions with resolved template data.
 *
 * When `bookGuid` is given, the schedxactions query itself is scoped to that
 * book: GnuCash keeps each book's SX templates under the book's
 * `root_template_guid`, so only schedules whose template account descends
 * from that root are fetched (instead of reading every book's schedules and
 * filtering later in JS).
 */
export async function fetchScheduledTransactions(
  enabledOnly?: boolean,
  bookGuid?: string,
): Promise<ScheduledTransaction[]> {
  // Optional book scoping via the book's template account tree
  let templateScopeGuids: string[] | null = null;
  if (bookGuid) {
    const book = await prisma.books.findUnique({
      where: { guid: bookGuid },
      select: { root_template_guid: true },
    });
    if (!book) return [];
    const templateAccounts = await prisma.$queryRaw<{ guid: string }[]>`
      WITH RECURSIVE template_tree AS (
        SELECT guid FROM accounts WHERE guid = ${book.root_template_guid}
        UNION ALL
        SELECT a.guid FROM accounts a
        JOIN template_tree t ON a.parent_guid = t.guid
      )
      SELECT guid FROM template_tree
    `;
    templateScopeGuids = templateAccounts.map(a => a.guid);
    if (templateScopeGuids.length === 0) return [];
  }

  // Step 1: Fetch scheduled transactions with recurrence patterns
  const sxList = await prisma.schedxactions.findMany({
    where: {
      ...(enabledOnly ? { enabled: 1 } : {}),
      ...(templateScopeGuids ? { template_act_guid: { in: templateScopeGuids } } : {}),
    },
  });

  const sxGuids = sxList.map(s => s.guid);
  const recurrenceList = sxGuids.length > 0
    ? await prisma.recurrences.findMany({ where: { obj_guid: { in: sxGuids } } })
    : [];
  const recurrenceByGuid = new Map<string, typeof recurrenceList>();
  for (const recurrence of recurrenceList) {
    const rows = recurrenceByGuid.get(recurrence.obj_guid) ?? [];
    rows.push(recurrence);
    recurrenceByGuid.set(recurrence.obj_guid, rows);
  }

  const rows: ScheduledTransactionRow[] = sxList.map(s => {
    const r = recurrenceByGuid.get(s.guid)?.[0];
    return {
      guid: s.guid,
      name: s.name ?? '',
      enabled: s.enabled,
      start_date: s.start_date,
      end_date: s.end_date,
      last_occur: s.last_occur,
      num_occur: s.num_occur,
      rem_occur: s.rem_occur,
      auto_create: s.auto_create,
      auto_notify: s.auto_notify,
      template_act_guid: s.template_act_guid,
      recurrence_mult: r?.recurrence_mult ?? null,
      recurrence_period_type: r?.recurrence_period_type ?? null,
      recurrence_period_start: r?.recurrence_period_start ?? null,
      recurrence_weekend_adjust: r?.recurrence_weekend_adjust ?? null,
    };
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const results: ScheduledTransaction[] = [];

  // Resolve every row's template splits in one batched pass (4 queries total
  // instead of 4 per scheduled transaction)
  const splitsByTemplate = await resolveTemplateSplitsBatch(rows.map(r => r.template_act_guid));

  for (const row of rows) {
    const splits = splitsByTemplate.get(row.template_act_guid) ?? [];

    // Build recurrence info. Keep the first row for backward-compatible UI
    // display while exposing and evaluating the complete native row set.
    let recurrence: ScheduledTransaction['recurrence'] = null;
    const recurrences: NonNullable<ScheduledTransaction['recurrences']> = [];
    let nextOccurrence: string | null = null;

    const nativeRecurrences = recurrenceByGuid.get(row.guid) ?? [];
    const patterns: RecurrencePattern[] = [];
    for (const native of nativeRecurrences) {
      const periodStart = parseGnuCashDate(native.recurrence_period_start);
      if (periodStart) {
        const item = {
          periodType: native.recurrence_period_type,
          mult: native.recurrence_mult || 1,
          periodStart: formatDate(periodStart)!,
          weekendAdjust: native.recurrence_weekend_adjust || 'none',
        };
        recurrences.push(item);
        patterns.push({ ...item, periodStart });
      }
    }
    recurrence = recurrences[0] ?? null;

    if (row.enabled && patterns.length > 0) {
      const nextDates = computeNextOccurrencesForPatterns(
        patterns,
        parseGnuCashDate(row.last_occur),
        parseGnuCashDate(row.end_date),
        row.rem_occur > 0 ? row.rem_occur : null,
        1,
        today,
      );
      if (nextDates.length > 0) nextOccurrence = formatDate(nextDates[0]);
    }

    results.push({
      guid: row.guid,
      name: row.name,
      enabled: row.enabled === 1,
      startDate: row.start_date ? formatDate(parseGnuCashDate(row.start_date)) : null,
      endDate: row.end_date ? formatDate(parseGnuCashDate(row.end_date)) : null,
      lastOccur: row.last_occur ? formatDate(parseGnuCashDate(row.last_occur)) : null,
      remainingOccurrences: row.rem_occur,
      autoCreate: row.auto_create === 1,
      autoNotify: row.auto_notify === 1,
      recurrence,
      recurrences,
      nextOccurrence,
      splits,
    });
  }

  return results;
}
