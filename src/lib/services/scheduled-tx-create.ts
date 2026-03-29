/**
 * Scheduled Transaction Create Service
 *
 * Creates the full GnuCash template structure for a new scheduled transaction
 * in a single database transaction:
 * - Template root account under the book's Template Root
 * - Template child accounts with slot mappings to real accounts
 * - Template transaction and splits
 * - schedxaction record
 * - recurrence record
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';

export interface CreateScheduledTxInput {
  name: string;
  startDate: string;
  endDate: string | null;
  recurrence: {
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  };
  splits: Array<{
    accountGuid: string;
    amount: number;
  }>;
  autoCreate: boolean;
  autoNotify: boolean;
}

export interface CreateSuccessResult {
  success: true;
  guid: string;
}

export interface CreateErrorResult {
  success: false;
  error: string;
}

export type CreateScheduledTxResult = CreateSuccessResult | CreateErrorResult;

const VALID_PERIOD_TYPES = [
  'once', 'daily', 'weekly', 'month', 'end of month',
  'semi_monthly', 'year', 'nth weekday', 'last weekday',
];

export async function createScheduledTransaction(
  input: CreateScheduledTxInput
): Promise<CreateScheduledTxResult> {
  // Validation
  if (!input.name || input.name.trim() === '') {
    return { success: false, error: 'Name must be non-empty' };
  }

  if (!input.splits || input.splits.length < 2) {
    return { success: false, error: 'At least 2 splits are required' };
  }

  const splitSum = input.splits.reduce((sum, s) => sum + s.amount, 0);
  if (Math.abs(splitSum) > 0.01) {
    return { success: false, error: 'Splits must balance (sum to zero)' };
  }

  if (!VALID_PERIOD_TYPES.includes(input.recurrence.periodType)) {
    return { success: false, error: `Invalid period type: ${input.recurrence.periodType}` };
  }

  // Validate account GUIDs exist
  const accountGuids = input.splits.map(s => s.accountGuid);
  const existingAccounts = await prisma.accounts.findMany({
    where: { guid: { in: accountGuids } },
    select: { guid: true },
  });
  const existingGuids = new Set(existingAccounts.map(a => a.guid));
  const missing = accountGuids.filter(g => !existingGuids.has(g));
  if (missing.length > 0) {
    return { success: false, error: `Account(s) not found: ${missing.join(', ')}` };
  }

  try {
    const sxGuid = generateGuid();

    await prisma.$transaction(async (tx) => {
      // Step 1: Find book's template root
      const templateRoots = await tx.$queryRaw<Array<{ guid: string }>>`
        SELECT guid FROM accounts WHERE name = 'Template Root' AND account_type = 'ROOT' LIMIT 1
      `;
      if (templateRoots.length === 0) {
        throw new Error('Template Root account not found');
      }
      const templateRootGuid = templateRoots[0].guid;

      // Step 2: Get book currency from root account
      const bookCurrency = await tx.$queryRaw<Array<{ commodity_guid: string }>>`
        SELECT a.commodity_guid FROM accounts a
        JOIN books b ON b.root_account_guid = a.guid
        LIMIT 1
      `;
      if (bookCurrency.length === 0) {
        throw new Error('No book currency found');
      }
      const currencyGuid = bookCurrency[0].commodity_guid;

      // Step 3: Create template root account for this SX
      const sxRootGuid = generateGuid();
      await tx.$executeRaw`
        INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
        VALUES (${sxRootGuid}, ${input.name}, 'BANK', ${currencyGuid}, 100, 0, ${templateRootGuid}, '', '', 0, 0)
      `;

      // Step 4: Create template child accounts + slots, and collect child guids
      const childGuids: string[] = [];
      for (const split of input.splits) {
        const childGuid = generateGuid();
        childGuids.push(childGuid);

        await tx.$executeRaw`
          INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
          VALUES (${childGuid}, '', 'BANK', ${currencyGuid}, 100, 0, ${sxRootGuid}, '', '', 0, 0)
        `;

        await tx.$executeRaw`
          INSERT INTO slots (obj_guid, name, slot_type, string_val, guid_val)
          VALUES (${childGuid}, 'account', 4, NULL, ${split.accountGuid})
        `;
      }

      // Step 5: Create template transaction
      const txGuid = generateGuid();
      await tx.$executeRaw`
        INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
        VALUES (${txGuid}, ${currencyGuid}, '', NULL, NOW(), ${input.name})
      `;

      // Step 6: Create template splits
      for (let i = 0; i < input.splits.length; i++) {
        const split = input.splits[i];
        const childGuid = childGuids[i];
        const { num, denom } = fromDecimal(split.amount);
        const splitGuid = generateGuid();

        await tx.$executeRaw`
          INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
          VALUES (${splitGuid}, ${txGuid}, ${childGuid}, '', '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
        `;
      }

      // Step 7: Create schedxaction
      await tx.$executeRaw`
        INSERT INTO schedxactions (guid, name, enabled, start_date, end_date, last_occur, num_occur, rem_occur, auto_create, auto_notify, adv_creation, adv_notify, instance_count, template_act_guid)
        VALUES (${sxGuid}, ${input.name}, 1, ${input.startDate}, ${input.endDate}, NULL, -1, -1, ${input.autoCreate ? 1 : 0}, ${input.autoNotify ? 1 : 0}, 0, 0, 0, ${sxRootGuid})
      `;

      // Step 8: Create recurrence
      await tx.$executeRaw`
        INSERT INTO recurrences (obj_guid, recurrence_mult, recurrence_period_type, recurrence_period_start, recurrence_weekend_adjust)
        VALUES (${sxGuid}, ${input.recurrence.mult}, ${input.recurrence.periodType}, ${input.recurrence.periodStart}, ${input.recurrence.weekendAdjust})
      `;
    });

    return { success: true, guid: sxGuid };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
