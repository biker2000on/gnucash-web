import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------
const mockSplitsFindUnique = vi.fn();
const mockSplitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    splits: {
      findUnique: (...args: unknown[]) => mockSplitsFindUnique(...args),
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
    },
  },
}));

import { traceCostBasis, createCostBasisCache, isTransferIn, type CostBasisMethod } from '../cost-basis';

// --- Fixture builders -------------------------------------------------------

const AAPL = 'commodity-aapl';
const USD = 'commodity-usd';
const SRC = 'acct-source';
const DEST = 'acct-dest';
const TRANSFER_TX = 'tx-transfer';

function frac(n: number) {
  // 4 decimal places is enough for whole shares / cent-precision dollars
  return { num: BigInt(Math.round(n * 10_000)), denom: 10_000n };
}

/** A stock-side split in the SOURCE account, with its cash counter-split. */
function tradeSplit(opts: {
  guid: string;
  txGuid: string;
  postDate: string;
  shares: number;
  value: number;
}) {
  const q = frac(opts.shares);
  const v = frac(opts.value);
  const stock = {
    guid: opts.guid,
    tx_guid: opts.txGuid,
    account_guid: SRC,
    lot_guid: null,
    quantity_num: q.num,
    quantity_denom: q.denom,
    value_num: v.num,
    value_denom: v.denom,
    account: { guid: SRC, name: 'Source Brokerage', commodity_guid: AAPL, account_type: 'STOCK' },
  };
  // Cash leg: different commodity, so isTransferInSplit must NOT match it.
  const cash = {
    guid: `${opts.guid}-cash`,
    tx_guid: opts.txGuid,
    account_guid: 'acct-cash',
    lot_guid: null,
    quantity_num: frac(-opts.value).num,
    quantity_denom: frac(-opts.value).denom,
    value_num: frac(-opts.value).num,
    value_denom: frac(-opts.value).denom,
    account: { guid: 'acct-cash', name: 'Cash', commodity_guid: USD, account_type: 'BANK' },
  };
  return {
    ...stock,
    transaction: {
      post_date: new Date(`${opts.postDate}T12:00:00.000Z`),
      description: 'trade',
      splits: [stock, cash],
    },
  };
}

/** The transfer-out leg sitting in the SOURCE account (same tx as the trace target). */
function transferOutSplit(postDate: string, shares: number) {
  const q = frac(-shares);
  return {
    guid: 'split-transfer-out',
    tx_guid: TRANSFER_TX,
    account_guid: SRC,
    lot_guid: null,
    quantity_num: q.num,
    quantity_denom: q.denom,
    value_num: 0n,
    value_denom: 1n,
    account: { guid: SRC, name: 'Source Brokerage', commodity_guid: AAPL, account_type: 'STOCK' },
    transaction: {
      post_date: new Date(`${postDate}T12:00:00.000Z`),
      description: 'transfer out',
      splits: [],
    },
  };
}

/** What splits.findUnique returns for the transfer-IN split being traced. */
function transferInRow(postDate: string, shares: number) {
  const inQ = frac(shares);
  const outQ = frac(-shares);
  const inSplit = {
    guid: 'split-transfer-in',
    account_guid: DEST,
    quantity_num: inQ.num,
    quantity_denom: inQ.denom,
    value_num: 0n,
    value_denom: 1n,
    account: { guid: DEST, name: 'Destination Brokerage', commodity_guid: AAPL, account_type: 'STOCK' },
  };
  const outSplit = {
    guid: 'split-transfer-out',
    account_guid: SRC,
    quantity_num: outQ.num,
    quantity_denom: outQ.denom,
    value_num: 0n,
    value_denom: 1n,
    account: { guid: SRC, name: 'Source Brokerage', commodity_guid: AAPL, account_type: 'STOCK' },
  };
  return {
    guid: 'split-transfer-in',
    tx_guid: TRANSFER_TX,
    account_guid: DEST,
    lot_guid: null,
    quantity_num: inQ.num,
    quantity_denom: inQ.denom,
    value_num: 0n,
    value_denom: 1n,
    transaction: {
      guid: TRANSFER_TX,
      post_date: new Date(`${postDate}T12:00:00.000Z`),
      splits: [inSplit, outSplit],
    },
  };
}

/**
 * Trace the basis of `transferredShares` moved out of the source account,
 * given the source account's trade history.
 */
async function trace(
  method: CostBasisMethod,
  sourceSplits: ReturnType<typeof tradeSplit>[],
  transferredShares: number,
) {
  mockSplitsFindUnique.mockResolvedValue(transferInRow('2025-01-01', transferredShares));
  mockSplitsFindMany.mockResolvedValue([
    ...sourceSplits,
    // The transfer itself lives in the source account too; it must be excluded
    // from the replay or it consumes the very shares being traced.
    transferOutSplit('2025-01-01', transferredShares),
  ]);
  return traceCostBasis('split-transfer-in', method, AAPL, transferredShares, createCostBasisCache());
}

// 2020: 100 shares at $10 = $1,000. 2023: 100 shares at $50 = $5,000.
const BUY_2020 = () => tradeSplit({ guid: 'buy-2020', txGuid: 'tx-buy-2020', postDate: '2020-01-01', shares: 100, value: 1_000 });
const BUY_2023 = () => tradeSplit({ guid: 'buy-2023', txGuid: 'tx-buy-2023', postDate: '2023-01-01', shares: 100, value: 5_000 });
const sell2024 = (shares: number, proceeds: number) =>
  tradeSplit({ guid: 'sell-2024', txGuid: 'tx-sell-2024', postDate: '2024-01-01', shares: -shares, value: -proceeds });

beforeEach(() => {
  mockSplitsFindUnique.mockReset();
  mockSplitsFindMany.mockReset();
});

describe('traceCostBasis — lot consumption order', () => {
  // Worked example from the audit: buy 100 @ $10 (2020), buy 100 @ $50 (2023),
  // sell 100 (2024). The 100 remaining shares are the OTHER lot under each
  // method — before the fix LIFO returned $5,000, the FIFO answer, because the
  // replay ran newest-first so the 2024 sale saw no prior purchases at all.
  const history = () => [BUY_2020(), BUY_2023(), sell2024(100, 4_000)];

  it('FIFO sells the 2020 lot, leaving the $50 shares ($5,000)', async () => {
    const r = await trace('fifo', history(), 100);
    expect(r.totalCost).toBeCloseTo(5_000, 6);
    expect(r.perShareCost).toBeCloseTo(50, 6);
    expect(r.method).toBe('fifo');
  });

  it('LIFO sells the 2023 lot, leaving the $10 shares ($1,000)', async () => {
    const r = await trace('lifo', history(), 100);
    expect(r.totalCost).toBeCloseTo(1_000, 6);
    expect(r.perShareCost).toBeCloseTo(10, 6);
    expect(r.method).toBe('lifo');
  });

  it('FIFO and LIFO disagree — the regression was LIFO silently returning the FIFO answer', async () => {
    const fifo = await trace('fifo', history(), 100);
    const lifo = await trace('lifo', history(), 100);
    expect(lifo.totalCost).not.toBeCloseTo(fifo.totalCost, 2);
  });

  it('average blends both lots ($30/share)', async () => {
    const r = await trace('average', history(), 100);
    // 200 shares / $6,000 -> $30 avg; selling 100 leaves $3,000 of basis.
    expect(r.perShareCost).toBeCloseTo(30, 6);
    expect(r.totalCost).toBeCloseTo(3_000, 6);
    expect(r.method).toBe('average');
  });

  it('names the account the basis was traced from', async () => {
    const r = await trace('fifo', history(), 100);
    expect(r.tracedFromAccount).toBe('Source Brokerage');
  });
});

describe('traceCostBasis — partial sale spanning two lots', () => {
  // Sell 150 of 200 shares, then trace the remaining 50.
  const history = () => [BUY_2020(), BUY_2023(), sell2024(150, 6_000)];

  it('FIFO leaves 50 shares of the $50 lot ($2,500)', async () => {
    const r = await trace('fifo', history(), 50);
    expect(r.totalCost).toBeCloseTo(2_500, 6);
    expect(r.perShareCost).toBeCloseTo(50, 6);
  });

  it('LIFO leaves 50 shares of the $10 lot ($500)', async () => {
    const r = await trace('lifo', history(), 50);
    expect(r.totalCost).toBeCloseTo(500, 6);
    expect(r.perShareCost).toBeCloseTo(10, 6);
  });

  it('average leaves 50 shares at the $30 blended cost ($1,500)', async () => {
    const r = await trace('average', history(), 50);
    expect(r.totalCost).toBeCloseTo(1_500, 6);
  });
});

describe('traceCostBasis — no sales', () => {
  it('FIFO takes the oldest shares and LIFO the newest', async () => {
    const history = () => [BUY_2020(), BUY_2023()];
    expect((await trace('fifo', history(), 100)).totalCost).toBeCloseTo(1_000, 6);
    expect((await trace('lifo', history(), 100)).totalCost).toBeCloseTo(5_000, 6);
    // Taking everything is method-independent.
    expect((await trace('fifo', history(), 200)).totalCost).toBeCloseTo(6_000, 6);
    expect((await trace('lifo', history(), 200)).totalCost).toBeCloseTo(6_000, 6);
  });

  it('returns zero basis when no traceable source exists', async () => {
    // Transfer-in with no matching same-commodity send leg (gift / airdrop).
    const row = transferInRow('2025-01-01', 100);
    row.transaction.splits = [row.transaction.splits[0]];
    mockSplitsFindUnique.mockResolvedValue(row);
    mockSplitsFindMany.mockResolvedValue([]);
    const r = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 100, createCostBasisCache());
    expect(r.totalCost).toBe(0);
    expect(r.perShareCost).toBe(0);
  });
});

describe('isTransferIn', () => {
  const received = { quantity_num: 100n, quantity_denom: 1n, value_num: 0n, value_denom: 1n, account_guid: DEST };

  it('matches a same-commodity send from another account', () => {
    expect(isTransferIn(received, [
      received,
      { quantity_num: -100n, quantity_denom: 1n, account_guid: SRC, account: { commodity_guid: AAPL, account_type: 'STOCK' } },
    ], AAPL)).toBe(true);
  });

  it('ignores the cash leg of a plain purchase', () => {
    expect(isTransferIn(received, [
      received,
      { quantity_num: -1_000n, quantity_denom: 1n, account_guid: 'acct-cash', account: { commodity_guid: USD, account_type: 'BANK' } },
    ], AAPL)).toBe(false);
  });

  it('ignores GnuCash TRADING account legs', () => {
    expect(isTransferIn(received, [
      received,
      { quantity_num: -100n, quantity_denom: 1n, account_guid: 'acct-trading', account: { commodity_guid: AAPL, account_type: 'TRADING' } },
    ], AAPL)).toBe(false);
  });
});
