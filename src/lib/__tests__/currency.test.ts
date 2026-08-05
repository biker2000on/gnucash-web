import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pricesFindFirst: vi.fn(),
  commoditiesFindFirst: vi.fn(),
  commoditiesFindUnique: vi.fn(),
}));

vi.mock('../prisma', () => ({
  default: {
    prices: { findFirst: mocks.pricesFindFirst },
    commodities: {
      findFirst: mocks.commoditiesFindFirst,
      findUnique: mocks.commoditiesFindUnique,
    },
  },
}));

vi.mock('../book-scope', () => ({ getActiveBookRootGuid: vi.fn() }));

import { convertAmount, findExchangeRate } from '../currency';

function price(
  from: string,
  to: string,
  value: number,
  date = new Date('2026-01-15T00:00:00.000Z'),
) {
  return {
    value_num: BigInt(Math.round(value * 1_000_000)),
    value_denom: 1_000_000n,
    date,
    source: 'test',
    commodity: { mnemonic: from },
    currency: { mnemonic: to },
  };
}

describe('currency exchange-rate lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pricesFindFirst.mockResolvedValue(null);
    mocks.commoditiesFindFirst.mockImplementation(({ where }: { where: { mnemonic?: string } }) => {
      if (where.mnemonic === 'USD') return { guid: 'usd', mnemonic: 'USD' };
      if (where.mnemonic === 'EUR') return { guid: 'eur', mnemonic: 'EUR' };
      return null;
    });
    mocks.commoditiesFindUnique.mockResolvedValue({ mnemonic: 'USD' });
  });

  it('returns a direct price selected at or before the requested date', async () => {
    const asOf = new Date('2026-02-01T00:00:00.000Z');
    const selected = price('CAD', 'USD', 0.72, new Date('2026-01-31T00:00:00.000Z'));
    mocks.pricesFindFirst.mockResolvedValueOnce(selected);

    const result = await findExchangeRate('cad', 'usd', asOf);

    expect(result).toMatchObject({ rate: 0.72, source: 'test' });
    expect(result?.date).toEqual(selected.date);
    expect(mocks.pricesFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ date: { lte: asOf } }),
      orderBy: { date: 'desc' },
    }));
  });

  it('inverts a reverse price', async () => {
    mocks.pricesFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(price('USD', 'CAD', 1.25));

    const result = await findExchangeRate('cad', 'usd');

    expect(result?.rate).toBeCloseTo(0.8);
    expect(result?.source).toBe('inverse:test');
  });

  it('triangulates through USD using direct-only legs', async () => {
    mocks.pricesFindFirst.mockImplementation(({ where }: {
      where: { commodity_guid: string; currency_guid: string };
    }) => {
      const key = `${where.commodity_guid}->${where.currency_guid}`;
      if (key === 'cad->usd') return price('CAD', 'USD', 0.75);
      if (key === 'usd->gbp') return price('USD', 'GBP', 0.8);
      return null;
    });

    const result = await findExchangeRate('cad', 'gbp');

    expect(result?.source).toBe('triangulated:USD');
    expect(result?.rate).toBeCloseTo(0.6, 12);
  });

  it('returns null within a bounded number of queries when no path exists', async () => {
    const result = await findExchangeRate('missing', 'usd');

    expect(result).toBeNull();
    expect(mocks.pricesFindFirst.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('converts amounts and preserves the selected rate evidence', async () => {
    mocks.pricesFindFirst.mockResolvedValueOnce(price('EUR', 'USD', 1.1));

    const result = await convertAmount(250, 'eur', 'usd');

    expect(result?.amount).toBeCloseTo(275);
    expect(result?.rate.fromCurrency).toBe('EUR');
  });

  it('returns null from convertAmount when no rate exists', async () => {
    await expect(convertAmount(10, 'missing', 'usd')).resolves.toBeNull();
  });
});
