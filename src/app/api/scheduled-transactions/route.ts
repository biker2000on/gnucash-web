import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { computeNextOccurrences, RecurrencePattern } from '@/lib/recurrence';
import { parseGnuCashDate, formatDate, resolveTemplateSplits } from '@/lib/scheduled-transactions';
import { createScheduledTransaction, CreateScheduledTxInput } from '@/lib/services/scheduled-tx-create';

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

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body: CreateScheduledTxInput = await request.json();
    const result = await createScheduledTransaction(body);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Error creating scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 });
  }
}
