/**
 * The balance-sheet check must be a real control, not decoration.
 *
 * GnuCash books are open: income and expense accounts are never closed into
 * equity, so their cumulative balances sit on the other side of asset and
 * liability postings. A check computed as Assets − Liabilities − Equity while
 * ignoring them is non-zero by construction on a perfectly healthy book, which
 * teaches readers to dismiss the number — and a genuine imbalance with it.
 *
 * These tests pin BOTH directions. The second is the load-bearing one: the fix
 * must reach zero by accounting for retained earnings, not by suppressing the
 * signal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockAccountsFindFirst = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    accounts: {
      findMany: (...a: unknown[]) => mockAccountsFindMany(...a),
      findFirst: (...a: unknown[]) => mockAccountsFindFirst(...a),
    },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}));

vi.mock('@/lib/account-valuation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-valuation')>();
  return {
    ...actual,
    // Every balance is a plain USD currency balance in these fixtures, so the
    // valuation layer is a no-op and the coverage helper stays the real one.
    buildAccountValuationContext: vi.fn(async () => ({
      reportCurrencyGuid: 'usd',
      reportCurrencyMnemonic: 'USD',
      getMultiplier: () => 1,
      isConvertible: () => true,
      gaps: [],
      warnings: [],
    })),
  };
});

import { generateBalanceSheet } from '@/lib/reports/balance-sheet';

const FILTERS = { startDate: null, endDate: '2026-06-30' };

function acct(guid: string, name: string, type: string, parent: string | null = 'root') {
  return {
    guid,
    name,
    account_type: type,
    parent_guid: parent,
    commodity_guid: 'usd',
    commodity: { namespace: 'CURRENCY' },
  };
}

/** Raw, debit-positive balance row as returned by sumSplitsByAccount's query. */
function sumRow(guid: string, raw: number) {
  return { account_guid: guid, quantity_sum: raw, value_sum: raw };
}

/**
 * An open book with real income and expense activity.
 *
 *   Checking (BANK)          +1,500   debit
 *   Opening Balances (EQUITY)−1,000   credit
 *   Salary (INCOME)          −  800   credit
 *   Rent (EXPENSE)           +  300   debit
 *                            ───────
 *                                  0  every split balances
 */
const OPEN_BOOK_ACCOUNTS = [
  acct('checking', 'Checking', 'BANK'),
  acct('equity', 'Opening Balances', 'EQUITY'),
  acct('salary', 'Salary', 'INCOME'),
  acct('rent', 'Rent', 'EXPENSE'),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAccountsFindFirst.mockResolvedValue({ guid: 'root' });
});

describe('generateBalanceSheet on an OPEN book with income/expense activity', () => {
  beforeEach(() => {
    mockAccountsFindMany.mockResolvedValue(OPEN_BOOK_ACCOUNTS);
    mockQueryRaw.mockResolvedValue([
      sumRow('checking', 1_500),
      sumRow('equity', -1_000),
      sumRow('salary', -800),
      sumRow('rent', 300),
    ]);
  });

  it('reports a balance check of EXACTLY zero', async () => {
    const report = await generateBalanceSheet(FILTERS);

    // Not "close to zero" -- the identity is exact, because every split in
    // every transaction sums to zero and all of them are now accounted for.
    expect(report.grandTotal).toBeCloseTo(0, 10);
  });

  it('surfaces retained earnings as a visible equity row, not a hidden fudge', async () => {
    const report = await generateBalanceSheet(FILTERS);

    const equity = report.sections.find(s => s.title === 'Equity')!;
    const retained = equity.items.find(i => i.name.startsWith('Retained earnings'))!;

    // income 800 − expenses 300 = 500 profit, displayed credit-normal.
    expect(retained).toBeDefined();
    expect(retained.amount).toBeCloseTo(500, 6);

    // Opening balances 1,000 + retained 500.
    expect(equity.total).toBeCloseTo(1_500, 6);

    // The section still adds up from its own rows.
    const itemSum = equity.items.reduce((sum, i) => sum + i.amount, 0);
    expect(equity.total).toBeCloseTo(itemSum, 10);
  });

  it('does not render income or expense accounts as balance-sheet sections', async () => {
    const report = await generateBalanceSheet(FILTERS);

    expect(report.sections.map(s => s.title)).toEqual(['Assets', 'Liabilities', 'Equity']);

    const allGuids = report.sections.flatMap(s => s.items.map(i => i.guid));
    expect(allGuids).not.toContain('salary');
    expect(allGuids).not.toContain('rent');
  });

  it('keeps the assets side untouched', async () => {
    const report = await generateBalanceSheet(FILTERS);
    expect(report.sections.find(s => s.title === 'Assets')!.total).toBeCloseTo(1_500, 6);
  });
});

describe('generateBalanceSheet with a GENUINE injected imbalance', () => {
  /**
   * This is the test that proves the fix did not simply mute the check.
   *
   * Same book, but the Rent expense is posted at 200 while the cash side still
   * moved 300 -- an unbalanced transaction. Raw splits now sum to −100 instead
   * of 0, and the check must say so.
   */
  beforeEach(() => {
    mockAccountsFindMany.mockResolvedValue(OPEN_BOOK_ACCOUNTS);
    mockQueryRaw.mockResolvedValue([
      sumRow('checking', 1_500),
      sumRow('equity', -1_000),
      sumRow('salary', -800),
      sumRow('rent', 200), // 100 short of the cash that left
    ]);
  });

  it('still reports a non-zero check', async () => {
    const report = await generateBalanceSheet(FILTERS);

    expect(report.grandTotal).toBeDefined();
    expect(report.grandTotal).not.toBeCloseTo(0, 2);
  });

  it('reports the check equal to the size and direction of the imbalance', async () => {
    const report = await generateBalanceSheet(FILTERS);

    // Assets 1,500 − Liabilities 0 − Equity (1,000 + 600 retained) = −100,
    // exactly the amount by which the ledger fails to balance.
    expect(report.grandTotal).toBeCloseTo(-100, 6);
  });

  it('does not withhold the check -- the book is fully valued', async () => {
    const report = await generateBalanceSheet(FILTERS);

    // Withholding is reserved for unvaluable balances. A real imbalance must
    // be published, not suppressed as "unassessable".
    expect(report.valuationCoverage).toEqual({
      complete: true,
      unvaluedAccountCount: 0,
      gaps: [],
    });
  });
});

describe('generateBalanceSheet on a book with no income/expense activity', () => {
  it('omits the retained-earnings row entirely', async () => {
    mockAccountsFindMany.mockResolvedValue([
      acct('checking', 'Checking', 'BANK'),
      acct('equity', 'Opening Balances', 'EQUITY'),
    ]);
    mockQueryRaw.mockResolvedValue([
      sumRow('checking', 1_000),
      sumRow('equity', -1_000),
    ]);

    const report = await generateBalanceSheet(FILTERS);

    const equity = report.sections.find(s => s.title === 'Equity')!;
    expect(equity.items.some(i => i.name.startsWith('Retained earnings'))).toBe(false);
    expect(equity.total).toBeCloseTo(1_000, 6);
    expect(report.grandTotal).toBeCloseTo(0, 10);
  });
});
