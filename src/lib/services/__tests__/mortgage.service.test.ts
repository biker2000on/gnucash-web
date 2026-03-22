/**
 * Mortgage Detection Service Tests
 *
 * Tests for:
 * - detectOriginalAmount (opening balance and fallback strategies)
 * - detectInterestRate (Newton-Raphson convergence)
 * - separateSplits (principal/interest separation, escrow exclusion)
 * - detectMortgageDetails (full pipeline)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MortgageService } from '../mortgage.service';

// Mock prisma
vi.mock('@/lib/prisma', () => ({
  default: {
    splits: { findMany: vi.fn() },
  },
}));

import prisma from '@/lib/prisma';

const mockPrisma = vi.mocked(prisma);

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper to create a split object
function makeSplit(
  txGuid: string,
  accountGuid: string,
  valueNum: number,
  valueDenom: number,
  postDate: Date
) {
  return {
    tx_guid: txGuid,
    account_guid: accountGuid,
    value_num: BigInt(valueNum),
    value_denom: BigInt(valueDenom),
    post_date: postDate,
  };
}

const MORTGAGE_GUID = 'mortgage-account-guid-00000000';
const INTEREST_GUID = 'interest-account-guid-00000000';
const ESCROW_GUID = 'escrow-account-guid-000000000';
const BANK_GUID = 'bank-account-guid-0000000000';

describe('MortgageService.detectOriginalAmount', () => {
  it('T1: returns opening balance amount when present', () => {
    const openingDate = new Date('2020-01-15');
    const paymentDate = new Date('2020-02-15');

    const splits = [
      // Opening balance: $200,000 credited to mortgage liability
      makeSplit('tx-open', MORTGAGE_GUID, -20000000, 100, openingDate),
      // Regular payment: $500 principal
      makeSplit('tx-pay1', MORTGAGE_GUID, 50000, 100, paymentDate),
    ];

    const result = MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID);
    expect(result).toBe(200000);
  });

  it('T2: falls back to sum of principal when no clear opening balance', () => {
    // All splits are similar sized (no large opening balance)
    const splits = [
      makeSplit('tx-1', MORTGAGE_GUID, 50000, 100, new Date('2020-01-15')),
      makeSplit('tx-2', MORTGAGE_GUID, 51000, 100, new Date('2020-02-15')),
      makeSplit('tx-3', MORTGAGE_GUID, 49000, 100, new Date('2020-03-15')),
    ];

    const result = MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID);
    // Sum: 500 + 510 + 490 = 1500
    expect(result).toBe(1500);
  });
});

describe('MortgageService.detectInterestRate', () => {
  it('T3: converges for 30yr at 4.5% ($200k, $1013.37/mo, 360 payments)', () => {
    const result = MortgageService.detectInterestRate(200000, 1013.37, 360);

    expect(result.converged).toBe(true);
    expect(result.rate).toBeCloseTo(4.5, 1); // Within 0.01% of 4.5
  });

  it('T4: returns converged=false for fewer than 3 payments', () => {
    const result = MortgageService.detectInterestRate(200000, 1013.37, 2);

    expect(result.converged).toBe(false);
    expect(result.rate).toBe(0);
  });

  it('T6: returns converged=false for degenerate data', () => {
    // Zero principal
    const result = MortgageService.detectInterestRate(0, 1000, 360);

    expect(result.converged).toBe(false);
  });
});

describe('MortgageService - Variable Rate Detection', () => {
  it('T5: flags variable rate when variance > 0.5%', async () => {
    // Create splits that simulate varying interest rates
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      post_date: Date;
      transaction: { post_date: Date };
    }> = [];

    const baseDate = new Date('2020-01-15');
    let balance = 200000;

    // First, add the opening balance
    splits.push({
      tx_guid: 'tx-open',
      account_guid: MORTGAGE_GUID,
      value_num: BigInt(-20000000),
      value_denom: BigInt(100),
      post_date: new Date('2019-12-01'),
      transaction: { post_date: new Date('2019-12-01') },
    });

    // Create 12 payments with varying rates (3.5% to 5.5%)
    for (let i = 0; i < 12; i++) {
      const date = new Date(baseDate);
      date.setMonth(date.getMonth() + i);
      const txGuid = `tx-pay-${i}`;

      // Vary the rate from 3.5% to 5.5%
      const annualRate = 0.035 + (i / 11) * 0.02;
      const monthlyRate = annualRate / 12;
      const interest = Math.round(balance * monthlyRate * 100);
      const principal = 50000; // ~$500 principal
      balance -= principal / 100;

      // Principal split
      splits.push({
        tx_guid: txGuid,
        account_guid: MORTGAGE_GUID,
        value_num: BigInt(principal),
        value_denom: BigInt(100),
        post_date: date,
        transaction: { post_date: date },
      });

      // Interest split
      splits.push({
        tx_guid: txGuid,
        account_guid: INTEREST_GUID,
        value_num: BigInt(interest),
        value_denom: BigInt(100),
        post_date: date,
        transaction: { post_date: date },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(
      MORTGAGE_GUID,
      INTEREST_GUID
    );

    expect(result.warnings).toContain('Variable rate detected');
  });
});

describe('MortgageService.separateSplits', () => {
  it('T7: correctly separates principal and interest', () => {
    const date = new Date('2020-02-15');
    const splits = [
      // Principal: $500 to mortgage account
      makeSplit('tx-1', MORTGAGE_GUID, 50000, 100, date),
      // Interest: $750 to interest account
      makeSplit('tx-1', INTEREST_GUID, 75000, 100, date),
      // Bank debit (source of payment)
      makeSplit('tx-1', BANK_GUID, -125000, 100, date),
    ];

    const result = MortgageService.separateSplits(
      splits,
      MORTGAGE_GUID,
      INTEREST_GUID
    );

    expect(result).toHaveLength(1);
    expect(result[0].principal).toBe(500);
    expect(result[0].interest).toBe(750);
    expect(result[0].total).toBe(1250);
  });

  it('T8: excludes escrow splits (different account GUIDs)', () => {
    const date = new Date('2020-02-15');
    const splits = [
      makeSplit('tx-1', MORTGAGE_GUID, 50000, 100, date),
      makeSplit('tx-1', INTEREST_GUID, 75000, 100, date),
      // Escrow split - should be excluded
      makeSplit('tx-1', ESCROW_GUID, 30000, 100, date),
      makeSplit('tx-1', BANK_GUID, -155000, 100, date),
    ];

    const result = MortgageService.separateSplits(
      splits,
      MORTGAGE_GUID,
      INTEREST_GUID
    );

    expect(result).toHaveLength(1);
    // Escrow ($300) should NOT be included in the total
    expect(result[0].principal).toBe(500);
    expect(result[0].interest).toBe(750);
    expect(result[0].total).toBe(1250);
  });

  it('T9: returns empty array when no interest splits', () => {
    const splits = [
      // Only bank splits, no mortgage or interest
      makeSplit('tx-1', BANK_GUID, -100000, 100, new Date('2020-02-15')),
    ];

    const result = MortgageService.separateSplits(
      splits,
      MORTGAGE_GUID,
      INTEREST_GUID
    );

    expect(result).toHaveLength(0);
  });
});

describe('MortgageService.detectMortgageDetails', () => {
  it('T10: full pipeline returns complete mortgage details', async () => {
    const openingDate = new Date('2020-01-01');
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      post_date: Date;
      transaction: { post_date: Date };
    }> = [];

    // Opening balance: $200,000
    splits.push({
      tx_guid: 'tx-open',
      account_guid: MORTGAGE_GUID,
      value_num: BigInt(-20000000),
      value_denom: BigInt(100),
      post_date: openingDate,
      transaction: { post_date: openingDate },
    });

    // Generate 12 months of payments at 4.5% rate
    let balance = 200000;
    const monthlyRate = 0.045 / 12;

    for (let i = 0; i < 12; i++) {
      const date = new Date('2020-02-01');
      date.setMonth(date.getMonth() + i);
      const txGuid = `tx-pay-${i}`;

      const interest = Math.round(balance * monthlyRate * 100); // in cents
      const principal = 101337 - interest; // Total payment ~$1013.37
      balance -= principal / 100;

      splits.push({
        tx_guid: txGuid,
        account_guid: MORTGAGE_GUID,
        value_num: BigInt(principal),
        value_denom: BigInt(100),
        post_date: date,
        transaction: { post_date: date },
      });

      splits.push({
        tx_guid: txGuid,
        account_guid: INTEREST_GUID,
        value_num: BigInt(interest),
        value_denom: BigInt(100),
        post_date: date,
        transaction: { post_date: date },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(
      MORTGAGE_GUID,
      INTEREST_GUID
    );

    expect(result.originalAmount).toBe(200000);
    expect(result.interestRate).toBeCloseTo(4.5, 0);
    expect(result.monthlyPayment).toBeCloseTo(1013.37, 0);
    expect(result.paymentsAnalyzed).toBe(13); // 12 regular + 1 opening balance
    expect(result.confidence).toBe('high');
    expect(result.warnings).not.toContain('Insufficient data');
  });
});
