import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';

export interface TemplateAccount {
  guid: string;
  name: string;
}

export interface SplitRow {
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
}

export interface SlotRow {
  obj_guid: string;
  guid_val: string;
}

export interface AccountNameRow {
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
  const templateAccounts = await prisma.$queryRaw<TemplateAccount[]>`
    SELECT guid, name FROM accounts WHERE parent_guid = ${templateActGuid}
  `;

  if (templateAccounts.length === 0) return [];

  const templateGuids = templateAccounts.map(a => a.guid);

  // Step 2: Find splits for transactions referencing template accounts
  const splitsResult = await prisma.$queryRawUnsafe<SplitRow[]>(
    `SELECT s.account_guid, s.value_num, s.value_denom
     FROM splits s
     WHERE s.account_guid IN (${templateGuids.map((_, i) => `$${i + 1}`).join(', ')})`,
    ...templateGuids
  );

  // Step 3: Resolve real account GUIDs from slots
  const slotsResult = await prisma.$queryRawUnsafe<SlotRow[]>(
    `SELECT obj_guid, guid_val FROM slots
     WHERE obj_guid IN (${templateGuids.map((_, i) => `$${i + 1}`).join(', ')})
     AND slot_type = 4 AND name = 'account'`,
    ...templateGuids
  );

  // Build mapping: template account guid -> real account guid
  const templateToReal = new Map<string, string>();
  for (const slot of slotsResult) {
    templateToReal.set(slot.obj_guid, slot.guid_val);
  }

  // Step 4: Look up real account names
  const realGuids = [...new Set(slotsResult.map(s => s.guid_val))];
  const accountNames = new Map<string, string>();

  if (realGuids.length > 0) {
    const accountsResult = await prisma.$queryRawUnsafe<AccountNameRow[]>(
      `SELECT guid, name FROM accounts
       WHERE guid IN (${realGuids.map((_, i) => `$${i + 1}`).join(', ')})`,
      ...realGuids
    );
    for (const acc of accountsResult) {
      accountNames.set(acc.guid, acc.name);
    }
  }

  // Step 5: Combine results
  const result: ResolvedSplit[] = [];

  for (const split of splitsResult) {
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
