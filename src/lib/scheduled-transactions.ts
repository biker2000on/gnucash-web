import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';

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
