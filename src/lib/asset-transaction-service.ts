/**
 * Asset Transaction Service
 *
 * Creates depreciation/appreciation transactions for fixed asset accounts.
 * Value changes are recorded as real GnuCash double-entry transactions:
 * - Depreciation: CREDIT asset (reduce balance), DEBIT expense
 * - Appreciation: DEBIT asset (increase balance), CREDIT income
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { logAudit } from '@/lib/services/audit.service';
import { generateSchedule, type DepreciationConfig } from '@/lib/depreciation';

export interface CreateValuationTransactionParams {
  assetAccountGuid: string;
  contraAccountGuid: string;
  amount: number; // Always positive -- sign is determined by type
  type: 'depreciation' | 'appreciation';
  date: string; // YYYY-MM-DD
  description?: string;
  memo?: string;
}

export interface AdjustToTargetValueParams {
  assetAccountGuid: string;
  contraAccountGuid: string;
  targetValue: number;
  date: string;
  description?: string;
}

/**
 * Get the current balance of an asset account by summing all splits.
 */
export async function getAssetBalance(accountGuid: string): Promise<number> {
  const result = await prisma.$queryRaw<{ total: string | null }[]>`
    SELECT COALESCE(
      SUM(CAST(value_num AS DOUBLE PRECISION) / CAST(value_denom AS DOUBLE PRECISION)),
      0
    )::TEXT AS total
    FROM splits
    WHERE account_guid = ${accountGuid}
  `;
  return parseFloat(result[0]?.total ?? '0');
}

/**
 * Get the currency GUID for an account (from the account's commodity).
 */
async function getAccountCurrencyGuid(accountGuid: string): Promise<string> {
  const account = await prisma.accounts.findUnique({
    where: { guid: accountGuid },
    select: { commodity_guid: true },
  });
  if (!account?.commodity_guid) {
    throw new Error(`Account ${accountGuid} has no commodity/currency`);
  }
  return account.commodity_guid;
}

/**
 * Create a single depreciation or appreciation transaction.
 *
 * Depreciation: CREDIT asset (negative split), DEBIT expense (positive split)
 * Appreciation: DEBIT asset (positive split), CREDIT income (negative split)
 */
export async function createValuationTransaction(
  params: CreateValuationTransactionParams
): Promise<{ transactionGuid: string }> {
  const {
    assetAccountGuid,
    contraAccountGuid,
    amount,
    type,
    date,
    description,
    memo,
  } = params;

  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }

  const currencyGuid = await getAccountCurrencyGuid(assetAccountGuid);
  const denom = 100;
  const valueNum = Math.round(amount * denom);

  const transactionGuid = generateGuid();
  const postDate = new Date(date + 'T12:00:00Z');
  const now = new Date();

  const defaultDescription = type === 'depreciation'
    ? (description || 'Depreciation')
    : (description || 'Appreciation');

  const defaultMemo = memo || (type === 'depreciation' ? 'Depreciation entry' : 'Appreciation entry');

  // For depreciation: asset is credited (negative), contra (expense) is debited (positive)
  // For appreciation: asset is debited (positive), contra (income) is credited (negative)
  const assetSplitValue = type === 'depreciation' ? -valueNum : valueNum;
  const contraSplitValue = type === 'depreciation' ? valueNum : -valueNum;

  await prisma.$transaction(async (tx) => {
    await tx.transactions.create({
      data: {
        guid: transactionGuid,
        currency_guid: currencyGuid,
        num: '',
        post_date: postDate,
        enter_date: now,
        description: defaultDescription,
      },
    });

    await tx.splits.createMany({
      data: [
        {
          guid: generateGuid(),
          tx_guid: transactionGuid,
          account_guid: assetAccountGuid,
          memo: defaultMemo,
          action: '',
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: BigInt(assetSplitValue),
          value_denom: BigInt(denom),
          quantity_num: BigInt(assetSplitValue),
          quantity_denom: BigInt(denom),
          lot_guid: null,
        },
        {
          guid: generateGuid(),
          tx_guid: transactionGuid,
          account_guid: contraAccountGuid,
          memo: defaultMemo,
          action: '',
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: BigInt(contraSplitValue),
          value_denom: BigInt(denom),
          quantity_num: BigInt(contraSplitValue),
          quantity_denom: BigInt(denom),
          lot_guid: null,
        },
      ],
    });
  });

  await logAudit('CREATE', 'TRANSACTION', transactionGuid, null, {
    type,
    assetAccountGuid,
    contraAccountGuid,
    amount,
    date,
    description: defaultDescription,
  });

  return { transactionGuid };
}

/**
 * Adjust a fixed asset to a specific target value by creating the appropriate transaction.
 * Calculates the delta from the current balance.
 */
export async function adjustToTargetValue(
  params: AdjustToTargetValueParams
): Promise<{ transactionGuid: string; adjustmentAmount: number; type: 'depreciation' | 'appreciation' }> {
  const { assetAccountGuid, contraAccountGuid, targetValue, date, description } = params;

  const currentBalance = await getAssetBalance(assetAccountGuid);
  const delta = targetValue - currentBalance;

  if (Math.abs(delta) < 0.005) {
    throw new Error('Target value is the same as current balance (no adjustment needed)');
  }

  const type: 'depreciation' | 'appreciation' = delta < 0 ? 'depreciation' : 'appreciation';
  const amount = Math.abs(delta);

  const result = await createValuationTransaction({
    assetAccountGuid,
    contraAccountGuid,
    amount,
    type,
    date,
    description: description || `Valuation adjustment to ${targetValue.toFixed(2)}`,
    memo: `Adjusted from ${currentBalance.toFixed(2)} to ${targetValue.toFixed(2)}`,
  });

  return {
    transactionGuid: result.transactionGuid,
    adjustmentAmount: amount,
    type,
  };
}

/**
 * Process a depreciation schedule and generate all pending transactions
 * from the last transaction date (or purchase date) up to the given date.
 */
export async function processDepreciationSchedule(
  scheduleId: number,
  upToDate?: Date
): Promise<{ transactionsCreated: number; newBalance: number }> {
  const schedule = await prisma.gnucash_web_depreciation_schedules.findUnique({
    where: { id: scheduleId },
  });

  if (!schedule) {
    throw new Error(`Depreciation schedule not found: ${scheduleId}`);
  }

  if (!schedule.enabled) {
    throw new Error('Depreciation schedule is disabled');
  }

  const endDate = upToDate ?? new Date();

  const config: DepreciationConfig = {
    purchasePrice: Number(schedule.purchase_price),
    purchaseDate: new Date(schedule.purchase_date),
    salvageValue: Number(schedule.salvage_value),
    usefulLifeYears: schedule.useful_life_years,
    method: schedule.method as 'straight-line' | 'declining-balance',
    declineRate: schedule.decline_rate ? Number(schedule.decline_rate) : undefined,
    frequency: schedule.frequency as 'monthly' | 'quarterly' | 'yearly',
    isAppreciation: schedule.is_appreciation,
  };

  const fullSchedule = generateSchedule(config);
  const type = schedule.is_appreciation ? 'appreciation' : 'depreciation';

  // Filter to entries after last_transaction_date and up to endDate
  const lastTxDate = schedule.last_transaction_date
    ? new Date(schedule.last_transaction_date)
    : new Date(schedule.purchase_date);

  const pendingEntries = fullSchedule.filter(
    (entry) => entry.date > lastTxDate && entry.date <= endDate
  );

  let transactionsCreated = 0;
  let latestDate: Date | null = null;

  for (const entry of pendingEntries) {
    const dateStr = entry.date.toISOString().split('T')[0];
    await createValuationTransaction({
      assetAccountGuid: schedule.account_guid,
      contraAccountGuid: schedule.contra_account_guid,
      amount: entry.periodAmount,
      type,
      date: dateStr,
      description: `Scheduled ${type}: ${config.method}`,
      memo: `Auto-generated from schedule #${scheduleId}`,
    });
    transactionsCreated++;
    latestDate = entry.date;
  }

  // Update last_transaction_date on the schedule
  if (latestDate) {
    await prisma.gnucash_web_depreciation_schedules.update({
      where: { id: scheduleId },
      data: { last_transaction_date: latestDate, updated_at: new Date() },
    });
  }

  const newBalance = await getAssetBalance(schedule.account_guid);
  return { transactionsCreated, newBalance };
}
