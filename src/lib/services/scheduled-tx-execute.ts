/**
 * Scheduled Transaction Execute/Skip/Batch Service
 *
 * Handles executing and skipping scheduled transaction occurrences:
 * - Execute: creates a real transaction from the template, updates metadata
 * - Skip: advances metadata without creating a transaction
 * - Batch: processes multiple execute/skip items independently
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { resolveTemplateSplits } from '@/lib/scheduled-transactions';

export interface ExecuteResult {
  success: true;
  transactionGuid: string;
}

export interface SkipResult {
  success: true;
}

export interface ErrorResult {
  success: false;
  error: string;
}

export interface BatchItem {
  guid: string;
  occurrenceDate: string;
  action: 'execute' | 'skip';
}

export interface BatchResultItem {
  guid: string;
  occurrenceDate: string;
  action: 'execute' | 'skip';
  success: boolean;
  transactionGuid?: string;
  error?: string;
}

export interface BatchResult {
  results: BatchResultItem[];
}

interface SchedXAction {
  guid: string;
  name: string;
  template_act_guid: string;
  last_occur: Date | null;
  rem_occur: number;
  instance_count: number;
}

/**
 * Execute a scheduled transaction occurrence, creating a real transaction.
 */
export async function executeOccurrence(
  sxGuid: string,
  occurrenceDate: string,
  overrideAmounts?: Map<string, number>
): Promise<ExecuteResult | ErrorResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the schedxaction row
      const rows = await tx.$queryRaw<SchedXAction[]>`
        SELECT guid, name, template_act_guid, last_occur, rem_occur, instance_count
        FROM schedxactions
        WHERE guid = ${sxGuid}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        return { success: false as const, error: `Scheduled transaction ${sxGuid} not found` };
      }

      const sx = rows[0];

      // Check rem_occur
      if (sx.rem_occur === 0) {
        return { success: false as const, error: 'Scheduled transaction has no remaining occurrences' };
      }

      // Resolve template splits
      const templateSplits = await resolveTemplateSplits(sx.template_act_guid);
      if (templateSplits.length === 0) {
        return { success: false as const, error: 'No template splits found for scheduled transaction' };
      }

      // Apply override amounts if provided
      const splits = templateSplits.map((split) => {
        const amount = overrideAmounts?.get(split.accountGuid) ?? split.amount;
        return { ...split, amount };
      });

      // Get book currency
      const currencyRows = await tx.$queryRaw<{ commodity_guid: string }[]>`
        SELECT commodity_guid FROM books LIMIT 1
      `;
      const currencyGuid = currencyRows[0]?.commodity_guid;
      if (!currencyGuid) {
        return { success: false as const, error: 'Could not determine book currency' };
      }

      // Create transaction
      const transactionGuid = generateGuid();
      const postDate = new Date(occurrenceDate + 'T12:00:00Z');
      const enterDate = new Date();

      await tx.$executeRaw`
        INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
        VALUES (${transactionGuid}, ${currencyGuid}, '', ${postDate}, ${enterDate}, ${sx.name})
      `;

      // Create splits
      for (const split of splits) {
        const splitGuid = generateGuid();
        const { num, denom } = fromDecimal(split.amount);

        await tx.$executeRaw`
          INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
          VALUES (${splitGuid}, ${transactionGuid}, ${split.accountGuid}, '', '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
        `;
      }

      // Update schedxaction metadata
      const newRemOccur = sx.rem_occur === -1 ? -1 : sx.rem_occur - 1;
      const newInstanceCount = sx.instance_count + 1;

      await tx.$executeRaw`
        UPDATE schedxactions
        SET last_occur = ${postDate}, rem_occur = ${newRemOccur}, instance_count = ${newInstanceCount}
        WHERE guid = ${sxGuid}
      `;

      return { success: true as const, transactionGuid };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Skip a scheduled transaction occurrence without creating a transaction.
 */
export async function skipOccurrence(
  sxGuid: string,
  occurrenceDate: string
): Promise<SkipResult | ErrorResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the schedxaction row
      const rows = await tx.$queryRaw<SchedXAction[]>`
        SELECT guid, name, template_act_guid, last_occur, rem_occur, instance_count
        FROM schedxactions
        WHERE guid = ${sxGuid}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        return { success: false as const, error: `Scheduled transaction ${sxGuid} not found` };
      }

      const sx = rows[0];

      // Check rem_occur
      if (sx.rem_occur === 0) {
        return { success: false as const, error: 'Scheduled transaction has no remaining occurrences' };
      }

      // Update metadata only (no transaction created)
      // Do NOT increment instance_count on skip — it tracks real transactions created
      const newRemOccur = sx.rem_occur === -1 ? -1 : sx.rem_occur - 1;
      const postDate = new Date(occurrenceDate + 'T12:00:00Z');

      await tx.$executeRaw`
        UPDATE schedxactions
        SET last_occur = ${postDate}, rem_occur = ${newRemOccur}
        WHERE guid = ${sxGuid}
      `;

      return { success: true as const };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Process a batch of execute/skip operations independently.
 * Partial failure is allowed -- each item is processed independently.
 */
export async function batchExecuteSkip(items: BatchItem[]): Promise<BatchResult> {
  const results: BatchResultItem[] = [];

  for (const item of items) {
    if (item.action === 'execute') {
      const result = await executeOccurrence(item.guid, item.occurrenceDate);
      results.push({
        guid: item.guid,
        occurrenceDate: item.occurrenceDate,
        action: item.action,
        success: result.success,
        transactionGuid: result.success ? result.transactionGuid : undefined,
        error: !result.success ? result.error : undefined,
      });
    } else {
      const result = await skipOccurrence(item.guid, item.occurrenceDate);
      results.push({
        guid: item.guid,
        occurrenceDate: item.occurrenceDate,
        action: item.action,
        success: result.success,
        error: !result.success ? result.error : undefined,
      });
    }
  }

  return { results };
}
