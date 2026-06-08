import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetBaseCurrency = vi.fn();
const mockFindExchangeRate = vi.fn();
const mockGetLatestPrice = vi.fn();

vi.mock('@/lib/currency', () => ({
  getBaseCurrency: (...args: unknown[]) => mockGetBaseCurrency(...args),
  findExchangeRate: (...args: unknown[]) => mockFindExchangeRate(...args),
}));

vi.mock('@/lib/commodities', () => ({
  getLatestPrice: (...args: unknown[]) => mockGetLatestPrice(...args),
}));

import { buildAccountValuationContext } from '../account-valuation';

const USD = {
  guid: 'usd-guid',
  mnemonic: 'USD',
  fullname: 'US Dollar',
  fraction: 100,
};

describe('buildAccountValuationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBaseCurrency.mockResolvedValue(USD);
  });

  it('converts cash currency accounts into the report currency', async () => {
    mockFindExchangeRate.mockResolvedValue({
      fromCurrency: 'IDR',
      toCurrency: 'USD',
      rate: 0.000061,
      date: new Date('2026-06-01'),
      source: 'user:price-db',
    });

    const valuation = await buildAccountValuationContext([
      {
        accountType: 'CASH',
        commodityGuid: 'idr-guid',
        commodityNamespace: 'CURRENCY',
      },
    ]);

    expect(1123000 * valuation.getMultiplier({
      accountType: 'CASH',
      commodityGuid: 'idr-guid',
      commodityNamespace: 'CURRENCY',
    })).toBeCloseTo(68.503);
    expect(mockFindExchangeRate).toHaveBeenCalledWith('idr-guid', 'usd-guid', undefined);
  });

  it('leaves report-currency cash accounts at face value', async () => {
    const valuation = await buildAccountValuationContext([
      {
        accountType: 'BANK',
        commodityGuid: 'usd-guid',
        commodityNamespace: 'CURRENCY',
      },
    ]);

    expect(valuation.getMultiplier({
      accountType: 'BANK',
      commodityGuid: 'usd-guid',
      commodityNamespace: 'CURRENCY',
    })).toBe(1);
    expect(mockFindExchangeRate).not.toHaveBeenCalled();
  });

  it('continues valuing investment accounts with latest report-currency prices', async () => {
    const asOfDate = new Date('2026-06-08');
    mockGetLatestPrice.mockResolvedValue({
      guid: 'price-guid',
      date: asOfDate,
      value: 123.45,
      source: 'yahoo',
    });

    const valuation = await buildAccountValuationContext([
      {
        accountType: 'STOCK',
        commodityGuid: 'stock-guid',
        commodityNamespace: 'NASDAQ',
      },
    ], asOfDate);

    expect(valuation.getMultiplier({
      accountType: 'STOCK',
      commodityGuid: 'stock-guid',
      commodityNamespace: 'NASDAQ',
    })).toBe(123.45);
    expect(mockGetLatestPrice).toHaveBeenCalledWith('stock-guid', 'usd-guid', asOfDate);
  });
});
