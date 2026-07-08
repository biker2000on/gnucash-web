import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { computeNextOccurrences, RecurrencePattern } from '@/lib/recurrence';

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
 */
export async function resolveTemplateSplits(templateActGuid: string): Promise<ResolvedSplit[]> {
  // Step 1: Find child accounts of the template root
  const templateAccounts = await prisma.accounts.findMany({
    where: { parent_guid: templateActGuid },
    select: { guid: true, name: true },
  });

  if (templateAccounts.length === 0) return [];

  const templateGuids = templateAccounts.map(a => a.guid);

  // Step 2: Find splits for transactions referencing template accounts
  const splits = await prisma.splits.findMany({
    where: { account_guid: { in: templateGuids } },
    select: { account_guid: true, value_num: true, value_denom: true },
  });

  // Step 3: Resolve real account GUIDs from slots
  const slots = await prisma.slots.findMany({
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
    const accounts = await prisma.accounts.findMany({
      where: { guid: { in: realGuids } },
      select: { guid: true, name: true },
    });
    for (const acc of accounts) {
      accountNames.set(acc.guid, acc.name);
    }
  }

  // Step 5: Combine results
  const result: ResolvedSplit[] = [];

  for (const split of splits) {
    const realGuid = templateToReal.get(split.account_guid);
    if (!realGuid) continue;

    const amount = parseFloat(toDecimal(split.value_num, split.value_denom));
    result.push({
      accountGuid: realGuid,
      accountName: accountNames.get(realGuid) || 'Unknown',
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
  recurrence: {
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  } | null;
  nextOccurrence: string | null;
  splits: Array<{
    accountGuid: string;
    accountName: string;
    amount: number;
  }>;
}

/**
 * Fetch all scheduled transactions with resolved template data.
 */
export async function fetchScheduledTransactions(enabledOnly?: boolean): Promise<ScheduledTransaction[]> {
  // Step 1: Fetch scheduled transactions with recurrence patterns
  const sxList = await prisma.schedxactions.findMany({
    where: enabledOnly ? { enabled: 1 } : undefined,
  });

  const sxGuids = sxList.map(s => s.guid);
  const recurrenceList = sxGuids.length > 0
    ? await prisma.recurrences.findMany({ where: { obj_guid: { in: sxGuids } } })
    : [];
  const recurrenceByGuid = new Map(recurrenceList.map(r => [r.obj_guid, r]));

  const rows: ScheduledTransactionRow[] = sxList.map(s => {
    const r = recurrenceByGuid.get(s.guid);
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

  for (const row of rows) {
    // Resolve template splits
    const splits = await resolveTemplateSplits(row.template_act_guid);

    // Build recurrence info
    let recurrence: ScheduledTransaction['recurrence'] = null;
    let nextOccurrence: string | null = null;

    if (row.recurrence_period_type && row.recurrence_period_start) {
      const periodStart = parseGnuCashDate(row.recurrence_period_start);
      if (periodStart) {
        recurrence = {
          periodType: row.recurrence_period_type,
          mult: row.recurrence_mult || 1,
          periodStart: formatDate(periodStart)!,
          weekendAdjust: row.recurrence_weekend_adjust || 'none',
        };

        // Compute next occurrence
        if (row.enabled) {
          const pattern: RecurrencePattern = {
            periodType: row.recurrence_period_type,
            mult: row.recurrence_mult || 1,
            periodStart,
            weekendAdjust: row.recurrence_weekend_adjust || 'none',
          };

          const lastOccur = parseGnuCashDate(row.last_occur);
          const endDate = parseGnuCashDate(row.end_date);
          const remOccur = row.rem_occur > 0 ? row.rem_occur : null;

          const nextDates = computeNextOccurrences(
            pattern,
            lastOccur,
            endDate,
            remOccur,
            1,
            today
          );

          if (nextDates.length > 0) {
            nextOccurrence = formatDate(nextDates[0]);
          }
        }
      }
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
      recurrence,
      nextOccurrence,
      splits,
    });
  }

  return results;
}
