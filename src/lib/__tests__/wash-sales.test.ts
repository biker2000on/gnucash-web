/**
 * detectWashSales — IRC §1091 pro-rating and the 30-day calendar window.
 *
 * §1091(b): when FEWER replacement shares are acquired than were sold, only
 * the proportionate part of the loss is disallowed. The engine used to
 * disallow the entire loss regardless of how few shares were bought back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockSplitsFindMany = vi.fn();
const mockLotsFindMany = vi.fn();
const mockSlotsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: { findMany: (...a: unknown[]) => mockAccountsFindMany(...a) },
    splits: { findMany: (...a: unknown[]) => mockSplitsFindMany(...a) },
    lots: { findMany: (...a: unknown[]) => mockLotsFindMany(...a) },
    slots: { findMany: (...a: unknown[]) => mockSlotsFindMany(...a) },
  },
}));

// lot-assignment pulls in the pool/lock modules at import time; neither is
// exercised by detectWashSales.
vi.mock('../db', () => ({
  tryWithDatabaseAdvisoryLock: vi.fn(),
}));
vi.mock('../book-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../book-lock')>()),
  bookLockKey: vi.fn(() => 'lock'),
  tryAcquireBookLock: vi.fn(),
}));

import { detectWashSales } from '../lot-assignment';

const ACCT = 'acct-brokerage';
const COMMODITY = 'commodity-aapl';

function raw(guid: string, postDate: string, shares: number, value: number, lotGuid: string | null = null) {
  return {
    guid,
    account_guid: ACCT,
    lot_guid: lotGuid,
    quantity_num: BigInt(Math.round(shares * 10_000)),
    quantity_denom: 10_000n,
    value_num: BigInt(Math.round(value * 100)),
    value_denom: 100n,
    transaction: { post_date: new Date(postDate) },
  };
}

/**
 * A closed lot: bought 100 shares for $5,000, sold them for $4,000 —
 * a realized loss of exactly $1,000.
 */
const LOSS_LOT = {
  guid: 'lot-1',
  splits: [
    { quantity_num: 1_000_000n, quantity_denom: 10_000n, value_num: 500_000n, value_denom: 100n },
    { quantity_num: -1_000_000n, quantity_denom: 10_000n, value_num: -400_000n, value_denom: 100n },
  ],
};

/** Sale of 100 shares at a $1,000 loss on 2024-06-01, plus a replacement buy. */
function scenario(replacement: { date: string; shares: number; cost: number } | null) {
  mockAccountsFindMany.mockResolvedValue([
    { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
  ]);
  mockLotsFindMany.mockResolvedValue([LOSS_LOT]);
  const splits = [
    raw('buy-original', '2024-01-01T12:00:00.000Z', 100, 5_000, 'lot-1'),
    raw('sell', '2024-06-01T12:00:00.000Z', -100, -4_000, 'lot-1'),
  ];
  if (replacement) {
    splits.push(raw('buy-replacement', replacement.date, replacement.shares, replacement.cost));
  }
  mockSplitsFindMany.mockResolvedValue(splits);
  return detectWashSales([ACCT]);
}

beforeEach(() => {
  mockAccountsFindMany.mockReset();
  mockSplitsFindMany.mockReset();
  mockLotsFindMany.mockReset();
  mockSlotsFindMany.mockReset().mockResolvedValue([]);
});

describe('§1091(b) pro-rating', () => {
  it('buying back 10 of 100 shares disallows only $100 of the $1,000 loss', async () => {
    const [wash] = await scenario({ date: '2024-06-10T12:00:00.000Z', shares: 10, cost: 400 });
    expect(wash).toBeDefined();
    expect(wash.shares).toBeCloseTo(100, 6);
    expect(wash.replacementShares).toBeCloseTo(10, 6);
    // 10/100 x $1,000 disallowed; the other $900 stays deductible.
    expect(wash.loss).toBeCloseTo(-100, 6);
  });

  it('buying back all 100 shares disallows the whole $1,000', async () => {
    const [wash] = await scenario({ date: '2024-06-10T12:00:00.000Z', shares: 100, cost: 4_200 });
    expect(wash.loss).toBeCloseTo(-1_000, 6);
  });

  it('buying back MORE than was sold is capped at 100% of the loss', async () => {
    const [wash] = await scenario({ date: '2024-06-10T12:00:00.000Z', shares: 250, cost: 10_000 });
    expect(wash.replacementShares).toBeCloseTo(100, 6);
    expect(wash.loss).toBeCloseTo(-1_000, 6);
  });

  it('a fractional buyback pro-rates proportionally', async () => {
    const [wash] = await scenario({ date: '2024-06-05T12:00:00.000Z', shares: 2.5, cost: 100 });
    expect(wash.loss).toBeCloseTo(-25, 6);
  });

  it('uses carried basis to recognize a transferred-lot loss', async () => {
    mockAccountsFindMany.mockResolvedValue([
      { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
    ]);
    mockLotsFindMany.mockResolvedValue([{
      guid: 'transfer-lot',
      splits: [
        { quantity_num: 1_000_000n, quantity_denom: 10_000n, value_num: 0n, value_denom: 100n },
        { quantity_num: -1_000_000n, quantity_denom: 10_000n, value_num: -400_000n, value_denom: 100n },
      ],
    }]);
    mockSlotsFindMany.mockResolvedValue([
      { obj_guid: 'transfer-lot', string_val: '5000' },
    ]);
    mockSplitsFindMany.mockResolvedValue([
      raw('transfer-in', '2024-01-01T12:00:00.000Z', 100, 0, 'transfer-lot'),
      raw('sell', '2024-06-01T12:00:00.000Z', -100, -4_000, 'transfer-lot'),
      raw('buy-replacement', '2024-06-10T12:00:00.000Z', 10, 400),
    ]);

    const [wash] = await detectWashSales([ACCT]);
    expect(wash.loss).toBeCloseTo(-100, 6);
  });

  it('consumes replacement shares so one buy cannot wash two sales', async () => {
    mockAccountsFindMany.mockResolvedValue([
      { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
    ]);
    mockLotsFindMany.mockResolvedValue([{
      guid: 'multi-sale-lot',
      splits: [
        { quantity_num: 2_000_000n, quantity_denom: 10_000n, value_num: 1_000_000n, value_denom: 100n },
        { quantity_num: -1_000_000n, quantity_denom: 10_000n, value_num: -400_000n, value_denom: 100n },
        { quantity_num: -1_000_000n, quantity_denom: 10_000n, value_num: -400_000n, value_denom: 100n },
      ],
    }]);
    mockSplitsFindMany.mockResolvedValue([
      raw('buy-original', '2024-01-01T12:00:00.000Z', 200, 10_000, 'multi-sale-lot'),
      raw('sell-one', '2024-06-01T12:00:00.000Z', -100, -4_000, 'multi-sale-lot'),
      raw('sell-two', '2024-06-02T12:00:00.000Z', -100, -4_000, 'multi-sale-lot'),
      raw('one-replacement', '2024-06-10T12:00:00.000Z', 100, 4_000),
    ]);

    const washes = await detectWashSales([ACCT]);
    expect(washes).toHaveLength(1);
    expect(washes[0].replacementShares).toBeCloseTo(100, 6);
    expect(washes[0].loss).toBeCloseTo(-1_000, 6);
  });
});

describe('the 30-day window is measured in CALENDAR days', () => {
  it('a day-30 replacement bought later in the day still counts', async () => {
    // 30 days + 6 hours of raw elapsed time — the millisecond comparison used
    // to push this over the window and miss a real wash sale.
    const washes = await scenario({ date: '2024-07-01T18:00:00.000Z', shares: 100, cost: 4_100 });
    expect(washes).toHaveLength(1);
    expect(washes[0].daysApart).toBe(30);
  });

  it('a day-30 replacement bought earlier in the day counts too', async () => {
    const washes = await scenario({ date: '2024-07-01T02:00:00.000Z', shares: 100, cost: 4_100 });
    expect(washes).toHaveLength(1);
    expect(washes[0].daysApart).toBe(30);
  });

  it('day 31 is outside the window', async () => {
    const washes = await scenario({ date: '2024-07-02T02:00:00.000Z', shares: 100, cost: 4_100 });
    expect(washes).toHaveLength(0);
  });

  it('a replacement 30 days BEFORE the sale counts', async () => {
    const washes = await scenario({ date: '2024-05-02T23:00:00.000Z', shares: 100, cost: 4_100 });
    expect(washes).toHaveLength(1);
    expect(washes[0].daysApart).toBe(30);
  });

  it('no replacement buy means no wash sale', async () => {
    expect(await scenario(null)).toHaveLength(0);
  });
});

describe('transfer-outs are not wash-sale dispositions', () => {
  it('does not create an unmatched wash-sale row for a closed in-kind transfer-out', async () => {
    mockAccountsFindMany.mockResolvedValue([
      { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
    ]);
    mockLotsFindMany.mockResolvedValue([{
      guid: 'transfer-source-lot',
      splits: [
        { guid: 'buy', quantity_num: 1_000_000n, quantity_denom: 10_000n, value_num: 500_000n, value_denom: 100n },
        { guid: 'transfer-out', quantity_num: -1_000_000n, quantity_denom: 10_000n, value_num: 0n, value_denom: 100n },
      ],
    }]);
    const transferOut = {
      ...raw('transfer-out', '2024-06-01T12:00:00.000Z', -100, 0, 'transfer-source-lot'),
      transaction: {
        post_date: new Date('2024-06-01T12:00:00.000Z'),
        splits: [{
          guid: 'transfer-in',
          account_guid: 'acct-destination',
          quantity_num: 1_000_000n,
          quantity_denom: 10_000n,
          account: { commodity_guid: COMMODITY, account_type: 'STOCK' },
        }],
      },
    };
    mockSplitsFindMany.mockResolvedValue([
      raw('buy', '2024-01-01T12:00:00.000Z', 100, 5_000, 'transfer-source-lot'),
      transferOut,
      raw('buy-replacement', '2024-06-10T12:00:00.000Z', 100, 4_000),
    ]);

    expect(await detectWashSales([ACCT])).toEqual([]);
  });
});

describe('false-positive exclusions', () => {
  it('a sale does not flag against its OWN lot-opening buy', async () => {
    // The purchase that opened the sold lot sits 12 days before the sale —
    // inside the 30-day window — but those are the very shares being sold,
    // not replacement stock. (DRIP-heavy accounts drown in noise otherwise.)
    mockAccountsFindMany.mockResolvedValue([
      { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
    ]);
    mockLotsFindMany.mockResolvedValue([{
      guid: 'lot-1',
      splits: [
        { quantity_num: 1_000_000n, quantity_denom: 10_000n, value_num: 500_000n, value_denom: 100n },
        { quantity_num: -1_000_000n, quantity_denom: 10_000n, value_num: -400_000n, value_denom: 100n },
      ],
    }]);
    mockSplitsFindMany.mockResolvedValue([
      raw('buy-own-lot', '2024-05-20T12:00:00.000Z', 100, 5_000, 'lot-1'),
      raw('sell', '2024-06-01T12:00:00.000Z', -100, -4_000, 'lot-1'),
    ]);

    const washes = await detectWashSales([ACCT]);
    expect(washes).toHaveLength(0);
  });

  it('a transfer-in sub-split is not replacement stock', async () => {
    // Shares moved in from the user's OWN other account within the window:
    // §1091 replacement stock must be acquired, not relocated.
    mockAccountsFindMany.mockResolvedValue([
      { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
    ]);
    mockLotsFindMany.mockResolvedValue([LOSS_LOT]);
    const transferIn = {
      ...raw('xfer-in', '2024-06-10T12:00:00.000Z', 50, 0),
      transaction: {
        post_date: new Date('2024-06-10T12:00:00.000Z'),
        splits: [
          {
            guid: 'xfer-out',
            account_guid: 'acct-other-brokerage',
            quantity_num: -500_000n,
            quantity_denom: 10_000n,
            account: { commodity_guid: COMMODITY, account_type: 'STOCK' },
          },
        ],
      },
    };
    mockSplitsFindMany.mockResolvedValue([
      raw('buy-original', '2024-01-01T12:00:00.000Z', 100, 5_000, 'lot-1'),
      raw('sell', '2024-06-01T12:00:00.000Z', -100, -4_000, 'lot-1'),
      transferIn,
    ]);

    const washes = await detectWashSales([ACCT]);
    expect(washes).toHaveLength(0);
  });

  it('the no-lot loss heuristic averages only buys ON OR BEFORE the sell date', async () => {
    // Pre-sale basis $30/share, sold at $35/share — a GAIN. An expensive
    // post-sale buy ($100/share) used to drag the average cost to $65 and
    // fabricate a loss + wash-sale flag.
    mockAccountsFindMany.mockResolvedValue([
      { guid: ACCT, name: 'Brokerage', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
    ]);
    mockLotsFindMany.mockResolvedValue([]);
    mockSplitsFindMany.mockResolvedValue([
      raw('buy-early', '2024-01-01T12:00:00.000Z', 100, 3_000),
      raw('sell', '2024-06-01T12:00:00.000Z', -100, -3_500),
      raw('buy-late', '2024-06-10T12:00:00.000Z', 100, 10_000),
    ]);

    const washes = await detectWashSales([ACCT]);
    expect(washes).toHaveLength(0);
  });
});
