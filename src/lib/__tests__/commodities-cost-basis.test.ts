/**
 * Coverage preservation in the holdings aggregate.
 *
 * traceCostBasis returns basis for only the shares whose basis it could
 * establish. getAccountHoldings must keep that share count next to the basis:
 * adding a partial basis while counting every share understates the basis of
 * the whole holding (the H4 defect, one level up from the trace).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindUnique = vi.fn();
const mockSplitsFindMany = vi.fn();
const mockPricesFindFirst = vi.fn();
const mockTraceCostBasis = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: { findUnique: (...args: unknown[]) => mockAccountsFindUnique(...args) },
    splits: { findMany: (...args: unknown[]) => mockSplitsFindMany(...args) },
    prices: { findFirst: (...args: unknown[]) => mockPricesFindFirst(...args) },
  },
}));

// Only the trace is stubbed — the pool helpers under test are the real ones.
vi.mock('../cost-basis', async (importActual) => {
  const actual = await importActual<typeof import('../cost-basis')>();
  return {
    ...actual,
    traceCostBasis: (...args: unknown[]) => mockTraceCostBasis(...args),
  };
});

import { getAccountHoldings } from '../commodities';

const AAPL = 'commodity-aapl';
const USD = 'commodity-usd';
const ACCT = 'acct-holding';
const OTHER = 'acct-other-brokerage';

function frac(n: number) {
  return { num: BigInt(Math.round(n * 10_000)), denom: 10_000n };
}

function row(o: {
  guid: string; txGuid: string; postDate: string; shares: number; value: number;
  counterAccount: string; counterCommodity: string; counterType: string;
}) {
  const q = frac(o.shares);
  const v = frac(o.value);
  const self = {
    guid: o.guid, tx_guid: o.txGuid, account_guid: ACCT, lot_guid: null,
    quantity_num: q.num, quantity_denom: q.denom, value_num: v.num, value_denom: v.denom,
    account: { guid: ACCT, commodity_guid: AAPL, account_type: 'STOCK' },
  };
  const counterQty = frac(o.counterCommodity === USD ? -o.value : -o.shares);
  const counter = {
    guid: `${o.guid}-counter`, tx_guid: o.txGuid, account_guid: o.counterAccount, lot_guid: null,
    quantity_num: counterQty.num, quantity_denom: counterQty.denom,
    value_num: frac(-o.value).num, value_denom: frac(-o.value).denom,
    account: { guid: o.counterAccount, commodity_guid: o.counterCommodity, account_type: o.counterType },
  };
  return {
    ...self,
    transaction: { post_date: new Date(`${o.postDate}T12:00:00.000Z`), splits: [self, counter] },
  };
}

const buy = (o: { guid: string; postDate: string; shares: number; value: number }) =>
  row({ ...o, txGuid: `tx-${o.guid}`, counterAccount: 'acct-cash', counterCommodity: USD, counterType: 'BANK' });

const transferIn = (o: { guid: string; postDate: string; shares: number }) =>
  row({ ...o, txGuid: `tx-${o.guid}`, value: 0, counterAccount: OTHER, counterCommodity: AAPL, counterType: 'STOCK' });

const sell = (o: { guid: string; postDate: string; shares: number; proceeds: number }) =>
  row({
    guid: o.guid, txGuid: `tx-${o.guid}`, postDate: o.postDate, shares: -o.shares, value: -o.proceeds,
    counterAccount: 'acct-cash', counterCommodity: USD, counterType: 'BANK',
  });

beforeEach(() => {
  mockAccountsFindUnique.mockReset();
  mockSplitsFindMany.mockReset();
  mockPricesFindFirst.mockReset();
  mockTraceCostBasis.mockReset();
  mockAccountsFindUnique.mockResolvedValue({
    guid: ACCT, commodity_guid: AAPL, commodity: { guid: AAPL, mnemonic: 'AAPL' },
  });
  mockPricesFindFirst.mockResolvedValue(null);
});

describe('getAccountHoldings — cost-basis coverage', () => {
  /**
   * 100 shares bought at $10 plus a 100-share transfer-in that traces to only
   * HALF a basis: 50 covered shares worth $2,500 ($50/share), 50 with no basis.
   */
  function partiallyTracedHolding(extra: ReturnType<typeof buy>[] = []) {
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
      transferIn({ guid: 'xfer-1', postDate: '2021-01-01', shares: 100 }),
      ...extra,
    ]);
    mockTraceCostBasis.mockResolvedValue({
      coveredShares: 50,
      uncoveredShares: 50,
      basisOfCoveredShares: 2_500,
      perShareCost: 50,
      method: 'fifo',
      warnings: ['50 of 100 share(s) transferred in on 2021-01-01 have no traceable cost basis in this book.'],
    });
  }

  it('reports the traced basis against the shares it actually covers', async () => {
    partiallyTracedHolding();
    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.shares).toBeCloseTo(200, 6);
    expect(h.costBasis).toBeCloseTo(3_500, 6);          // $1,000 bought + $2,500 traced
    // Narrowing is forced before any share count can be read: there is no
    // `uncoveredShares` to reach on a `complete` or `unknown` coverage, so no
    // consumer can Number()-coerce a missing one into "0 uncovered".
    expect(h.costBasisCoverage.status).toBe('partial');
    if (h.costBasisCoverage.status !== 'partial') throw new Error('expected partial coverage');
    expect(h.costBasisCoverage.coveredShares).toBeCloseTo(150, 6); // 100 bought + 50 traced
    expect(h.costBasisCoverage.uncoveredShares).toBeCloseTo(50, 6);
    // The honest per-share basis is over the COVERED shares ($23.33), not over
    // all 200 shares ($17.50), which is what absorbing the uncovered shares
    // into the pool would report.
    expect(h.costBasis / h.costBasisCoverage.coveredShares).toBeCloseTo(23.3333333, 5);
    expect(h.costBasisCoverage.warnings).toHaveLength(1);
    expect(h.costBasisCoverage.warnings[0]).toContain('no traceable cost basis');
  });

  it('a sale consumes covered and uncovered shares pro rata', async () => {
    partiallyTracedHolding([sell({ guid: 'sell-1', postDate: '2024-01-01', shares: 100, proceeds: 8_000 })]);
    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.shares).toBeCloseTo(100, 6);
    // 100 of 200 shares sold: 75 covered (150/200) and 25 uncovered.
    if (h.costBasisCoverage.status !== 'partial') throw new Error('expected partial coverage');
    expect(h.costBasisCoverage.coveredShares).toBeCloseTo(75, 6);
    expect(h.costBasisCoverage.uncoveredShares).toBeCloseTo(25, 6);
    expect(h.costBasis).toBeCloseTo(1_750, 6);
    expect(h.costBasis / h.costBasisCoverage.coveredShares).toBeCloseTo(23.3333333, 5);
  });

  it('a fully traceable holding reports no uncovered shares', async () => {
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
      transferIn({ guid: 'xfer-1', postDate: '2021-01-01', shares: 100 }),
    ]);
    mockTraceCostBasis.mockResolvedValue({
      coveredShares: 100, uncoveredShares: 0, basisOfCoveredShares: 5_000,
      perShareCost: 50, method: 'fifo',
    });

    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });
    expect(h.costBasis).toBeCloseTo(6_000, 6);
    // Complete: the basis describes all 200 shares, so there is no uncovered
    // count to carry and no caveat for a consumer to render.
    expect(h.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 200 });
  });

  it('without carry-over tracing coverage is UNKNOWN, not complete', async () => {
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
    ]);
    const h = await getAccountHoldings(ACCT);

    // The basis this path can compute is still reported in full.
    expect(h.costBasis).toBeCloseTo(1_000, 6);
    expect(mockTraceCostBasis).not.toHaveBeenCalled();
    // But it does no transfer-in detection at all, so an in-kind transfer would
    // enter at its $0 split value: claiming "100 covered, 0 uncovered" would
    // assert a completeness this branch never established. The ledger route
    // declines the same claim for the same toggle.
    expect(h.costBasisCoverage.status).toBe('unknown');
  });

  it('an oversell is reported as a SHORT position, basis = proceeds', async () => {
    // Buy 100 @ $10, sell 150 @ $80. 100 close the long; 50 are sold short, and
    // their slice of the $12,000 is $4,000. The old pool clamped at zero shares,
    // drained the basis to ~0, and could say nothing about coverage.
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
      sell({ guid: 'sell-1', postDate: '2024-01-01', shares: 150, proceeds: 12_000 }),
    ]);
    mockPricesFindFirst.mockResolvedValue({
      guid: 'price-1', date: new Date('2024-06-01T12:00:00.000Z'),
      value_num: 6_000n, value_denom: 100n, source: 'user:price',
    });

    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.shares).toBeCloseTo(-50, 6); // the share balance stays honest
    expect(h.positionSide).toBe('short');
    expect(h.costBasis).toBeCloseTo(4_000, 6);
    expect(h.shortProceeds).toBeCloseTo(4_000, 6);
    // Every short-opening sale's proceeds were readable, so this IS covered.
    expect(h.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 50 });
    // Short gain = proceeds - cover cost at $60 x 50 = 4,000 - 3,000 = +1,000.
    // The long subtraction would have returned -7,000 here.
    expect(h.gainLoss).toBeCloseTo(1_000, 6);
  });

  it('a short position that outruns its price loses money as the price rises', async () => {
    mockSplitsFindMany.mockResolvedValue([
      sell({ guid: 'short-1', postDate: '2024-01-01', shares: 100, proceeds: 5_000 }),
    ]);
    mockPricesFindFirst.mockResolvedValue({
      guid: 'price-1', date: new Date('2024-06-01T12:00:00.000Z'),
      value_num: 7_000n, value_denom: 100n, source: 'user:price',
    });

    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.positionSide).toBe('short');
    expect(h.costBasis).toBeCloseTo(5_000, 6);
    expect(h.gainLoss).toBeCloseTo(-2_000, 6); // 5,000 - 100 x 70
  });

  it('a long holding still reports positionSide long and an unchanged basis', async () => {
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
      sell({ guid: 'sell-1', postDate: '2024-01-01', shares: 40, proceeds: 3_200 }),
    ]);
    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.positionSide).toBe('long');
    expect(h.shortProceeds).toBe(0);
    expect(h.shares).toBeCloseTo(60, 6);
    expect(h.costBasis).toBeCloseTo(600, 6);
    expect(h.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 60 });
  });

  /**
   * The share balance and the pool's share count are two independent float
   * sums over the same history, and each pro-rata sale injects a fresh
   * relative rounding error. After thousands of sales on a multi-million-unit
   * position at commodity_scu 1e8 the two disagree by far more than that
   * scu's absolute epsilon (0.5/1e8) with nothing actually wrong. Comparing
   * them against an absolute bound reports a healthy account's coverage as
   * unknown; the magnitude-scaled epsilon does not.
   */
  it('keeps coverage reportable after a long large-share replay accumulates float residue', async () => {
    mockAccountsFindUnique.mockResolvedValue({
      guid: ACCT, commodity_guid: AAPL, commodity_scu: 100_000_000,
      commodity: { guid: AAPL, mnemonic: 'BTC' },
    });
    mockTraceCostBasis.mockResolvedValue({
      coveredShares: 700.13, uncoveredShares: 299.87,
      basisOfCoveredShares: 21_003.9, perShareCost: 30, method: 'fifo',
    });

    const day = (i: number) => new Date(Date.UTC(2000, 0, 1) + i * 86_400_000)
      .toISOString().slice(0, 10);
    // A partly-traceable transfer-in first, so every later sale has a
    // non-trivial covered/uncovered ratio to split pro rata.
    const history: ReturnType<typeof buy>[] = [
      transferIn({ guid: 'xfer-0', postDate: day(0), shares: 1_000 }),
    ];
    for (let i = 1; i < 6_000; i++) {
      history.push(i % 3 === 2
        ? sell({ guid: `s-${i}`, postDate: day(i), shares: 4_100.37, proceeds: 8_200.74 })
        : buy({ guid: `b-${i}`, postDate: day(i), shares: 12_301.11, value: 24_602.22 }));
    }
    mockSplitsFindMany.mockResolvedValue(history);

    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.shares).toBeGreaterThan(1_000_000);
    // The point of the test: a coverage statement, not 'unknown'.
    expect(h.costBasisCoverage.status).toBe('partial');
  });
});
