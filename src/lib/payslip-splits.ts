/**
 * Pure payslip split computation functions.
 *
 * These are safe to import in client components — no server-only dependencies.
 */

import type { PayslipLineItem } from '@/lib/types';

export interface PayslipSplit {
  accountGuid: string;
  amount: number;
  memo: string;
}

/**
 * Validate that payslip line items balance against net pay.
 * Returns the imbalance amount (0 = balanced).
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

  splits.push({
    accountGuid: depositAccountGuid,
    amount: netPay,
    memo: 'Net Pay',
  });

  return splits;
}
