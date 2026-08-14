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
    expect(h.costBasisCoveredShares).toBeCloseTo(150, 6); // 100 bought + 50 traced
    expect(h.costBasisUncoveredShares).toBeCloseTo(50, 6);
    // The honest per-share basis is over the COVERED shares ($23.33), not over
    // all 200 shares ($17.50), which is what absorbing the uncovered shares
    // into the pool would report.
    expect(h.costBasis / h.costBasisCoveredShares).toBeCloseTo(23.3333333, 5);
    expect(h.costBasisWarnings).toHaveLength(1);
    expect(h.costBasisWarnings[0]).toContain('no traceable cost basis');
  });

  it('a sale consumes covered and uncovered shares pro rata', async () => {
    partiallyTracedHolding([sell({ guid: 'sell-1', postDate: '2024-01-01', shares: 100, proceeds: 8_000 })]);
    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.shares).toBeCloseTo(100, 6);
    // 100 of 200 shares sold: 75 covered (150/200) and 25 uncovered.
    expect(h.costBasisCoveredShares).toBeCloseTo(75, 6);
    expect(h.costBasisUncoveredShares).toBeCloseTo(25, 6);
    expect(h.costBasis).toBeCloseTo(1_750, 6);
    expect(h.costBasis / h.costBasisCoveredShares).toBeCloseTo(23.3333333, 5);
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
    expect(h.costBasisCoveredShares).toBeCloseTo(200, 6);
    expect(h.costBasisUncoveredShares).toBeCloseTo(0, 6);
    expect(h.costBasisWarnings).toEqual([]);
  });

  it('without carry-over tracing every share is covered by its own split value', async () => {
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
    ]);
    const h = await getAccountHoldings(ACCT);
    expect(h.costBasis).toBeCloseTo(1_000, 6);
    expect(h.costBasisCoveredShares).toBeCloseTo(100, 6);
    expect(h.costBasisUncoveredShares).toBe(0);
    expect(mockTraceCostBasis).not.toHaveBeenCalled();
  });
});
