import { describe, it, expect } from 'vitest';
import { validatePayslipBalance, buildSplitsFromLineItems } from '../services/payslip-post.service';
import type { PayslipLineItem } from '@/lib/types';

describe('validatePayslipBalance', () => {
  it('returns zero imbalance for balanced payslip', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'tax', label: 'Federal Tax', normalized_label: 'federal_income_tax', amount: -600 },
      { category: 'deduction', label: '401k', normalized_label: '401k', amount: -400 },
    ];
    const netPay = 3000;
    const imbalance = validatePayslipBalance(lineItems, netPay);
    expect(imbalance).toBe(0);
  });

  it('returns positive imbalance when line items exceed net pay', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'tax', label: 'Federal Tax', normalized_label: 'federal_income_tax', amount: -600 },
    ];
    const netPay = 3000;
    const imbalance = validatePayslipBalance(lineItems, netPay);
    expect(imbalance).toBe(400);
  });
});

describe('buildSplitsFromLineItems', () => {
  it('creates splits for each mapped line item plus deposit', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'tax', label: 'Federal Tax', normalized_label: 'federal_income_tax', amount: -600 },
    ];
    const mappings: Record<string, string> = {
      'earnings:regular_pay': 'income-guid',
      'tax:federal_income_tax': 'tax-guid',
    };
    const depositAccountGuid = 'bank-guid';
    const netPay = 3400;
    const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

    expect(splits).toHaveLength(3);

    // Earnings: credit income account (negative in GnuCash)
    const earningsSplit = splits.find(s => s.accountGuid === 'income-guid');
    expect(earningsSplit).toBeDefined();
    expect(earningsSplit!.amount).toBe(-4000);

    // Tax: debit expense account (positive in GnuCash — original is -600, negated = 600)
    const taxSplit = splits.find(s => s.accountGuid === 'tax-guid');
    expect(taxSplit).toBeDefined();
    expect(taxSplit!.amount).toBe(600);

    // Deposit: debit bank (positive)
    const depositSplit = splits.find(s => s.accountGuid === 'bank-guid');
    expect(depositSplit).toBeDefined();
    expect(depositSplit!.amount).toBe(3400);
  });

  it('excludes employer_contribution items from splits', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'employer_contribution', label: '401k Match', normalized_label: '401k_match', amount: 200 },
    ];
    const mappings: Record<string, string> = {
      'earnings:regular_pay': 'income-guid',
      'employer_contribution:401k_match': 'match-guid',
    };
    const splits = buildSplitsFromLineItems(lineItems, mappings, 'bank-guid', 4000);
    expect(splits).toHaveLength(2);
    expect(splits.find(s => s.accountGuid === 'match-guid')).toBeUndefined();
  });
});
