import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: vi.fn(),
    commodities: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/currency', () => ({
  getBaseCurrency: vi.fn(),
}));

import prisma from '@/lib/prisma';
import { getBaseCurrency } from '@/lib/currency';
import { buildAccountValuationContext } from '../account-valuation';

const mockPrisma = prisma as unknown as {
  $queryRaw: Mock;
  commodities: { findMany: Mock };
};
const mockGetBaseCurrency = vi.mocked(getBaseCurrency);

const USD = {
  guid: 'usd-guid',
  mnemonic: 'USD',
  fullname: 'US Dollar',
  fraction: 100,
};

function pricePair(commodityGuid: string, currencyGuid: string, value: number) {
  const denom = 1000000;
  return {
    commodity_guid: commodityGuid,
    currency_guid: currencyGuid,
    commodity_mnemonic: commodityGuid,
    currency_mnemonic: currencyGuid,
    value_num: BigInt(Math.round(value * denom)),
    value_denom: BigInt(denom),
  };
}

describe('buildAccountValuationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBaseCurrency.mockResolvedValue(USD);
    mockPrisma.commodities.findMany.mockResolvedValue([
      { guid: 'usd-guid' },
      { guid: 'eur-guid' },
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([]);
  });

  it('converts cash currency accounts into the report currency', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      pricePair('idr-guid', 'usd-guid', 0.000061),
    ]);

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
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
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
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('triangulates currency rates through configured pivot currencies', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      pricePair('gbp-guid', 'eur-guid', 1.17),
      pricePair('eur-guid', 'usd-guid', 1.08),
    ]);

    const valuation = await buildAccountValuationContext([
      {
        accountType: 'CASH',
        commodityGuid: 'gbp-guid',
        commodityNamespace: 'CURRENCY',
      },
    ]);

    expect(valuation.getMultiplier({
      accountType: 'CASH',
      commodityGuid: 'gbp-guid',
      commodityNamespace: 'CURRENCY',
    })).toBeCloseTo(1.2636);
  });

  it('continues valuing investment accounts with latest report-currency prices', async () => {
    const asOfDate = new Date('2026-06-08');
    mockPrisma.$queryRaw.mockResolvedValue([
      pricePair('stock-guid', 'usd-guid', 123.45),
    ]);

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
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
