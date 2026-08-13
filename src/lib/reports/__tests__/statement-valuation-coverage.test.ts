/**
 * A balance sheet built on a balance we could not value does not balance.
 *
 * The shared valuation context returns a 0 multiplier when no price or rate
 * path exists. That zeroes the unconvertible account's own section while the
 * accounts that funded it stay fully valued in another, so Assets − Liabilities
 * − Equity stops coming out at zero. Both statements must disclose that and
 * withhold the check rather than publish a residual that reads as a rounding
 * error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockAccountsFindFirst = vi.fn();
const mockSplitsFindMany = vi.fn();
const mockBudgetsFindUnique = vi.fn();
const mockOwnershipFindUnique = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    accounts: {
      findMany: (...a: unknown[]) => mockAccountsFindMany(...a),
      findFirst: (...a: unknown[]) => mockAccountsFindFirst(...a),
    },
    splits: { findMany: (...a: unknown[]) => mockSplitsFindMany(...a) },
    budgets: { findUnique: (...a: unknown[]) => mockBudgetsFindUnique(...a) },
    gnucash_web_budget_ownership: {
      findUnique: (...a: unknown[]) => mockOwnershipFindUnique(...a),
    },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}));

vi.mock('@/lib/account-valuation', async (importOriginal) => {
  // Keep the real coverage helpers; only the context builder is faked, so the
  // gap-collection logic under test is the production one.
  const actual = await importOriginal<typeof import('@/lib/account-valuation')>();
  return { ...actual, buildAccountValuationContext: vi.fn() };
});

import { buildAccountValuationContext } from '@/lib/account-valuation';
import { generateBalanceSheet } from '@/lib/reports/balance-sheet';
import { generateBudgetBalanceSheet } from '@/lib/reports/budget-statements';

const mockBuildContext = vi.mocked(buildAccountValuationContext);

const EUR_GAP = {
  commodityGuid: 'eur',
  label: 'EUR',
  reason: 'missing-exchange-rate' as const,
  message: 'EUR excluded: no exchange rate to USD as of 2026-06-30; a 1:1 rate is never assumed.',
};

/** Context in which a EUR balance cannot be converted but USD is fine. */
function unconvertibleEurContext() {
  return {
    reportCurrencyGuid: 'usd',
    reportCurrencyMnemonic: 'USD',
    getMultiplier: (account: { commodityGuid: string | null }) =>
      account.commodityGuid === 'eur' ? 0 : 1,
    isConvertible: (account: { commodityGuid: string | null }) =>
      account.commodityGuid !== 'eur',
    gaps: [EUR_GAP],
    warnings: [EUR_GAP.message],
  };
}

function acct(
  guid: string,
  name: string,
  type: string,
  commodity: string,
  parent: string | null = 'root',
) {
  return {
    guid,
    name,
    account_type: type,
    parent_guid: parent,
    commodity_guid: commodity,
    commodity: { namespace: 'CURRENCY' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateBalanceSheet with an unconvertible balance', () => {
  it('withholds the balance check and discloses the gap', async () => {
    mockAccountsFindFirst.mockResolvedValue({ guid: 'root' });
    mockAccountsFindMany.mockResolvedValue([
      acct('checking-eur', 'Euro Checking', 'BANK', 'eur'),
      acct('equity', 'Opening Balances', 'EQUITY', 'usd'),
    ]);
    // EUR 1,000 of assets, contributed by equity. In a valued book this is a
    // clean zero check.
    mockQueryRaw.mockResolvedValue([
      { account_guid: 'checking-eur', quantity_sum: 1000, value_sum: 1000 },
      { account_guid: 'equity', quantity_sum: -1000, value_sum: -1000 },
    ]);
    mockBuildContext.mockResolvedValue(unconvertibleEurContext());

    const report = await generateBalanceSheet({ startDate: null, endDate: '2026-06-30' });

    // The asset drops out; the equity that funded it does not.
    expect(report.sections.find(s => s.title === 'Assets')!.total).toBeCloseTo(0, 2);
    expect(report.sections.find(s => s.title === 'Equity')!.total).toBeCloseTo(1000, 2);

    // So the identity is off by 1,000. Publishing that residual would present
    // an unbalanced statement as merely imprecise -- withhold it instead.
    expect(report.grandTotal).toBeUndefined();
    expect(report.valuationCoverage).toEqual({
      complete: false,
      unvaluedAccountCount: 1,
      gaps: [EUR_GAP],
    });
  });

  it('is unchanged for a fully valued book', async () => {
    mockAccountsFindFirst.mockResolvedValue({ guid: 'root' });
    mockAccountsFindMany.mockResolvedValue([
      acct('checking', 'Checking', 'BANK', 'usd'),
      acct('equity', 'Opening Balances', 'EQUITY', 'usd'),
    ]);
    mockQueryRaw.mockResolvedValue([
      { account_guid: 'checking', quantity_sum: 1000, value_sum: 1000 },
      { account_guid: 'equity', quantity_sum: -1000, value_sum: -1000 },
    ]);
    mockBuildContext.mockResolvedValue({
      reportCurrencyGuid: 'usd',
      reportCurrencyMnemonic: 'USD',
      getMultiplier: () => 1,
      isConvertible: () => true,
      gaps: [],
      warnings: [],
    });

    const report = await generateBalanceSheet({ startDate: null, endDate: '2026-06-30' });

    expect(report.grandTotal).toBeCloseTo(0, 2);
    expect(report.valuationCoverage).toEqual({
      complete: true,
      unvaluedAccountCount: 0,
      gaps: [],
    });
  });
});

describe('generateBudgetBalanceSheet with an unconvertible balance', () => {
  function setupBudget() {
    mockOwnershipFindUnique.mockResolvedValue({ book_guid: 'book' });
    mockBudgetsFindUnique.mockResolvedValue({
      guid: 'budget',
      name: 'Plan',
      num_periods: 1,
      recurrences: [{
        recurrence_period_type: 'month',
        recurrence_mult: 1,
        recurrence_period_start: new Date('2026-06-01T00:00:00.000Z'),
      }],
      amounts: [],
    });
    mockAccountsFindMany
      // balance-sheet accounts
      .mockResolvedValueOnce([
        acct('checking-eur', 'Euro Checking', 'BANK', 'eur'),
        acct('equity', 'Opening Balances', 'EQUITY', 'usd'),
      ])
      // income/expense accounts for the net-income row
      .mockResolvedValueOnce([]);
    // Opening balances, posted before the budget starts.
    mockSplitsFindMany.mockResolvedValue([
      {
        account_guid: 'checking-eur',
        quantity_num: 1000n,
        quantity_denom: 1n,
        transaction: { post_date: new Date('2026-01-15T00:00:00.000Z') },
      },
      {
        account_guid: 'equity',
        quantity_num: -1000n,
        quantity_denom: 1n,
        transaction: { post_date: new Date('2026-01-15T00:00:00.000Z') },
      },
    ]);
  }

  it('reports the check as unassessable and discloses the gap', async () => {
    setupBudget();
    mockBuildContext.mockResolvedValue(unconvertibleEurContext());

    const report = await generateBudgetBalanceSheet(
      'book', ['checking-eur', 'equity'], 'budget', 0,
    );

    expect(report).not.toBeNull();
    expect(report!.totals.assets.actual).toBeCloseTo(0, 2);
    expect(report!.totals.equity.actual).toBeCloseTo(1000, 2);
    // The check row is non-zero purely because of the missing rate, so the
    // payload must carry the coverage that tells the UI not to show it.
    expect(report!.valuationCoverage).toEqual({
      complete: false,
      unvaluedAccountCount: 1,
      gaps: [EUR_GAP],
    });
  });

  it('is unchanged for a fully valued budget', async () => {
    setupBudget();
    mockBuildContext.mockResolvedValue({
      reportCurrencyGuid: 'usd',
      reportCurrencyMnemonic: 'USD',
      getMultiplier: () => 1,
      isConvertible: () => true,
      gaps: [],
      warnings: [],
    });

    const report = await generateBudgetBalanceSheet(
      'book', ['checking-eur', 'equity'], 'budget', 0,
    );

    expect(report!.totals.check.actual).toBeCloseTo(0, 2);
    expect(report!.valuationCoverage).toEqual({
      complete: true,
      unvaluedAccountCount: 0,
      gaps: [],
    });
  });
});
