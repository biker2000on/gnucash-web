/**
 * Payslip Transaction Posting Service
 *
 * Generates GnuCash transactions from payslip line items:
 * - Balance validation
 * - Split construction from line item mappings
 * - Atomic transaction creation via Prisma
 */

import { generateGuid, fromDecimal } from '@/lib/gnucash';
import prisma from '@/lib/prisma';
import type { PayslipLineItem } from '@/lib/types';
import { validatePayslipBalance, buildSplitsFromLineItems } from '@/lib/payslip-splits';
import { upsertTemplate } from '@/lib/payslips';
export type { PayslipSplit } from '@/lib/payslip-splits';
export { validatePayslipBalance, buildSplitsFromLineItems } from '@/lib/payslip-splits';

/**
 * Find an existing transaction that matches the payslip splits.
 *
 * Searches for transactions within +/- 3 days of the pay date where
 * every expected split has a matching split (same account, amount within $0.01).
 * Returns the transaction GUID if found, null otherwise.
 */
export async function findMatchingTransaction(
  splits: Array<{ accountGuid: string; amount: number }>,
  payDate: string
): Promise<string | null> {
  const postDate = new Date(payDate + 'T12:00:00Z');
  const dateStart = new Date(postDate.getTime() - 3 * 24 * 60 * 60 * 1000);
  const dateEnd = new Date(postDate.getTime() + 3 * 24 * 60 * 60 * 1000);

  // Find candidate transactions in the date range that have the right number of splits
  const candidates = await prisma.$queryRaw<
    Array<{ guid: string; split_count: number }>
  >`
    SELECT t.guid, COUNT(s.guid)::int AS split_count
    FROM transactions t
    JOIN splits s ON s.tx_guid = t.guid
    WHERE t.post_date BETWEEN ${dateStart} AND ${dateEnd}
    GROUP BY t.guid
    HAVING COUNT(s.guid) = ${splits.length}
  `;

  for (const candidate of candidates) {
    // Get all splits for this candidate transaction
    const txSplits = await prisma.$queryRaw<
      Array<{ account_guid: string; amount: number }>
    >`
      SELECT account_guid, (value_num::float / value_denom::float) AS amount
      FROM splits
      WHERE tx_guid = ${candidate.guid}
    `;

    // Check if every expected split has a match (same account, amount within $0.01)
    const allMatch = splits.every(expected => {
      return txSplits.some(actual =>
        actual.account_guid === expected.accountGuid &&
        Math.abs(actual.amount - expected.amount) < 0.015
      );
    });

    if (allMatch) {
      return candidate.guid;
    }
  }

  return null;
}

/**
 * Post a payslip as a GnuCash transaction atomically.
 * If an existing transaction with matching splits is found, links to it instead of creating a duplicate.
 *
 * @returns Transaction GUID (existing or newly created)
 */
export async function postPayslipTransaction(
  payslipId: number,
  bookGuid: string,
  currencyGuid: string,
  lineItems: PayslipLineItem[],
  mappings: Record<string, string>,
  depositAccountGuid: string,
  netPay: number,
  payDate: string,
  employerName: string,
  imbalanceAccountGuid?: string
): Promise<string> {
  const imbalance = validatePayslipBalance(lineItems, netPay);
  const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

  // Add imbalance split if needed and account provided
  if (imbalance !== 0 && imbalanceAccountGuid) {
    splits.push({
      accountGuid: imbalanceAccountGuid,
      amount: imbalance,
      memo: 'Imbalance',
    });
  }

  // Verify splits sum to zero (GnuCash double-entry requirement)
  const splitsSum = Math.round(splits.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;
  if (splitsSum !== 0) {
    throw new Error(`Transaction splits do not sum to zero: ${splitsSum}`);
  }

  // Check for existing transaction with matching splits (dedup)
  const existingGuid = await findMatchingTransaction(splits, payDate);
  if (existingGuid) {
    // Link payslip to existing transaction instead of creating a duplicate
    await prisma.gnucash_web_payslips.update({
      where: { id: payslipId },
      data: {
        status: 'posted',
        transaction_guid: existingGuid,
        deposit_account_guid: depositAccountGuid,
        updated_at: new Date(),
      },
    });

    // Mark the existing transaction as payslip-verified
    const existingMeta = await prisma.gnucash_web_transaction_meta.findUnique({
      where: { transaction_guid: existingGuid },
    });
    if (existingMeta) {
      await prisma.gnucash_web_transaction_meta.update({
        where: { transaction_guid: existingGuid },
        data: {
          match_type: 'payslip_verified',
          match_confidence: 'high',
          matched_at: new Date(),
        },
      });
    } else {
      await prisma.gnucash_web_transaction_meta.create({
        data: {
          transaction_guid: existingGuid,
          source: 'payslip',
          reviewed: true,
          match_type: 'payslip_verified',
          match_confidence: 'high',
          matched_at: new Date(),
        },
      });
    }

    const templateItems = lineItems.map(item => ({
      category: item.category,
      label: item.label,
      normalized_label: item.normalized_label,
    }));
    await upsertTemplate(bookGuid, employerName, templateItems);

    return existingGuid;
  }

  return await prisma.$transaction(async (tx) => {
    const transactionGuid = generateGuid();
    const postDate = new Date(payDate + 'T12:00:00Z');
    const enterDate = new Date();
    const description = `Payslip: ${employerName}`;

    await tx.$executeRaw`
      INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
      VALUES (${transactionGuid}, ${currencyGuid}, '', ${postDate}, ${enterDate}, ${description})
    `;

    for (const split of splits) {
      const splitGuid = generateGuid();
      const { num, denom } = fromDecimal(split.amount);

      await tx.$executeRaw`
        INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
        VALUES (${splitGuid}, ${transactionGuid}, ${split.accountGuid}, ${split.memo}, '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
      `;
    }

    // Mark payslip as posted
    await tx.gnucash_web_payslips.update({
      where: { id: payslipId },
      data: {
        status: 'posted',
        transaction_guid: transactionGuid,
        deposit_account_guid: depositAccountGuid,
        updated_at: new Date(),
      },
    });

    // Record transaction meta (source: payslip)
    await tx.gnucash_web_transaction_meta.create({
      data: {
        transaction_guid: transactionGuid,
        source: 'payslip',
        reviewed: true,
      },
    });

    // Auto-save employer template from posted line items
    const templateItems = lineItems.map(item => ({
      category: item.category,
      label: item.label,
      normalized_label: item.normalized_label,
    }));
    await upsertTemplate(bookGuid, employerName, templateItems);

    return transactionGuid;
  });
}
