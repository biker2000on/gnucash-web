/**
 * Scheduled Transaction Execute/Skip/Batch Service
 *
 * Handles executing and skipping scheduled transaction occurrences:
 * - Execute: creates a real transaction from the template, updates metadata
 * - Skip: advances metadata without creating a transaction
 * - Batch: processes multiple execute/skip items independently
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { resolveTemplateSplits } from '@/lib/scheduled-transactions';

/**
 * Denominator every posted split is written at. Template accounts are created
 * with commodity_scu 100 in the book currency, so cents is the target scale
 * even when the template itself stores finer fractions.
 */
export const POSTING_DENOM = 100;

export type BalancedNumerators =
  | { ok: true; nums: number[] }
  | { ok: false; error: string };

/**
 * Convert decimal split amounts to integer numerators at a common denominator,
 * guaranteeing `sum(nums) === 0`.
 *
 * Rounding each amount independently drops the residual: a balanced template of
 * 33.333333 / 33.333333 / 33.333334 / -100.00 rounds to 3333 + 3333 + 3333 -
 * 10000, a one-cent hole in the books. The residual is instead absorbed by the
 * largest-magnitude split — deterministic, and the split where a sub-cent
 * adjustment is proportionally smallest (ties go to the earliest, so the result
 * does not depend on sort stability).
 *
 * Amounts that cannot balance within rounding error are REJECTED rather than
 * corrected: absorbing a real imbalance would silently rewrite an amount the
 * user entered.
 */
export function balanceSplitNumerators(
  amounts: number[],
  denom: number = POSTING_DENOM,
): BalancedNumerators {
  if (amounts.length === 0) {
    return { ok: false, error: 'Transaction has no splits' };
  }
  if (amounts.some(amount => !Number.isFinite(amount))) {
    return { ok: false, error: 'Every split amount must be a finite number' };
  }

  const nums = amounts.map(amount => Math.round(amount * denom));
  const residual = nums.reduce((sum, num) => sum + num, 0);

  // Rounding moves each split by at most half a unit, so a set that truly
  // balances can never drift past ceil(n/2) units. Anything beyond that is a
  // genuinely unbalanced set.
  if (Math.abs(residual) > Math.ceil(amounts.length / 2)) {
    return {
      ok: false,
      error: `Splits must balance (sum to zero); off by ${residual / denom}`,
    };
  }

  if (residual !== 0) {
    let absorber = 0;
    for (let i = 1; i < nums.length; i++) {
      if (Math.abs(nums[i]) > Math.abs(nums[absorber])) absorber = i;
    }
    nums[absorber] -= residual;
  }

  return { ok: true, nums };
}

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
  /** Machine-readable reason; routes map 'already_executed' to HTTP 409. */
  code?: 'already_executed';
}

/**
 * Occurrence idempotency guard (call INSIDE the FOR UPDATE block so the check
 * is serialized): an occurrence on or before last_occur has already been
 * executed or skipped — a second Record/Skip must not double-book it.
 */
export function alreadyProcessed(lastOccur: Date | string | null, occurrenceDate: string): boolean {
  if (!lastOccur) return false;
  const lastDay = (lastOccur instanceof Date ? lastOccur.toISOString() : String(lastOccur)).slice(0, 10);
  return occurrenceDate <= lastDay;
}

const ALREADY_EXECUTED_ERROR: ErrorResult = {
  success: false,
  error: 'This occurrence has already been recorded or skipped',
  code: 'already_executed',
};

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
  /** 'already_executed' when the occurrence was processed by someone else — the batch continues past it. */
  code?: 'already_executed';
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

      // Idempotency: reject an occurrence already executed/skipped. Checked
      // inside the FOR UPDATE block so two concurrent Records serialize and
      // the loser deterministically sees the winner's last_occur.
      if (alreadyProcessed(sx.last_occur, occurrenceDate)) {
        return ALREADY_EXECUTED_ERROR;
      }

      // Check rem_occur
      if (sx.rem_occur === 0) {
        return { success: false as const, error: 'Scheduled transaction has no remaining occurrences' };
      }

      // Resolve template splits INSIDE the transaction so the reads share the
      // FOR UPDATE lock's snapshot instead of escaping to the global client.
      const splits = await resolveTemplateSplits(sx.template_act_guid, tx);
      if (splits.length === 0) {
        return { success: false as const, error: 'No template splits found for scheduled transaction' };
      }

      // Round to cents as a SET so the posted splits sum to exactly zero;
      // rounding each one independently leaves a residual in the books.
      const balanced = balanceSplitNumerators(splits.map(split => split.amount));
      if (!balanced.ok) {
        return { success: false as const, error: balanced.error };
      }

      // Get book currency from root account
      const currencyRows = await tx.$queryRaw<{ commodity_guid: string }[]>`
        SELECT a.commodity_guid FROM accounts a
        JOIN books b ON b.root_account_guid = a.guid
        LIMIT 1
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

      // Create splits.
      // Note: no implied-price recording here (unlike TransactionService) —
      // template splits always carry quantity == value (dollar terms), so an
      // implied price would always be a meaningless 1.0. Same applies to the
      // SimpleFin sync path, which lacks share quantities (Phase 1).
      const denom = BigInt(POSTING_DENOM);
      for (const [index, split] of splits.entries()) {
        const splitGuid = generateGuid();
        const num = BigInt(balanced.nums[index]);

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

      // Idempotency: an occurrence already executed/skipped cannot be skipped
      // again (see executeOccurrence).
      if (alreadyProcessed(sx.last_occur, occurrenceDate)) {
        return ALREADY_EXECUTED_ERROR;
      }

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
        code: !result.success ? result.code : undefined,
      });
    } else {
      const result = await skipOccurrence(item.guid, item.occurrenceDate);
      results.push({
        guid: item.guid,
        occurrenceDate: item.occurrenceDate,
        action: item.action,
        success: result.success,
        error: !result.success ? result.error : undefined,
        code: !result.success ? result.code : undefined,
      });
    }
  }

  return { results };
}
