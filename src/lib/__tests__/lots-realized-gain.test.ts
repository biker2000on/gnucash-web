/**
 * computeRealizedGain tests — native GnuCash sign convention.
 *
 * Buy split on the stock account: positive quantity, POSITIVE value (debit).
 * Sell split: negative quantity, NEGATIVE value (credit).
 * Gains offset splits (scrub-generated or GnuCash desktop): zero quantity,
 * non-zero value, recorded inside the lot so it sums to zero.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLotsFindMany = vi.fn();
const mockSlotsFindMany = vi.fn();
const mockAccountsFindMany = vi.fn();
// Unlike lots-holding-period.test.ts (which pins getLatestPrice to null and so
// never exercises unrealizedGain), these tests need a real price so the
// carried-basis pro-rating is actually evaluated.
let mockLatestPrice: number | null = null;

vi.mock('../prisma', () => ({
  default: {
    lots: { findMany: (...a: unknown[]) => mockLotsFindMany(...a) },
    slots: { findMany: (...a: unknown[]) => mockSlotsFindMany(...a) },
    accounts: { findMany: (...a: unknown[]) => mockAccountsFindMany(...a) },
    // getAccountLots nets trade fees by default, which queries the trade
    // transactions' sibling splits. These fixtures have no fee splits, so an
    // empty result keeps the figures identical to the gross ones.
    splits: { findMany: async () => [] },
  },
}));

vi.mock('../commodities', () => ({
  getLatestPrice: vi.fn(async () =>
    mockLatestPrice === null ? null : { value: mockLatestPrice },
  ),
}));

import { computeRealizedGain, getAccountLots } from '../lots';

describe('computeRealizedGain', () => {
  it('closed unscrubbed lot: gain = proceeds - basis = -(sum of values)', () => {
    // Buy 10 @ $100 (+1000), sell 10 @ $150 (-1500): gain $500
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -10, value: -1500 },
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(500);
  });

  it('closed unscrubbed lot with a loss returns a negative gain', () => {
    // Buy 10 @ $100 (+1000), sell 10 @ $80 (-800): loss $200
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -10, value: -800 },
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(-200);
  });

  it('scrubbed closed lot: excludes the zero-qty gains offset split', () => {
    // Same trade, plus the scrub-generated offset (+500) that zeroes the lot.
    // Without the exclusion the naive sum would report 0.
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -10, value: -1500 },
      { shares: 0, value: 500 }, // gains offset
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(500);
  });

  it('open lot with no sells: zero realized gain', () => {
    const splits = [{ shares: 10, value: 1000 }];
    expect(computeRealizedGain(splits, false)).toBe(0);
  });

  it('open partially-sold lot: realized portion only', () => {
    // Buy 10 @ $100, sell 4 @ $150: realized = 600 - 4*100 = $200
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -4, value: -600 },
    ];
    expect(computeRealizedGain(splits, false)).toBeCloseTo(200);
  });

  it('lot from a zero-value transfer-in treats proceeds as full gain', () => {
    // Transfer-in with no value recorded, then sell: basis unknown => 0
    const splits = [
      { shares: 10, value: 0 },
      { shares: -10, value: -1500 },
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(1500);
  });

  it('subtracts carried basis from a transferred lot gain', () => {
    const splits = [
      { shares: 10, value: 0 },
      { shares: -10, value: -1500 },
    ];
    expect(computeRealizedGain(splits, true, 900)).toBeCloseTo(600);
  });
});

/**
 * getAccountLots carried-basis tests.
 *
 * A transfer-destination lot holds a $0-value transfer-in split; the true basis
 * of the transferred shares lives in the lot's `carried_basis` slot. If
 * totalCost / unrealizedGain ignore it, an unchanged in-kind transfer looks
 * like a 100% gain — and tax-loss harvesting (which keeps only lots whose
 * unrealizedGain is negative) silently drops every harvestable transferred lot.
 */
const ACCT = 'acct-stock';
const COMMODITY = 'commodity-aapl';

function split(guid: string, postDate: string, shares: number, value: number) {
  return {
    guid,
    tx_guid: `tx-${guid}`,
    quantity_num: BigInt(Math.round(shares * 10_000)),
    quantity_denom: 10_000n,
    value_num: BigInt(Math.round(value * 100)),
    value_denom: 100n,
    transaction: { post_date: new Date(`${postDate}T12:00:00.000Z`), description: guid },
  };
}

function lot(guid: string, isClosed: 0 | 1, splits: ReturnType<typeof split>[]) {
  return { guid, account_guid: ACCT, is_closed: isClosed, splits };
}

function carriedBasisSlot(lotGuid: string, amount: string) {
  return { obj_guid: lotGuid, name: 'carried_basis', string_val: amount };
}

function sourceLotSlot(lotGuid: string) {
  return { obj_guid: lotGuid, name: 'source_lot_guid', string_val: 'source-lot' };
}

function transferOutSplit(guid: string, postDate: string, shares: number, value: number) {
  return {
    ...split(guid, postDate, shares, value),
    transaction: {
      post_date: new Date(`${postDate}T12:00:00.000Z`),
      description: guid,
      splits: [{
        account_guid: 'destination-account',
        quantity_num: BigInt(Math.round(Math.abs(shares) * 10_000)),
        quantity_denom: 10_000n,
        account: { commodity_guid: COMMODITY, account_type: 'STOCK' },
      }],
    },
  };
}

function transferInSplit(guid: string, postDate: string, shares: number, value: number) {
  return {
    ...split(guid, postDate, shares, value),
    transaction: {
      post_date: new Date(`${postDate}T12:00:00.000Z`),
      description: guid,
      splits: [{
        account_guid: 'source-account',
        quantity_num: BigInt(Math.round(-Math.abs(shares) * 10_000)),
        quantity_denom: 10_000n,
        account: { commodity_guid: COMMODITY, account_type: 'STOCK' },
      }],
    },
  };
}

beforeEach(() => {
  mockLatestPrice = null;
  mockLotsFindMany.mockReset();
  mockSlotsFindMany.mockReset().mockResolvedValue([]);
  mockAccountsFindMany.mockReset().mockResolvedValue([
    { guid: ACCT, commodity_guid: COMMODITY },
  ]);
});

describe('carried basis feeds totalCost and unrealizedGain', () => {
  it('open transferred lot: unrealizedGain = marketValue - carriedBasis', async () => {
    // 10 shares transferred in at $0 value, original basis $800 carried in the
    // slot. Latest price $100 -> market value $1,000.
    mockLotsFindMany.mockResolvedValue([
      lot('xfer-open', 0, [transferInSplit('in', '2024-02-01', 10, 0)]),
    ]);
    mockSlotsFindMany.mockResolvedValue([
      carriedBasisSlot('xfer-open', '800'),
      sourceLotSlot('xfer-open'),
    ]);
    mockLatestPrice = 100;

    const [summary] = await getAccountLots(ACCT);

    expect(summary.isClosed).toBe(false);
    expect(summary.carriedBasis).toBe(800);
    expect(summary.currentPrice).toBe(100);
    expect(summary.totalShares).toBeCloseTo(10);
    // (b) totalCost is the carried basis, not $0
    expect(summary.totalCost).toBeCloseTo(800);
    // (a) 10 * 100 - 800 = 200
    expect(summary.unrealizedGain).toBeCloseTo(200);
    expect(summary.unrealizedGain).toBeCloseTo(100 * summary.totalShares - 800);
  });

  it('open transferred lot under water reports a NEGATIVE unrealized gain', async () => {
    // The tax-harvesting screen keeps lots with unrealizedGain < 0. Basis $800,
    // price $60 -> market value $600, a real $200 harvestable loss. Dropping
    // carriedBasis would report +$600 and hide it.
    mockLotsFindMany.mockResolvedValue([
      lot('xfer-loss', 0, [split('in', '2024-02-01', 10, 0)]),
    ]);
    mockSlotsFindMany.mockResolvedValue([carriedBasisSlot('xfer-loss', '800')]);
    mockLatestPrice = 60;

    const [summary] = await getAccountLots(ACCT);

    expect(summary.unrealizedGain).toBeCloseTo(-200);
  });

  it('valued source-linked transfer counts carried basis, not transfer value, exactly once', async () => {
    // $3,000 is a recorded own-account transfer value, not new purchase cost.
    // Original basis is $1,000; sale at $3,500 realizes a $2,500 gain.
    mockLotsFindMany.mockResolvedValue([
      lot('valued-xfer', 1, [
        transferInSplit('in', '2024-02-01', 100, 3_000),
        split('sell', '2024-03-01', -100, -3_500),
      ]),
    ]);
    mockSlotsFindMany.mockResolvedValue([
      carriedBasisSlot('valued-xfer', '1000'),
      sourceLotSlot('valued-xfer'),
    ]);

    const [summary] = await getAccountLots(ACCT);

    expect(summary.totalCost).toBeCloseTo(1_000);
    expect(summary.realizedGain).toBeCloseTo(2_500);
  });

  it('keeps a legacy source-linked lot without carried_basis on its recorded-value basis', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('legacy-valued-xfer', 1, [
        transferInSplit('in', '2024-02-01', 100, 3_000),
        split('sell', '2024-03-01', -100, -3_500),
      ]),
    ]);
    mockSlotsFindMany.mockResolvedValue([sourceLotSlot('legacy-valued-xfer')]);

    const [summary] = await getAccountLots(ACCT);

    expect(summary.totalCost).toBeCloseTo(3_000);
    expect(summary.realizedGain).toBeCloseTo(500);
  });

  it('partially-sold lot with BOTH real buy cost and carried basis pro-rates once', async () => {
    // 10 shares transferred in at $0 value carrying $800 of basis, plus a real
    // 10-share buy for $1,200, then 5 shares sold for $700.
    //   boughtShares = 20, remaining = 15
    //   totalCost    = |0| + |1200| + 800 = 2000  ($100/share)
    //   remaining basis = 2000 * 15/20 = 1500, sold basis = 500 (sums to 2000:
    //                     the carried basis is counted exactly once)
    //   unrealized   = 150 * 15 - 1500 = 750
    //   realized     = 700 - 5 * 100  = 200
    mockLotsFindMany.mockResolvedValue([
      lot('mixed', 0, [
        split('in', '2024-01-10', 10, 0),
        split('buy', '2024-02-10', 10, 1_200),
        split('sell', '2024-03-10', -5, -700),
      ]),
    ]);
    mockSlotsFindMany.mockResolvedValue([carriedBasisSlot('mixed', '800')]);
    mockLatestPrice = 150;

    const [summary] = await getAccountLots(ACCT);

    expect(summary.isClosed).toBe(false);
    expect(summary.totalShares).toBeCloseTo(15);
    expect(summary.totalCost).toBeCloseTo(2_000);
    expect(summary.realizedGain).toBeCloseTo(200);
    expect(summary.unrealizedGain).toBeCloseTo(750);

    // No double-counting: the basis attributed to the remaining shares plus the
    // basis attributed to the sold shares must equal totalCost exactly.
    const remainingBasis = 150 * summary.totalShares - summary.unrealizedGain!;
    const soldBasis = 700 - summary.realizedGain;
    expect(remainingBasis + soldBasis).toBeCloseTo(summary.totalCost);
  });

  it('a lot with no carried_basis slot is unaffected', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('plain', 0, [split('buy', '2024-01-10', 10, 1_000)]),
    ]);
    mockLatestPrice = 120;

    const [summary] = await getAccountLots(ACCT);

    expect(summary.carriedBasis).toBe(0);
    expect(summary.totalCost).toBeCloseTo(1_000);
    expect(summary.unrealizedGain).toBeCloseTo(200);
  });
});

describe('transfer-out lot summaries', () => {
  it('does not fabricate a realized loss when the transfer split closes the source lot', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('transfer-source', 1, [
        split('buy', '2020-01-01', 10, 1_000),
        transferOutSplit('transfer-out', '2024-02-01', -10, 0),
      ]),
    ]);

    const [summary] = await getAccountLots(ACCT);

    expect(summary.isClosed).toBe(true);
    expect(summary.realizedGain).toBe(0);
  });

  it('keeps the real loss when a transfer-out and sale share a closed lot', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('mixed-close', 1, [
        split('buy', '2020-01-01', 10, 1_000),
        transferOutSplit('transfer-out', '2024-02-01', -4, 0),
        split('sale', '2024-03-01', -6, -400),
      ]),
    ]);

    const [summary] = await getAccountLots(ACCT);

    expect(summary.realizedGain).toBe(-200);
  });

  it('does not treat a partial transfer-out in an open lot as a sale', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('open-transfer', 0, [
        split('buy', '2020-01-01', 10, 1_000),
        transferOutSplit('transfer-out', '2024-02-01', -4, 0),
      ]),
    ]);

    const [summary] = await getAccountLots(ACCT);

    expect(summary.realizedGain).toBe(0);
  });

  it('keeps a zero-value worthless-security write-off as a real loss', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('worthless', 1, [
        split('buy', '2020-01-01', 10, 1_000),
        split('write-off', '2024-12-31', -10, 0),
      ]),
    ]);

    const [summary] = await getAccountLots(ACCT);

    expect(summary.realizedGain).toBe(-1_000);
  });
});
