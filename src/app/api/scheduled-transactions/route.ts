import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { requireRole } from '@/lib/auth';
import { computeNextOccurrences, RecurrencePattern } from '@/lib/recurrence';

interface ScheduledTransactionRow {
  guid: string;
  name: string;
  enabled: number;
  start_date: string | null;
  end_date: string | null;
  last_occur: string | null;
  num_occur: number;
  rem_occur: number;
  auto_create: number;
  template_act_guid: string;
  recurrence_mult: number | null;
  recurrence_period_type: string | null;
  recurrence_period_start: string | null;
  recurrence_weekend_adjust: string | null;
}

interface TemplateAccount {
  guid: string;
  name: string;
}

interface SplitRow {
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
}

interface SlotRow {
  obj_guid: string;
  guid_val: string;
}

interface AccountNameRow {
  guid: string;
  name: string;
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
 * Parse a GnuCash date string (YYYYMMDD or YYYY-MM-DD or Date object) into a Date.
 */
function parseGnuCashDate(value: string | Date | null): Date | null {
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

function formatDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().split('T')[0];
}

/**
 * Resolve template splits for a scheduled transaction.
 * GnuCash stores scheduled transaction templates as account hierarchies under a template root.
 */
async function resolveTemplateSplits(templateActGuid: string): Promise<Array<{
  accountGuid: string;
  accountName: string;
  amount: number;
}>> {
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
  const result: Array<{ accountGuid: string; accountName: string; amount: number }> = [];

  for (const split of splitsResult) {
    const realGuid = templateToReal.get(split.account_guid);
    if (!realGuid) continue;

    const amount = parseFloat(toDecimal(split.value_num, split.value_denom));
    result.push({
      accountGuid: realGuid,
      accountName: accountNames.get(realGuid) || 'Unknown',
      amount,
    });
  }

  return result;
}

/**
 * Fetch all scheduled transactions with resolved template data.
 */
export async function fetchScheduledTransactions(enabledOnly?: boolean): Promise<ScheduledTransaction[]> {
  // Step 1: Fetch scheduled transactions with recurrence patterns
  let query = `
    SELECT s.guid, s.name, s.enabled, s.start_date, s.end_date, s.last_occur,
           s.num_occur, s.rem_occur, s.auto_create, s.template_act_guid,
           r.recurrence_mult, r.recurrence_period_type, r.recurrence_period_start,
           r.recurrence_weekend_adjust
    FROM schedxactions s
    LEFT JOIN recurrences r ON r.obj_guid = s.guid
  `;

  if (enabledOnly) {
    query += ' WHERE s.enabled = 1';
  }

  const rows = await prisma.$queryRawUnsafe<ScheduledTransactionRow[]>(query);

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

/**
 * @openapi
 * /api/scheduled-transactions:
 *   get:
 *     description: Returns all scheduled transactions with resolved template amounts and account mappings.
 *     parameters:
 *       - name: enabled
 *         in: query
 *         description: Filter to only enabled scheduled transactions
 *         schema:
 *           type: string
 *           enum: ['true']
 *     responses:
 *       200:
 *         description: A list of scheduled transactions.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const enabledOnly = request.nextUrl.searchParams.get('enabled') === 'true';
    const scheduledTransactions = await fetchScheduledTransactions(enabledOnly);

    return NextResponse.json(scheduledTransactions);
  } catch (error) {
    console.error('Error fetching scheduled transactions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch scheduled transactions' },
      { status: 500 }
    );
  }
}
