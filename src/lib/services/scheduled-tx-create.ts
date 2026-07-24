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
import { fetchScheduledTransactions, type ScheduledTransaction } from '@/lib/scheduled-transactions';
import { logAudit } from '@/lib/services/audit.service';
import { getAccountGuidsForBook } from '@/lib/book-scope';

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
const VALID_WEEKEND_ADJUSTMENTS = ['none', 'back', 'forward'];

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function validateScheduledTransactionInput(
  input: CreateScheduledTxInput,
  bookGuid?: string,
): Promise<string | null> {
  if (!input || typeof input !== 'object') return 'Schedule input is required';
  if (!input.name || input.name.trim() === '') return 'Name must be non-empty';
  if (input.name.length > 255) return 'Name must be 255 characters or fewer';
  if (!Array.isArray(input.splits) || input.splits.length < 2) return 'At least 2 splits are required';
  if (!isDateOnly(input.startDate)) {
    return 'A valid start date is required';
  }
  if (input.endDate && !isDateOnly(input.endDate)) {
    return 'End date must be valid';
  }
  if (input.endDate && input.endDate < input.startDate) return 'End date cannot be before start date';
  if (!input.recurrence || typeof input.recurrence !== 'object') return 'Recurrence is required';
  if (!isDateOnly(input.recurrence.periodStart)) return 'A valid recurrence start date is required';
  if (!Number.isInteger(input.recurrence?.mult) || input.recurrence.mult < 1) {
    return 'Recurrence multiplier must be a positive integer';
  }
  if (typeof input.autoCreate !== 'boolean' || typeof input.autoNotify !== 'boolean') {
    return 'Automatic creation and notification settings must be true or false';
  }
  if (!VALID_WEEKEND_ADJUSTMENTS.includes(input.recurrence.weekendAdjust)) {
    return 'Invalid weekend adjustment';
  }
  if (input.splits.some(split => (
    !split
    || typeof split !== 'object'
    || typeof split.accountGuid !== 'string'
    || split.accountGuid.trim() === ''
  ))) {
    return 'Every split must reference a valid account';
  }
  const splitSum = input.splits.reduce((sum, split) => sum + split.amount, 0);
  if (Math.abs(splitSum) > 0.005) return 'Splits must balance (sum to zero)';
  if (input.splits.some(split => !Number.isFinite(split.amount))) {
    return 'Every split amount must be a finite number';
  }
  if (!VALID_PERIOD_TYPES.includes(input.recurrence.periodType)) {
    return `Invalid period type: ${input.recurrence.periodType}`;
  }

  const accountGuids = [...new Set(input.splits.map(split => split.accountGuid))];
  if (bookGuid) {
    const scopedAccounts = new Set(await getAccountGuidsForBook(bookGuid));
    const outsideBook = accountGuids.filter(guid => !scopedAccounts.has(guid));
    if (outsideBook.length > 0) return 'Every split account must belong to the active book';
  }
  const existingAccounts = await prisma.accounts.findMany({
    where: { guid: { in: accountGuids } },
    select: { guid: true, placeholder: true },
  });
  const existingGuids = new Set(existingAccounts.map(account => account.guid));
  const missing = accountGuids.filter(guid => !existingGuids.has(guid));
  if (missing.length > 0) return `Account(s) not found: ${missing.join(', ')}`;
  if (existingAccounts.some(account => account.placeholder === 1)) {
    return 'Scheduled transaction splits cannot use placeholder accounts';
  }
  return null;
}

async function createTemplateContents(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  sxRootGuid: string,
  currencyGuid: string,
  input: CreateScheduledTxInput,
): Promise<void> {
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

  const txGuid = generateGuid();
  await tx.$executeRaw`
    INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
    VALUES (${txGuid}, ${currencyGuid}, '', NULL, NOW(), ${input.name})
  `;
  for (let index = 0; index < input.splits.length; index++) {
    const split = input.splits[index];
    const { num, denom } = fromDecimal(split.amount);
    await tx.$executeRaw`
      INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
      VALUES (${generateGuid()}, ${txGuid}, ${childGuids[index]}, '', '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
    `;
  }
}

export async function createScheduledTransaction(
  input: CreateScheduledTxInput,
  options: { guid?: string; bookGuid?: string } = {},
): Promise<CreateScheduledTxResult> {
  const validationError = await validateScheduledTransactionInput(input, options.bookGuid);
  if (validationError) return { success: false, error: validationError };

  try {
    const sxGuid = options.guid ?? generateGuid();
    if (options.guid) {
      const existing = await prisma.schedxactions.findUnique({ where: { guid: sxGuid } });
      if (existing) return { success: true, guid: sxGuid };
    }

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

      await createTemplateContents(tx, sxRootGuid, currencyGuid, input);

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

    await logAudit('CREATE', 'SCHEDULED_TRANSACTION', sxGuid, null, input);
    return { success: true, guid: sxGuid };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

export async function getScheduledTransaction(guid: string): Promise<ScheduledTransaction | null> {
  const rows = await fetchScheduledTransactions();
  return rows.find(row => row.guid === guid) ?? null;
}

export async function isScheduledTransactionInBook(guid: string, bookGuid: string): Promise<boolean> {
  const [scheduled, accountGuids] = await Promise.all([
    getScheduledTransaction(guid),
    getAccountGuidsForBook(bookGuid),
  ]);
  if (!scheduled || scheduled.splits.length === 0) return false;
  const scopedAccounts = new Set(accountGuids);
  return scheduled.splits.every(split => scopedAccounts.has(split.accountGuid));
}

export function scheduledToInput(value: ScheduledTransaction): CreateScheduledTxInput {
  if (!value.recurrence) throw new Error('Scheduled transaction has no recurrence');
  return {
    name: value.name,
    startDate: value.startDate ?? value.recurrence.periodStart,
    endDate: value.endDate,
    recurrence: value.recurrence,
    splits: value.splits.map(split => ({ accountGuid: split.accountGuid, amount: split.amount })),
    autoCreate: value.autoCreate,
    autoNotify: value.autoNotify,
  };
}

export async function updateScheduledTransaction(
  guid: string,
  input: CreateScheduledTxInput,
  options: { bookGuid?: string } = {},
): Promise<CreateScheduledTxResult> {
  const validationError = await validateScheduledTransactionInput(input, options.bookGuid);
  if (validationError) return { success: false, error: validationError };
  const before = await getScheduledTransaction(guid);
  if (!before) return { success: false, error: 'Scheduled transaction not found' };
  if (options.bookGuid) {
    const scopedAccounts = new Set(await getAccountGuidsForBook(options.bookGuid));
    if (before.splits.length === 0 || before.splits.some(split => !scopedAccounts.has(split.accountGuid))) {
      return { success: false, error: 'Scheduled transaction not found' };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const sx = await tx.schedxactions.findUnique({ where: { guid } });
      if (!sx) throw new Error('Scheduled transaction not found');
      const childRows = await tx.accounts.findMany({
        where: { parent_guid: sx.template_act_guid },
        select: { guid: true, commodity_guid: true },
      });
      const childGuids = childRows.map(row => row.guid);
      const splitRows = childGuids.length > 0
        ? await tx.splits.findMany({
            where: { account_guid: { in: childGuids } },
            select: { tx_guid: true },
          })
        : [];
      const transactionGuids = [...new Set(splitRows.map(row => row.tx_guid))];

      if (childGuids.length > 0) {
        await tx.splits.deleteMany({ where: { account_guid: { in: childGuids } } });
        await tx.slots.deleteMany({ where: { obj_guid: { in: childGuids } } });
        await tx.accounts.deleteMany({ where: { guid: { in: childGuids } } });
      }
      if (transactionGuids.length > 0) {
        await tx.slots.deleteMany({ where: { obj_guid: { in: transactionGuids } } });
        await tx.transactions.deleteMany({ where: { guid: { in: transactionGuids } } });
      }

      const currencyGuid = childRows[0]?.commodity_guid
        ?? (await tx.accounts.findUnique({
          where: { guid: sx.template_act_guid },
          select: { commodity_guid: true },
        }))?.commodity_guid;
      if (!currencyGuid) throw new Error('Template currency not found');

      await tx.accounts.update({
        where: { guid: sx.template_act_guid },
        data: { name: input.name },
      });
      await createTemplateContents(tx, sx.template_act_guid, currencyGuid, input);
      await tx.schedxactions.update({
        where: { guid },
        data: {
          name: input.name,
          start_date: new Date(`${input.startDate}T12:00:00Z`),
          end_date: input.endDate ? new Date(`${input.endDate}T12:00:00Z`) : null,
          auto_create: input.autoCreate ? 1 : 0,
          auto_notify: input.autoNotify ? 1 : 0,
        },
      });
      await tx.recurrences.deleteMany({ where: { obj_guid: guid } });
      await tx.recurrences.create({
        data: {
          obj_guid: guid,
          recurrence_mult: input.recurrence.mult,
          recurrence_period_type: input.recurrence.periodType,
          recurrence_period_start: new Date(`${input.recurrence.periodStart}T12:00:00Z`),
          recurrence_weekend_adjust: input.recurrence.weekendAdjust,
        },
      });
    });
    await logAudit('UPDATE', 'SCHEDULED_TRANSACTION', guid, scheduledToInput(before), input);
    return { success: true, guid };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function deleteScheduledTransaction(guid: string): Promise<CreateScheduledTxInput | null> {
  const before = await getScheduledTransaction(guid);
  if (!before) return null;
  const snapshot = scheduledToInput(before);
  await prisma.$transaction(async (tx) => {
    const sx = await tx.schedxactions.findUnique({ where: { guid } });
    if (!sx) return;
    const children = await tx.accounts.findMany({
      where: { parent_guid: sx.template_act_guid },
      select: { guid: true },
    });
    const childGuids = children.map(row => row.guid);
    const splits = childGuids.length > 0
      ? await tx.splits.findMany({
          where: { account_guid: { in: childGuids } },
          select: { tx_guid: true },
        })
      : [];
    const transactionGuids = [...new Set(splits.map(row => row.tx_guid))];
    await tx.recurrences.deleteMany({ where: { obj_guid: guid } });
    await tx.schedxactions.delete({ where: { guid } });
    if (childGuids.length > 0) {
      await tx.splits.deleteMany({ where: { account_guid: { in: childGuids } } });
      await tx.slots.deleteMany({ where: { obj_guid: { in: childGuids } } });
      await tx.accounts.deleteMany({ where: { guid: { in: childGuids } } });
    }
    if (transactionGuids.length > 0) {
      await tx.slots.deleteMany({ where: { obj_guid: { in: transactionGuids } } });
      await tx.transactions.deleteMany({ where: { guid: { in: transactionGuids } } });
    }
    await tx.slots.deleteMany({ where: { obj_guid: sx.template_act_guid } });
    await tx.accounts.delete({ where: { guid: sx.template_act_guid } });
  });
  await logAudit('DELETE', 'SCHEDULED_TRANSACTION', guid, snapshot, null);
  return snapshot;
}
