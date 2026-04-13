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

export interface PayslipSplit {
  accountGuid: string;
  amount: number;
  memo: string;
}

/**
 * Validate that payslip line items balance against net pay.
 *
 * Sums all non-employer-contribution line items and subtracts netPay.
 * A balanced payslip returns 0.
 *
 * @param lineItems - Payslip line items
 * @param netPay - Expected net pay (deposit amount)
 * @returns Imbalance amount (0 = balanced)
 */
export function validatePayslipBalance(lineItems: PayslipLineItem[], netPay: number): number {
  const total = lineItems
    .filter(item => item.category !== 'employer_contribution')
    .reduce((sum, item) => sum + item.amount, 0);

  const imbalance = total - netPay;
  return Math.round(imbalance * 100) / 100;
}

/**
 * Build GnuCash splits from payslip line items.
 *
 * GnuCash sign convention:
 * - Earnings credit income accounts (negative)
 * - Taxes/deductions debit expense accounts (positive, negated from payslip)
 * - Net pay debits bank account (positive)
 *
 * @param lineItems - Payslip line items
 * @param mappings - Map from "category:normalized_label" to account GUID
 * @param depositAccountGuid - Bank/deposit account GUID for net pay
 * @param netPay - Net pay amount (positive debit to bank)
 * @returns Array of splits ready for transaction insertion
 */
export function buildSplitsFromLineItems(
  lineItems: PayslipLineItem[],
  mappings: Record<string, string>,
  depositAccountGuid: string,
  netPay: number
): PayslipSplit[] {
  const splits: PayslipSplit[] = [];

  for (const item of lineItems) {
    if (item.category === 'employer_contribution') continue;

    const key = `${item.category}:${item.normalized_label}`;
    const accountGuid = mappings[key];
    if (!accountGuid) continue;

    splits.push({
      accountGuid,
      amount: -item.amount,
      memo: item.label,
    });
  }

  // Add deposit split (debit bank account)
  splits.push({
    accountGuid: depositAccountGuid,
    amount: netPay,
    memo: 'Net Pay',
  });

  return splits;
}

/**
 * Post a payslip as a GnuCash transaction atomically.
 *
 * @param payslipId - Payslip database ID to mark as posted
 * @param bookGuid - GnuCash book GUID (unused, kept for future use)
 * @param currencyGuid - Currency commodity GUID
 * @param lineItems - Payslip line items
 * @param mappings - Map from "category:normalized_label" to account GUID
 * @param depositAccountGuid - Bank/deposit account GUID
 * @param netPay - Net pay amount
 * @param payDate - Pay date (YYYY-MM-DD)
 * @param employerName - Employer name for transaction description
 * @param imbalanceAccountGuid - Optional account to absorb any imbalance
 * @returns Transaction GUID
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
    await tx.$executeRaw`
      UPDATE payslips
      SET status = 'posted', transaction_guid = ${transactionGuid}
      WHERE id = ${payslipId}
    `;

    return transactionGuid;
  });
}
