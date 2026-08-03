/**
 * getAccountLots holding-period tests.
 *
 * A CLOSED lot's short/long term was fixed on the day it closed. Measuring it
 * against TODAY (the old `now - openMs > 365 days` rule) eventually relabels
 * every realized short-term sale as long-term, which is exactly backwards for
 * the tax-harvesting and rebalancing screens that decide which lots to sell.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLotsFindMany = vi.fn();
const mockSlotsFindMany = vi.fn();
const mockAccountsFindUnique = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    lots: { findMany: (...a: unknown[]) => mockLotsFindMany(...a) },
    slots: { findMany: (...a: unknown[]) => mockSlotsFindMany(...a) },
    accounts: { findUnique: (...a: unknown[]) => mockAccountsFindUnique(...a) },
  },
}));

vi.mock('../commodities', () => ({
  getLatestPrice: vi.fn(async () => null),
}));

import { getAccountLots } from '../lots';

const ACCT = 'acct-stock';

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

beforeEach(() => {
  mockLotsFindMany.mockReset();
  mockSlotsFindMany.mockReset().mockResolvedValue([]);
  mockAccountsFindUnique.mockReset().mockResolvedValue({ commodity_guid: 'commodity-aapl' });
});

describe('closed lots are classified against their CLOSE date', () => {
  it('bought 2024-01-01 and sold 2024-03-01 stays short_term forever', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('lot-1', 1, [
        split('buy', '2024-01-01', 10, 1_000),
        split('sell', '2024-03-01', -10, -1_100),
      ]),
    ]);
    const [summary] = await getAccountLots(ACCT);
    expect(summary.isClosed).toBe(true);
    expect(summary.holdingPeriod).toBe('short_term');
  });

  it('bought 2020-01-01 and sold 2023-06-01 is long_term', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('lot-2', 1, [
        split('buy', '2020-01-01', 10, 1_000),
        split('sell', '2023-06-01', -10, -2_000),
      ]),
    ]);
    const [summary] = await getAccountLots(ACCT);
    expect(summary.holdingPeriod).toBe('long_term');
  });

  it('exactly one year is SHORT term — "more than one year" is strict', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('lot-3', 1, [
        split('buy', '2023-05-10', 10, 1_000),
        split('sell', '2024-05-10', -10, -1_200),
      ]),
      lot('lot-4', 1, [
        split('buy2', '2023-05-10', 10, 1_000),
        split('sell2', '2024-05-11', -10, -1_200),
      ]),
    ]);
    const byGuid = new Map((await getAccountLots(ACCT)).map(s => [s.guid, s]));
    expect(byGuid.get('lot-3')!.holdingPeriod).toBe('short_term');
    expect(byGuid.get('lot-4')!.holdingPeriod).toBe('long_term');
  });

  it('a leap-year span of one year and a day is long_term', async () => {
    // 365-day arithmetic gets this wrong: 2024 is a leap year, so
    // 2024-01-01 -> 2025-01-02 is 367 days, but 2023-03-01 -> 2024-03-01 is 366
    // days yet still exactly one calendar year (short term).
    mockLotsFindMany.mockResolvedValue([
      lot('leap', 1, [
        split('buy', '2023-03-01', 10, 1_000),
        split('sell', '2024-03-01', -10, -1_200),
      ]),
    ]);
    const [summary] = await getAccountLots(ACCT);
    expect(summary.holdingPeriod).toBe('short_term');
  });
});

describe('open lots are still classified against today', () => {
  it('a lot opened decades ago and never sold is long_term', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('open-old', 0, [split('buy', '2010-01-01', 10, 1_000)]),
    ]);
    const [summary] = await getAccountLots(ACCT);
    expect(summary.isClosed).toBe(false);
    expect(summary.closeDate).toBeNull();
    expect(summary.holdingPeriod).toBe('long_term');
  });

  it('a lot opened today is short_term', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockLotsFindMany.mockResolvedValue([
      lot('open-new', 0, [split('buy', today, 10, 1_000)]),
    ]);
    const [summary] = await getAccountLots(ACCT);
    expect(summary.holdingPeriod).toBe('short_term');
  });
});

describe('the acquisition_date slot still wins over the open date', () => {
  it('a transferred lot uses its original acquisition date', async () => {
    mockLotsFindMany.mockResolvedValue([
      lot('transferred', 1, [
        split('in', '2024-11-01', 10, 1_000),
        split('sell', '2024-12-01', -10, -1_200),
      ]),
    ]);
    mockSlotsFindMany.mockImplementation(async (args: { where: { name: string } }) =>
      args.where.name === 'acquisition_date'
        ? [{ obj_guid: 'transferred', string_val: '2019-01-01T12:00:00.000Z' }]
        : [],
    );
    const [summary] = await getAccountLots(ACCT);
    // Acquired 2019, sold 2024 -> long term, even though the lot only opened
    // in the destination account a month before the sale.
    expect(summary.holdingPeriod).toBe('long_term');
  });
});
