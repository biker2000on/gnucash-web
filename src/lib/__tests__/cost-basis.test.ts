import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------
const mockSplitsFindUnique = vi.fn();
const mockSplitsFindMany = vi.fn();
const mockSlotsFindFirst = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    splits: {
      findUnique: (...args: unknown[]) => mockSplitsFindUnique(...args),
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
    },
    slots: {
      findFirst: (...args: unknown[]) => mockSlotsFindFirst(...args),
    },
  },
}));

import { traceCostBasis, createCostBasisCache, isTransferIn, MAX_TRACE_DEPTH, type CostBasisMethod } from '../cost-basis';

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
  mockSlotsFindFirst.mockReset();
  mockSlotsFindFirst.mockResolvedValue(null);
});

describe('traceCostBasis — lot consumption order', () => {
  // Worked example from the audit: buy 100 @ $10 (2020), buy 100 @ $50 (2023),
  // sell 100 (2024). The 100 remaining shares are the OTHER lot under each
  // method — before the fix LIFO returned $5,000, the FIFO answer, because the
  // replay ran newest-first so the 2024 sale saw no prior purchases at all.
  const history = () => [BUY_2020(), BUY_2023(), sell2024(100, 4_000)];

  it('FIFO sells the 2020 lot, leaving the $50 shares ($5,000)', async () => {
    const r = await trace('fifo', history(), 100);
    expect(r.basisOfCoveredShares).toBeCloseTo(5_000, 6);
    expect(r.perShareCost).toBeCloseTo(50, 6);
    expect(r.method).toBe('fifo');
  });

  it('LIFO sells the 2023 lot, leaving the $10 shares ($1,000)', async () => {
    const r = await trace('lifo', history(), 100);
    expect(r.basisOfCoveredShares).toBeCloseTo(1_000, 6);
    expect(r.perShareCost).toBeCloseTo(10, 6);
    expect(r.method).toBe('lifo');
  });

  it('FIFO and LIFO disagree — the regression was LIFO silently returning the FIFO answer', async () => {
    const fifo = await trace('fifo', history(), 100);
    const lifo = await trace('lifo', history(), 100);
    expect(lifo.basisOfCoveredShares).not.toBeCloseTo(fifo.basisOfCoveredShares, 2);
  });

  it('average blends both lots ($30/share)', async () => {
    const r = await trace('average', history(), 100);
    // 200 shares / $6,000 -> $30 avg; selling 100 leaves $3,000 of basis.
    expect(r.perShareCost).toBeCloseTo(30, 6);
    expect(r.basisOfCoveredShares).toBeCloseTo(3_000, 6);
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
    expect(r.basisOfCoveredShares).toBeCloseTo(2_500, 6);
    expect(r.perShareCost).toBeCloseTo(50, 6);
  });

  it('LIFO leaves 50 shares of the $10 lot ($500)', async () => {
    const r = await trace('lifo', history(), 50);
    expect(r.basisOfCoveredShares).toBeCloseTo(500, 6);
    expect(r.perShareCost).toBeCloseTo(10, 6);
  });

  it('average leaves 50 shares at the $30 blended cost ($1,500)', async () => {
    const r = await trace('average', history(), 50);
    expect(r.basisOfCoveredShares).toBeCloseTo(1_500, 6);
  });
});

describe('traceCostBasis — no sales', () => {
  it('FIFO takes the oldest shares and LIFO the newest', async () => {
    const history = () => [BUY_2020(), BUY_2023()];
    expect((await trace('fifo', history(), 100)).basisOfCoveredShares).toBeCloseTo(1_000, 6);
    expect((await trace('lifo', history(), 100)).basisOfCoveredShares).toBeCloseTo(5_000, 6);
    // Taking everything is method-independent.
    expect((await trace('fifo', history(), 200)).basisOfCoveredShares).toBeCloseTo(6_000, 6);
    expect((await trace('lifo', history(), 200)).basisOfCoveredShares).toBeCloseTo(6_000, 6);
  });

  it('returns zero basis when no traceable source exists', async () => {
    // Transfer-in with no matching same-commodity send leg (gift / airdrop).
    const row = transferInRow('2025-01-01', 100);
    row.transaction.splits = [row.transaction.splits[0]];
    mockSplitsFindUnique.mockResolvedValue(row);
    mockSplitsFindMany.mockResolvedValue([]);
    const r = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 100, createCostBasisCache());
    expect(r.basisOfCoveredShares).toBe(0);
    expect(r.perShareCost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H4: transferred-in shares must enter the pool at their CARRIED basis, not $0
// ---------------------------------------------------------------------------

const UP = 'acct-upstream';
const CASH = 'acct-cash';
const XFER_UP_SRC = 'tx-xfer-up-src';

const ACCOUNT_NAMES: Record<string, string> = {
  [UP]: 'Upstream Brokerage',
  [SRC]: 'Source Brokerage',
  [DEST]: 'Destination Brokerage',
  [CASH]: 'Cash',
};

function acct(guid: string, commodity = AAPL, accountType = 'STOCK') {
  return { guid, name: ACCOUNT_NAMES[guid] ?? guid, commodity_guid: commodity, account_type: accountType };
}

/**
 * A two-leg transaction, returned as its stock-side split row (the shape both
 * `splits.findUnique` and `splits.findMany` produce, transaction legs included).
 */
function txSplit(o: {
  guid: string;
  txGuid: string;
  postDate: string;
  account: string;
  shares: number;
  value: number;
  lotGuid?: string;
  counterAccount: string;
  counterCommodity?: string;
  counterType?: string;
}) {
  const q = frac(o.shares);
  const v = frac(o.value);
  const self = {
    guid: o.guid,
    tx_guid: o.txGuid,
    account_guid: o.account,
    lot_guid: o.lotGuid ?? null,
    quantity_num: q.num,
    quantity_denom: q.denom,
    value_num: v.num,
    value_denom: v.denom,
    account: acct(o.account),
  };
  // Cash legs move dollars; same-commodity legs move the opposite share count.
  const counterQty = o.counterCommodity === USD ? -o.value : -o.shares;
  const cq = frac(counterQty);
  const cv = frac(-o.value);
  const counter = {
    guid: `${o.guid}-counter`,
    tx_guid: o.txGuid,
    account_guid: o.counterAccount,
    lot_guid: null,
    quantity_num: cq.num,
    quantity_denom: cq.denom,
    value_num: cv.num,
    value_denom: cv.denom,
    account: acct(o.counterAccount, o.counterCommodity ?? AAPL, o.counterType ?? 'STOCK'),
  };
  return {
    ...self,
    transaction: {
      guid: o.txGuid,
      post_date: new Date(`${o.postDate}T12:00:00.000Z`),
      description: o.txGuid,
      splits: [self, counter],
    },
  };
}

type Row = ReturnType<typeof txSplit>;

const buy = (o: { guid: string; account: string; postDate: string; shares: number; value: number }) =>
  txSplit({ ...o, txGuid: `tx-${o.guid}`, counterAccount: CASH, counterCommodity: USD, counterType: 'BANK' });

const sell = (o: { guid: string; account: string; postDate: string; shares: number; proceeds: number }) =>
  txSplit({
    guid: o.guid, txGuid: `tx-${o.guid}`, postDate: o.postDate, account: o.account,
    shares: -o.shares, value: -o.proceeds,
    counterAccount: CASH, counterCommodity: USD, counterType: 'BANK',
  });

/** In-kind move of `shares` from `from` to `to`; returns both legs' rows. */
function transfer(o: { txGuid: string; postDate: string; from: string; to: string; shares: number; inGuid: string; outGuid: string; inLotGuid?: string }) {
  return {
    in: txSplit({
      guid: o.inGuid, txGuid: o.txGuid, postDate: o.postDate, account: o.to,
      shares: o.shares, value: 0, lotGuid: o.inLotGuid, counterAccount: o.from,
    }),
    out: txSplit({
      guid: o.outGuid, txGuid: o.txGuid, postDate: o.postDate, account: o.from,
      shares: -o.shares, value: 0, counterAccount: o.to,
    }),
  };
}

// --- Registry-backed prisma mocks (findUnique by guid, findMany by account/lot)
const byGuid = new Map<string, Row>();
const byAccount = new Map<string, Row[]>();
const byLot = new Map<string, Row[]>();
const carriedByLot = new Map<string, string>();

function installRegistryMocks() {
  byGuid.clear(); byAccount.clear(); byLot.clear(); carriedByLot.clear();
  mockSplitsFindUnique.mockImplementation(async (args: { where: { guid: string } }) =>
    byGuid.get(args.where.guid) ?? null);
  mockSplitsFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const where = (args?.where ?? {}) as { lot_guid?: string | { in?: string[] }; account_guid?: string };
    if (where.lot_guid) {
      if (typeof where.lot_guid === 'string') return byLot.get(where.lot_guid) ?? [];
      return (where.lot_guid.in ?? []).flatMap(g => byLot.get(g) ?? []);
    }
    if (where.account_guid) return byAccount.get(where.account_guid) ?? [];
    return [];
  });
  mockSlotsFindFirst.mockImplementation(async (args: { where?: { obj_guid?: string } }) => {
    const val = carriedByLot.get(args?.where?.obj_guid ?? '');
    return val === undefined ? null : { string_val: val };
  });
}

function register(account: string, rows: Row[]) {
  byAccount.set(account, rows);
  for (const row of rows) byGuid.set(row.guid, row);
}

/**
 * A warning naming the 2021 transfer exists and carries `reason`. Warnings
 * accumulate up the chain (the leaf explains why, the parent says where), so
 * assert on presence rather than on a single message.
 */
function namesShares(warnings: string[] | undefined, reason: string): boolean {
  return (warnings ?? []).some(w => w.includes(reason) && w.includes('2021-01-01'));
}

/** The DEST-side leg of the SRC -> DEST transfer every scenario below traces. */
function srcToDest(shares: number) {
  const t = transfer({
    txGuid: TRANSFER_TX, postDate: '2025-01-01', from: SRC, to: DEST, shares,
    inGuid: 'split-transfer-in', outGuid: 'split-transfer-out',
  });
  byGuid.set(t.in.guid, t.in);
  return t;
}

describe('traceCostBasis — transferred-in shares carry their basis (H4)', () => {
  beforeEach(installRegistryMocks);

  /**
   * Upstream bought 100 @ $10 in 2020 and moved them to Source in 2021.
   * Source then bought 100 @ $50 in 2023 and moved all 200 on to Dest in 2025.
   * The 2021 transfer-in split carries $0 of value — its basis is the $1,000
   * that came with the shares.
   */
  function chainedTransferBook() {
    const upToSrc = transfer({
      txGuid: XFER_UP_SRC, postDate: '2021-01-01', from: UP, to: SRC, shares: 100,
      inGuid: 'xfer-in-src', outGuid: 'xfer-out-up',
    });
    const toDest = srcToDest(200);
    register(UP, [buy({ guid: 'buy-up', account: UP, postDate: '2020-01-01', shares: 100, value: 1_000 }), upToSrc.out]);
    register(SRC, [upToSrc.in, buy({ guid: 'buy-src', account: SRC, postDate: '2023-01-01', shares: 100, value: 5_000 }), toDest.out]);
  }

  it('average blends the transferred shares at their $1,000 carried basis, not $0', async () => {
    chainedTransferBook();
    const r = await traceCostBasis('split-transfer-in', 'average', AAPL, 200, createCostBasisCache());
    // ($1,000 carried + $5,000 bought) / 200 shares = $30/share.
    // Admitting the transferred 100 at their $0 split value gives $25/share.
    expect(r.perShareCost).toBeCloseTo(30, 6);
    expect(r.basisOfCoveredShares).toBeCloseTo(6_000, 6);
    expect(r.uncoveredShares).toBeCloseTo(0, 6);
    expect(r.warnings).toBeUndefined();
  });

  it('FIFO and LIFO already traced the transfer — they did not share the $0 defect', async () => {
    chainedTransferBook();
    const fifo = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 100, createCostBasisCache());
    expect(fifo.basisOfCoveredShares).toBeCloseTo(1_000, 6); // the 2021 transferred parcel, at carried basis
    chainedTransferBook();
    const lifo = await traceCostBasis('split-transfer-in', 'lifo', AAPL, 100, createCostBasisCache());
    expect(lifo.basisOfCoveredShares).toBeCloseTo(5_000, 6); // the 2023 purchase
  });

  /**
   * The case that reaches a tax form: transferred-in shares are SOLD later.
   * Upstream bought 100 @ $10 (2020) and transferred them to Source (2021);
   * Source sold 60 @ $80 (2024) and moved the remaining 40 on (2025).
   */
  function transferThenSellBook() {
    const upToSrc = transfer({
      txGuid: XFER_UP_SRC, postDate: '2021-01-01', from: UP, to: SRC, shares: 100,
      inGuid: 'xfer-in-src', outGuid: 'xfer-out-up',
    });
    const toDest = srcToDest(40);
    register(UP, [buy({ guid: 'buy-up', account: UP, postDate: '2020-01-01', shares: 100, value: 1_000 }), upToSrc.out]);
    register(SRC, [upToSrc.in, sell({ guid: 'sell-src', account: SRC, postDate: '2024-01-01', shares: 60, proceeds: 4_800 }), toDest.out]);
  }

  it('a sale out of transferred-in shares books gain against the CARRIED basis, not $0', async () => {
    transferThenSellBook();
    const r = await traceCostBasis('split-transfer-in', 'average', AAPL, 40, createCostBasisCache());
    expect(r.perShareCost).toBeCloseTo(10, 6);
    expect(r.basisOfCoveredShares).toBeCloseTo(400, 6); // 40 shares still holding $10 of basis each

    // What the 60-share sale reports: $4,800 proceeds against $600 of basis.
    // With the transferred shares admitted at $0 the gain would be the full
    // $4,800 — $600 of phantom, taxable gain.
    const reportedGain = 4_800 - 60 * r.perShareCost;
    expect(reportedGain).toBeCloseTo(4_200, 6);
    expect(reportedGain).not.toBeCloseTo(4_800, 2);
  });

  it('FIFO reports the same carried basis for the surviving shares', async () => {
    transferThenSellBook();
    const r = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 40, createCostBasisCache());
    expect(r.basisOfCoveredShares).toBeCloseTo(400, 6);
  });

  /**
   * Scrubbed book: the transfer-in split sits in a destination lot whose
   * `carried_basis` slot holds the basis (the lot has no purchase of its own),
   * and the upstream account's history is NOT in this book.
   */
  function carriedBasisSlotBook() {
    const upToSrc = transfer({
      txGuid: XFER_UP_SRC, postDate: '2021-01-01', from: UP, to: SRC, shares: 100,
      inGuid: 'xfer-in-src', outGuid: 'xfer-out-up', inLotGuid: 'lot-src-xfer',
    });
    const toDest = srcToDest(200);
    register(UP, []); // upstream book absent — only the carried_basis slot knows
    register(SRC, [upToSrc.in, buy({ guid: 'buy-src', account: SRC, postDate: '2023-01-01', shares: 100, value: 5_000 }), toDest.out]);
    byLot.set('lot-src-xfer', [upToSrc.in]);
    carriedByLot.set('lot-src-xfer', '1000');
  }

  it('reads the destination lot\'s carried_basis slot when the chain is not in the book', async () => {
    carriedBasisSlotBook();
    const avg = await traceCostBasis('split-transfer-in', 'average', AAPL, 200, createCostBasisCache());
    expect(avg.perShareCost).toBeCloseTo(30, 6);
    expect(avg.basisOfCoveredShares).toBeCloseTo(6_000, 6);
    expect(avg.warnings).toBeUndefined();

    carriedBasisSlotBook();
    const fifo = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 100, createCostBasisCache());
    expect(fifo.basisOfCoveredShares).toBeCloseTo(1_000, 6);
  });
});

describe('traceCostBasis — genuinely unknown carried basis is named, never silently $0', () => {
  beforeEach(installRegistryMocks);

  /** Same shape as above, but nothing records where the transferred shares came from. */
  function untraceableTransferBook() {
    const upToSrc = transfer({
      txGuid: XFER_UP_SRC, postDate: '2021-01-01', from: UP, to: SRC, shares: 100,
      inGuid: 'xfer-in-src', outGuid: 'xfer-out-up',
    });
    const toDest = srcToDest(200);
    register(UP, []); // source lot not in this book / predates the data
    register(SRC, [upToSrc.in, buy({ guid: 'buy-src', account: SRC, postDate: '2023-01-01', shares: 100, value: 5_000 }), toDest.out]);
  }

  it('average excludes the un-basised shares from the pool instead of averaging in a zero', async () => {
    untraceableTransferBook();
    const r = await traceCostBasis('split-transfer-in', 'average', AAPL, 200, createCostBasisCache());
    // Pooling the unknown 100 at $0 would report $25/share for shares that
    // actually cost $50. The known shares keep their own average.
    expect(r.perShareCost).toBeCloseTo(50, 6);
    expect(r.uncoveredShares).toBeCloseTo(100, 6);
    expect(r.basisOfCoveredShares).toBeCloseTo(5_000, 6); // basis of the 100 shares that have one
    expect(namesShares(r.warnings, 'excluded from the average-cost pool')).toBe(true);
  });

  it('FIFO keeps the parcel in the queue but reports its shares as uncovered', async () => {
    untraceableTransferBook();
    const r = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 200, createCostBasisCache());
    expect(r.basisOfCoveredShares).toBeCloseTo(5_000, 6);
    expect(r.coveredShares).toBeCloseTo(100, 6);
    expect(r.uncoveredShares).toBeCloseTo(100, 6);
    // $50/share over the shares that HAVE a basis, not $25 over all 200.
    expect(r.perShareCost).toBeCloseTo(50, 6);
    expect(namesShares(r.warnings, 'no traceable cost basis in this book')).toBe(true);
  });

  it('a fully-traceable book reports no unknown shares at all', async () => {
    const upToSrc = transfer({
      txGuid: XFER_UP_SRC, postDate: '2021-01-01', from: UP, to: SRC, shares: 100,
      inGuid: 'xfer-in-src', outGuid: 'xfer-out-up',
    });
    const toDest = srcToDest(100);
    register(UP, [buy({ guid: 'buy-up', account: UP, postDate: '2020-01-01', shares: 100, value: 1_000 }), upToSrc.out]);
    register(SRC, [upToSrc.in, toDest.out]);
    for (const method of ['fifo', 'lifo', 'average'] as CostBasisMethod[]) {
      const r = await traceCostBasis('split-transfer-in', method, AAPL, 100, createCostBasisCache());
      expect(r.basisOfCoveredShares).toBeCloseTo(1_000, 6);
      expect(r.uncoveredShares).toBeCloseTo(0, 6);
      expect(r.warnings).toBeUndefined();
    }
  });
});

describe('traceCostBasis — coverage survives NESTING', () => {
  beforeEach(installRegistryMocks);

  /**
   * A chain whose MIDDLE hop is only partly covered:
   *   Grandparent (not in this book) -> Upstream: 100 shares, no basis
   *   Upstream buys 100 @ $50                     -> 100 shares, $5,000
   *   Upstream -> Source: all 200 shares          -> 100 covered + 100 not
   *   Source buys 100 @ $10                       -> 100 shares, $1,000
   *   Source -> Dest: all 300 shares              <- the trace under test
   *
   * Covered basis is $6,000 over 200 covered shares = $30/share. Folding the
   * partly-covered 200-share parcel in as if all of it were covered gives
   * $6,000 / 300 = $20/share — the H4 defect, one hop removed.
   */
  function partiallyCoveredChainBook() {
    const GP = 'acct-grandparent';
    const gpToUp = transfer({
      txGuid: 'tx-xfer-gp-up', postDate: '2019-01-01', from: GP, to: UP, shares: 100,
      inGuid: 'xfer-in-up', outGuid: 'xfer-out-gp',
    });
    const upToSrc = transfer({
      txGuid: XFER_UP_SRC, postDate: '2021-01-01', from: UP, to: SRC, shares: 200,
      inGuid: 'xfer-in-src', outGuid: 'xfer-out-up',
    });
    const toDest = srcToDest(300);
    register(GP, []); // grandparent's history is not in this book
    register(UP, [gpToUp.in, buy({ guid: 'buy-up', account: UP, postDate: '2020-01-01', shares: 100, value: 5_000 }), upToSrc.out]);
    register(SRC, [upToSrc.in, buy({ guid: 'buy-src', account: SRC, postDate: '2023-01-01', shares: 100, value: 1_000 }), toDest.out]);
  }

  it('average carries a partly-covered parcel through as partly covered', async () => {
    partiallyCoveredChainBook();
    const r = await traceCostBasis('split-transfer-in', 'average', AAPL, 300, createCostBasisCache());
    expect(r.coveredShares).toBeCloseTo(200, 6);
    expect(r.uncoveredShares).toBeCloseTo(100, 6);
    expect(r.basisOfCoveredShares).toBeCloseTo(6_000, 6);
    // $30 over the covered shares — NOT $20 over all 300.
    expect(r.perShareCost).toBeCloseTo(30, 6);
    expect(r.coveredShares + r.uncoveredShares).toBeCloseTo(300, 6);
  });

  it('FIFO carries the parcel\'s uncovered fraction through too', async () => {
    partiallyCoveredChainBook();
    const r = await traceCostBasis('split-transfer-in', 'fifo', AAPL, 300, createCostBasisCache());
    expect(r.coveredShares).toBeCloseTo(200, 6);
    expect(r.uncoveredShares).toBeCloseTo(100, 6);
    expect(r.basisOfCoveredShares).toBeCloseTo(6_000, 6);
    expect(r.perShareCost).toBeCloseTo(30, 6);
  });
});

describe('traceCostBasis — depth bound', () => {
  beforeEach(installRegistryMocks);

  /**
   * acct-chain-0 buys 10 shares for $100, then the shares hop from account to
   * account `hops` times. Returns the guid of the LAST transfer-in split.
   */
  function buildTransferChain(hops: number): string {
    const name = (i: number) => `acct-chain-${i}`;
    const rows = new Map<number, Row[]>();
    rows.set(0, [buy({ guid: 'chain-buy', account: name(0), postDate: '2000-01-01', shares: 10, value: 100 })]);
    for (let i = 0; i < hops; i++) {
      const hop = transfer({
        txGuid: `tx-chain-${i}`, postDate: '2001-01-01', from: name(i), to: name(i + 1), shares: 10,
        inGuid: `chain-in-${i}`, outGuid: `chain-out-${i}`,
      });
      rows.get(i)!.push(hop.out);
      rows.set(i + 1, [hop.in]);
    }
    for (const [i, list] of rows) register(name(i), list);
    return `chain-in-${hops - 1}`;
  }

  it('follows a chain shorter than the bound all the way to the purchase', async () => {
    const last = buildTransferChain(5);
    const r = await traceCostBasis(last, 'average', AAPL, 10, createCostBasisCache());
    expect(r.basisOfCoveredShares).toBeCloseTo(100, 6);
    expect(r.coveredShares).toBeCloseTo(10, 6);
    expect(r.uncoveredShares).toBeCloseTo(0, 6);
  });

  it('stops at MAX_TRACE_DEPTH and reports the shares uncovered, not $0 and not an exception', async () => {
    const last = buildTransferChain(MAX_TRACE_DEPTH + 5);
    const r = await traceCostBasis(last, 'average', AAPL, 10, createCostBasisCache());
    expect(r.coveredShares).toBeCloseTo(0, 6);
    expect(r.uncoveredShares).toBeCloseTo(10, 6);
    expect(r.basisOfCoveredShares).toBe(0);
    expect(r.warnings?.some(w => w.includes(`deeper than ${MAX_TRACE_DEPTH} hops`))).toBe(true);
  });

  it('applies the same bound under FIFO', async () => {
    const last = buildTransferChain(MAX_TRACE_DEPTH + 5);
    const r = await traceCostBasis(last, 'fifo', AAPL, 10, createCostBasisCache());
    expect(r.uncoveredShares).toBeCloseTo(10, 6);
    expect(r.warnings?.some(w => w.includes(`deeper than ${MAX_TRACE_DEPTH} hops`))).toBe(true);
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
