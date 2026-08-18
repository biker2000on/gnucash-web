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
    $queryRaw: vi.fn(),
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

  it('T2a: fallback preserves an opening liability credit instead of double-counting later paydowns', () => {
    const splits = [
      // The opening amount is exactly 3x the average paydown, so the original
      // strict `> 3x` heuristic falls through to the fallback.
      makeSplit('tx-open', MORTGAGE_GUID, -150000, 100, new Date('2020-01-15')),
      makeSplit('tx-pay1', MORTGAGE_GUID, 50000, 100, new Date('2020-02-15')),
      makeSplit('tx-pay2', MORTGAGE_GUID, 50000, 100, new Date('2020-03-15')),
      makeSplit('tx-pay3', MORTGAGE_GUID, 50000, 100, new Date('2020-04-15')),
    ];

    // Before the fix, the fallback sums $1,500 + $500 + $500 + $500 = $3,000.
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(1500);
  });

  it('T2b: does not mistake a small first HELOC draw for the original principal', () => {
    const splits = [
      makeSplit('draw-1', MORTGAGE_GUID, -500000, 100, new Date('2020-01-15')),
      makeSplit('draw-2', MORTGAGE_GUID, -8000000, 100, new Date('2022-06-15')),
      ...Array.from({ length: 30 }, (_, i) => makeSplit(
        `pay-${i}`, MORTGAGE_GUID, 50000, 100, new Date(2022, 6 + i, 15),
      )),
    ];

    // Two draws establish $85,000 advanced; the later $15,000 consists of
    // repayments and must not be added to the amount borrowed.
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(85000);
  });

  it('T2c: does not mistake a small first credit for an opening balance', () => {
    const splits = [
      makeSplit('fee', MORTGAGE_GUID, -5000, 100, new Date('2020-01-01')),
      makeSplit('pay-1', MORTGAGE_GUID, 50000, 100, new Date('2020-02-01')),
      makeSplit('pay-2', MORTGAGE_GUID, 50000, 100, new Date('2020-03-01')),
      makeSplit('pay-3', MORTGAGE_GUID, 50000, 100, new Date('2020-04-01')),
    ];

    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(1550);
  });

  it('T2d: preserves a balance-forward import when it dominates later paydowns', () => {
    const splits = [
      makeSplit('import', MORTGAGE_GUID, -12000000, 100, new Date('2020-01-01')),
      makeSplit('pay-1', MORTGAGE_GUID, 50000, 100, new Date('2020-02-01')),
      makeSplit('pay-2', MORTGAGE_GUID, 50000, 100, new Date('2020-03-01')),
    ];

    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(120000);
  });

  it.each([
    ['a $50 servicer fee on a $200,000 mortgage', 200_000, 50],
    ['a $1,200 capitalized escrow shortage on a $300,000 mortgage', 300_000, 1_200],
    ['a $2,500 prepaid-escrow credit on a $300,000 mortgage', 300_000, 2_500],
  ])('keeps a dominant opening balance when followed by %s', (_label, openingAmount, laterCredit) => {
    const splits = [
      makeSplit('opening', MORTGAGE_GUID, -openingAmount * 100, 100, new Date('2020-01-15')),
      makeSplit('adjustment', MORTGAGE_GUID, -laterCredit * 100, 100, new Date('2021-01-15')),
      ...Array.from({ length: 12 }, (_, i) => makeSplit(
        `pay-${i}`, MORTGAGE_GUID, 50_000, 100, new Date(2021, i + 1, 15),
      )),
    ];

    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(openingAmount);
  });

  it('treats secondary credits totaling exactly 2% as immaterial', () => {
    const splits = [
      makeSplit('opening', MORTGAGE_GUID, -200_000 * 100, 100, new Date('2020-01-15')),
      makeSplit('adjustment', MORTGAGE_GUID, -4_000 * 100, 100, new Date('2021-01-15')),
      makeSplit('pay', MORTGAGE_GUID, 50_000, 100, new Date('2021-02-15')),
    ];

    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(200_000);
  });

  it('does not confidently treat the first HELOC draw as the entire principal', () => {
    const splits = [
      makeSplit('draw-1', MORTGAGE_GUID, -5_000_000, 100, new Date('2020-01-15')),
      makeSplit('draw-2', MORTGAGE_GUID, -8_000_000, 100, new Date('2022-06-15')),
      ...Array.from({ length: 30 }, (_, i) => makeSplit(
        `pay-${i}`, MORTGAGE_GUID, 50_000, 100, new Date(2022, 6 + i, 15),
      )),
    ];

    // Before this regression fix, strategy 1 returned the first draw: $50,000.
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).not.toBe(50_000);
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(130_000);
  });

  it('sums same-date opening credits as exact opening principal', async () => {
    const date = new Date('2020-01-15');
    const splits = [
      makeSplit('opening-a', MORTGAGE_GUID, -100_000, 100, date),
      makeSplit('opening-b', MORTGAGE_GUID, -80_000, 100, date),
      ...Array.from({ length: 12 }, (_, i) => [
        makeSplit(`payment-${i}`, MORTGAGE_GUID, 10_000, 100, new Date(2020, i + 1, 15)),
        makeSplit(`payment-${i}`, INTEREST_GUID, 5_000, 100, new Date(2020, i + 1, 15)),
      ]).flat(),
    ].map((split) => ({ ...split, transaction: { post_date: split.post_date } }));

    // Both same-date credits are booked opening principal, not later draws.
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).not.toBe(1_000);
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(1_800);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);
    expect(result.originalAmount).toBe(1_800);
    expect(result.confidence).toBe('high');
    expect(result.warnings).toEqual(['Variable rate detected']);
  });

  it('pins summing all material credits rather than taking only the largest credit', () => {
    const splits = [
      makeSplit('opening', MORTGAGE_GUID, -300_000 * 100, 100, new Date('2020-01-15')),
      makeSplit('draw-a', MORTGAGE_GUID, -15_000 * 100, 100, new Date('2021-01-15')),
      makeSplit('draw-b', MORTGAGE_GUID, -12_000 * 100, 100, new Date('2021-02-15')),
      makeSplit('pay', MORTGAGE_GUID, 50_000, 100, new Date('2021-03-15')),
    ];

    // A max-only mutation returns $315,000 here. Every material credit is a
    // draw, so the estimated principal must include both: $327,000.
    expect(MortgageService.detectOriginalAmount(splits, MORTGAGE_GUID)).toBe(327_000);
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

  it('keeps the sign of liability splits (escrow disbursement is not a paydown)', () => {
    const splits = [
      // Regular payment: $500 principal paydown (debit, positive)
      makeSplit('tx-1', MORTGAGE_GUID, 50000, 100, new Date('2026-03-02')),
      // Escrow disbursement charged to the loan: -$2107 (credit, increases balance)
      makeSplit('tx-2', MORTGAGE_GUID, -210700, 100, new Date('2026-04-02')),
    ];

    const result = MortgageService.separateSplits(
      splits,
      MORTGAGE_GUID,
      INTEREST_GUID
    );

    expect(result).toHaveLength(2);
    expect(result[0].principal).toBe(500);
    expect(result[1].principal).toBe(-2107);
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
  it.each([
    ['a $50 servicer fee', 200_000, 50, []],
    ['a $1,200 capitalized escrow shortage', 300_000, 1_200, []],
    ['a $2,500 prepaid-escrow credit', 300_000, 2_500, []],
    ['a $1,200 capitalized escrow shortage on a $50,000 loan', 50_000, 1_200, []],
    ['a $500 document fee on a $25,000 loan', 25_000, 500, []],
    ['a $400 family-loan fee on a $15,000 loan', 15_000, 400, []],
    ['a $2,200 capitalized modification on a $100,000 loan', 100_000, 2_200, []],
    ['a $2,500 escrow credit on a $125,000 loan', 125_000, 2_500, []],
    ['a $5,000 two-point charge on a $250,000 loan', 250_000, 5_000, []],
    ['a $1,500 escrow credit on a $75,000 loan', 75_000, 1_500, []],
  ])('retains high confidence after %s', async (_label, openingAmount, laterCredit, expectedWarnings) => {
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [
      { tx_guid: 'opening', account_guid: MORTGAGE_GUID, value_num: BigInt(-openingAmount * 100), value_denom: BigInt(100), transaction: { post_date: new Date('2020-01-15') } },
      { tx_guid: 'adjustment', account_guid: MORTGAGE_GUID, value_num: BigInt(-laterCredit * 100), value_denom: BigInt(100), transaction: { post_date: new Date('2021-01-15') } },
    ];
    let balance = openingAmount;
    const monthlyRate = 0.045 / 12;
    const payment = openingAmount * monthlyRate * Math.pow(1 + monthlyRate, 360) /
      (Math.pow(1 + monthlyRate, 360) - 1);
    for (let i = 0; i < 12; i++) {
      const date = new Date(2021, i + 1, 15);
      const interest = Math.round(balance * monthlyRate * 100);
      const principal = Math.round(payment * 100) - interest;
      balance -= principal / 100;
      splits.push(
        { tx_guid: `pay-${i}`, account_guid: MORTGAGE_GUID, value_num: BigInt(principal), value_denom: BigInt(100), transaction: { post_date: date } },
        { tx_guid: `pay-${i}`, account_guid: INTEREST_GUID, value_num: BigInt(interest), value_denom: BigInt(100), transaction: { post_date: date } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);
    expect(result.originalAmount).toBe(openingAmount);
    expect(result.interestRate).toBeCloseTo(4.5, 1);
    expect(result.confidence).toBe('high');
    expect(result.warnings).toEqual(expectedWarnings);
  });

  it('keeps a $1,200 escrow credit on a $50,000 loan at its 6% truth', async () => {
    const openingAmount = 50_000;
    const annualRate = 0.06;
    const monthlyRate = annualRate / 12;
    const payment = openingAmount * monthlyRate * Math.pow(1 + monthlyRate, 360) /
      (Math.pow(1 + monthlyRate, 360) - 1);
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [
      { tx_guid: 'opening', account_guid: MORTGAGE_GUID, value_num: BigInt(-openingAmount * 100), value_denom: BigInt(100), transaction: { post_date: new Date('2020-01-15') } },
      { tx_guid: 'escrow', account_guid: MORTGAGE_GUID, value_num: BigInt(-120_000), value_denom: BigInt(100), transaction: { post_date: new Date('2021-01-15') } },
    ];
    let balance = openingAmount;
    for (let i = 0; i < 12; i++) {
      const interest = Math.round(balance * monthlyRate * 100);
      const principal = Math.round(payment * 100) - interest;
      balance -= principal / 100;
      const date = new Date(2021, i + 1, 15);
      splits.push(
        { tx_guid: `pay-${i}`, account_guid: MORTGAGE_GUID, value_num: BigInt(principal), value_denom: BigInt(100), transaction: { post_date: date } },
        { tx_guid: `pay-${i}`, account_guid: INTEREST_GUID, value_num: BigInt(interest), value_denom: BigInt(100), transaction: { post_date: date } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);
    expect(result).toMatchObject({ originalAmount: 50_000, confidence: 'high', warnings: [] });
    expect(result.interestRate).toBeCloseTo(6, 3);
  });

  it('discloses a credit exactly at the silent/disclose ratio boundary', async () => {
    const openingAmount = 2_000_000;
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [
      { tx_guid: 'opening', account_guid: MORTGAGE_GUID, value_num: BigInt(-openingAmount * 100), value_denom: BigInt(100), transaction: { post_date: new Date('2020-01-15') } },
      { tx_guid: 'adjustment', account_guid: MORTGAGE_GUID, value_num: BigInt(-1_000_000), value_denom: BigInt(100), transaction: { post_date: new Date('2021-01-15') } },
    ];
    let balance = openingAmount;
    const monthlyRate = 0.045 / 12;
    const payment = openingAmount * monthlyRate * Math.pow(1 + monthlyRate, 360) /
      (Math.pow(1 + monthlyRate, 360) - 1);
    for (let i = 0; i < 12; i++) {
      const date = new Date(2021, i + 1, 15);
      const interest = Math.round(balance * monthlyRate * 100);
      const principal = Math.round(payment * 100) - interest;
      balance -= principal / 100;
      splits.push(
        { tx_guid: `pay-${i}`, account_guid: MORTGAGE_GUID, value_num: BigInt(principal), value_denom: BigInt(100), transaction: { post_date: date } },
        { tx_guid: `pay-${i}`, account_guid: INTEREST_GUID, value_num: BigInt(interest), value_denom: BigInt(100), transaction: { post_date: date } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);
    expect(result.originalAmount).toBe(openingAmount);
    expect(result.confidence).toBe('high');
    expect(result.warnings).toEqual(['Secondary liability credit of $10,000 absorbed into the opening balance']);
  });

  it.each([
    [4_000, 300_000, 4.5605, 'high', []],
    [14_000, 314_000, 4.5, 'low', ['Original principal not determinable from ledger — estimated']],
    [15_000, 315_000, 4.5, 'low', ['Original principal not determinable from ledger — estimated']],
  ])('reports an accruing $%d later advance without silently hiding it', async (
    advance,
    expectedPrincipal,
    expectedRate,
    expectedConfidence,
    expectedWarnings,
  ) => {
    const openingAmount = 300_000;
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [
      { tx_guid: 'opening', account_guid: MORTGAGE_GUID, value_num: BigInt(-openingAmount * 100), value_denom: BigInt(100), transaction: { post_date: new Date('2020-01-15') } },
      { tx_guid: 'advance', account_guid: MORTGAGE_GUID, value_num: BigInt(-advance * 100), value_denom: BigInt(100), transaction: { post_date: new Date('2021-01-15') } },
    ];
    const monthlyRate = 0.045 / 12;
    const payment = (openingAmount + advance) * monthlyRate * Math.pow(1 + monthlyRate, 360) /
      (Math.pow(1 + monthlyRate, 360) - 1);
    let balance = openingAmount + advance;
    for (let i = 0; i < 12; i++) {
      const date = new Date(2021, i + 1, 15);
      const interest = Math.round(balance * monthlyRate * 100);
      const principal = Math.round(payment * 100) - interest;
      balance -= principal / 100;
      splits.push(
        { tx_guid: `pay-${i}`, account_guid: MORTGAGE_GUID, value_num: BigInt(principal), value_denom: BigInt(100), transaction: { post_date: date } },
        { tx_guid: `pay-${i}`, account_guid: INTEREST_GUID, value_num: BigInt(interest), value_denom: BigInt(100), transaction: { post_date: date } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);

    expect(result.originalAmount).toBe(expectedPrincipal);
    expect(result.interestRate).toBeCloseTo(expectedRate, 3);
    expect(result.confidence).toBe(expectedConfidence);
    expect(result.warnings).toEqual(expectedWarnings);
  });

  it('does not sum many individually small servicing credits into a phantom draw', async () => {
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [
      { tx_guid: 'opening', account_guid: MORTGAGE_GUID, value_num: BigInt(-30_000_000), value_denom: BigInt(100), transaction: { post_date: new Date('2020-01-15') } },
      ...Array.from({ length: 10 }, (_, i) => ({
        tx_guid: `credit-${i}`,
        account_guid: MORTGAGE_GUID,
        value_num: BigInt(-200_000),
        value_denom: BigInt(100),
        transaction: { post_date: new Date(2021, i, 15) },
      })),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);
    expect(result.originalAmount).toBe(300_000);
    expect(result.confidence).toBe('low');
    expect(result.warnings).toContain('Insufficient data');
  });

  it('downgrades a multi-draw HELOC instead of producing a high-confidence first-draw rate', async () => {
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [
      { tx_guid: 'draw-1', account_guid: MORTGAGE_GUID, value_num: BigInt(-500_000), value_denom: BigInt(100), transaction: { post_date: new Date('2020-01-15') } },
      { tx_guid: 'draw-2', account_guid: MORTGAGE_GUID, value_num: BigInt(-8_000_000), value_denom: BigInt(100), transaction: { post_date: new Date('2022-06-15') } },
    ];
    for (let i = 0; i < 30; i++) {
      const date = new Date(2022, 6 + i, 15);
      splits.push(
        { tx_guid: `pay-${i}`, account_guid: MORTGAGE_GUID, value_num: BigInt(50_000), value_denom: BigInt(100), transaction: { post_date: date } },
        // The later $80,000 draw must be included rather than treating the
        // initial $5,000 HELOC draw as the whole loan.
        { tx_guid: `pay-${i}`, account_guid: INTEREST_GUID, value_num: BigInt(25_000), value_denom: BigInt(100), transaction: { post_date: date } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);

    expect(result.originalAmount).not.toBe(5_000);
    expect(result.originalAmount).toBe(85_000);
    expect(result.interestRate).toBeCloseTo(3.87, 2);
    expect(result.confidence).toBe('low');
    expect(result.warnings).toContain('Original principal not determinable from ledger — estimated');
  });

  it('marks a principal-sum fallback as estimated and low confidence', async () => {
    const splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint;
      value_denom: bigint;
      transaction: { post_date: Date };
    }> = [];
    for (let i = 0; i < 12; i++) {
      const date = new Date(2020, i, 15);
      splits.push(
        { tx_guid: `pay-${i}`, account_guid: MORTGAGE_GUID, value_num: BigInt(50000), value_denom: BigInt(100), transaction: { post_date: date } },
        { tx_guid: `pay-${i}`, account_guid: INTEREST_GUID, value_num: BigInt(10000), value_denom: BigInt(100), transaction: { post_date: date } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPrisma.splits.findMany as any).mockResolvedValue(splits);

    const result = await MortgageService.detectMortgageDetails(MORTGAGE_GUID, INTEREST_GUID);

    expect(result.confidence).toBe('low');
    expect(result.warnings).toContain('Original principal not determinable from ledger — estimated');
  });

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

    // paymentHistory excludes the (negative) opening balance transaction
    expect(result.paymentHistory).toHaveLength(12);
    expect(result.paymentHistory.every((p) => p.principal > 0 && p.principal < 1000)).toBe(true);
  });
});
