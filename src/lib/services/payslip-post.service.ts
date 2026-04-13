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
export type { PayslipSplit } from '@/lib/payslip-splits';
export { validatePayslipBalance, buildSplitsFromLineItems } from '@/lib/payslip-splits';

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
    await tx.gnucash_web_payslips.update({
      where: { id: payslipId },
      data: {
        status: 'posted',
        transaction_guid: transactionGuid,
        deposit_account_guid: depositAccountGuid,
        updated_at: new Date(),
      },
    });

    return transactionGuid;
  });
}
