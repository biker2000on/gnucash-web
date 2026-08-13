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

const EUR = {
  guid: 'eur-guid',
  mnemonic: 'EUR',
  fullname: 'Euro',
  fraction: 100,
};

const GBP = {
  guid: 'gbp-guid',
  mnemonic: 'GBP',
  fullname: 'Pound Sterling',
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

  it('triangulates securities quoted in a currency other than the report currency', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      pricePair('vti-guid', 'usd-guid', 250),
      pricePair('gbp-guid', 'usd-guid', 1.25),
    ]);

    const stock = {
      accountType: 'STOCK',
      commodityGuid: 'vti-guid',
      commodityNamespace: 'NASDAQ',
    };

    const valuation = await buildAccountValuationContext([stock], new Date('2026-07-28'), GBP);

    // USD 250/share at USD->GBP 0.8 is GBP 200/share, not GBP 0.
    expect(valuation.getMultiplier(stock)).toBeCloseTo(200);
    expect(valuation.isConvertible?.(stock)).toBe(true);
    expect(valuation.warnings).toEqual([]);
  });

  it('flags securities with no price path instead of silently valuing them at zero', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const stock = {
      accountType: 'STOCK',
      commodityGuid: 'illiquid-guid',
      commodityNamespace: 'PRIVATE',
    };

    const valuation = await buildAccountValuationContext([stock], new Date('2026-07-28'), GBP);

    expect(valuation.getMultiplier(stock)).toBe(0);
    expect(valuation.isConvertible?.(stock)).toBe(false);
    expect(valuation.warnings).toHaveLength(1);
    expect(valuation.warnings?.[0]).toContain('illiquid-guid');
    expect(valuation.warnings?.[0]).toContain('GBP');
  });

  it('reports an unpriceable holding as an explicit valuation gap', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.commodities.findMany.mockImplementation(((args: {
      where: { guid?: { in: string[] } };
    }) => Promise.resolve(
      args.where.guid
        ? [{ guid: 'illiquid-guid', mnemonic: 'PRIVCO' }]
        : [{ guid: 'usd-guid' }, { guid: 'eur-guid' }],
    )) as never);

    const stock = {
      accountType: 'STOCK',
      commodityGuid: 'illiquid-guid',
      commodityNamespace: 'PRIVATE',
    };

    const valuation = await buildAccountValuationContext([stock], new Date('2026-07-28'), USD);

    // The 0 multiplier means "not valued", and the gap says so out loud with
    // the symbol the user recognizes rather than a raw GUID.
    expect(valuation.gaps).toEqual([
      {
        commodityGuid: 'illiquid-guid',
        label: 'PRIVCO',
        reason: 'missing-security-price',
        message: 'PRIVCO excluded: no price path to USD as of 2026-07-28.',
      },
    ]);
    expect(valuation.isConvertible?.(stock)).toBe(false);
  });

  it('never presents a missing exchange rate as a real 1:1 conversion', async () => {
    // No price rows at all: there is no IDR->USD rate on or before the date.
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const cash = {
      accountType: 'CASH',
      commodityGuid: 'idr-guid',
      commodityNamespace: 'CURRENCY',
    };

    const valuation = await buildAccountValuationContext([cash], new Date('2026-07-28'), USD);

    // Pre-fix this returned 1, silently reporting 1,123,000 IDR as $1,123,000.
    expect(valuation.getMultiplier(cash)).not.toBe(1);
    expect(valuation.isConvertible?.(cash)).toBe(false);
    expect(valuation.gaps).toEqual([
      {
        commodityGuid: 'idr-guid',
        label: 'idr-guid',
        reason: 'missing-exchange-rate',
        message: 'idr-guid excluded: no exchange rate to USD as of 2026-07-28; a 1:1 rate is never assumed.',
      },
    ]);
  });

  it('reports no gaps and no extra queries when every price and rate is available', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      pricePair('idr-guid', 'usd-guid', 0.000061),
      pricePair('stock-guid', 'usd-guid', 123.45),
    ]);

    const cash = {
      accountType: 'CASH',
      commodityGuid: 'idr-guid',
      commodityNamespace: 'CURRENCY',
    };
    const bank = {
      accountType: 'BANK',
      commodityGuid: 'usd-guid',
      commodityNamespace: 'CURRENCY',
    };
    const stock = {
      accountType: 'STOCK',
      commodityGuid: 'stock-guid',
      commodityNamespace: 'NASDAQ',
    };
    const house = {
      accountType: 'ASSET',
      commodityGuid: 'usd-guid',
      commodityNamespace: 'CURRENCY',
    };

    const valuation = await buildAccountValuationContext(
      [cash, bank, stock, house],
      new Date('2026-07-28'),
    );

    expect(valuation.getMultiplier(cash)).toBeCloseTo(0.000061);
    expect(valuation.getMultiplier(bank)).toBe(1);
    expect(valuation.getMultiplier(stock)).toBe(123.45);
    expect(valuation.getMultiplier(house)).toBe(1);
    expect(valuation.isConvertible?.(cash)).toBe(true);
    expect(valuation.isConvertible?.(stock)).toBe(true);
    expect(valuation.gaps).toEqual([]);
    expect(valuation.warnings).toEqual([]);
    // One price query and one pivot lookup -- no mnemonic backfill happens
    // when nothing is missing.
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.commodities.findMany).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit report currency for cross-book valuation', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      pricePair('gbp-guid', 'eur-guid', 1.17),
    ]);

    const valuation = await buildAccountValuationContext([
      {
        accountType: 'CASH',
        commodityGuid: 'gbp-guid',
        commodityNamespace: 'CURRENCY',
      },
    ], new Date('2026-07-28'), EUR);

    expect(valuation.reportCurrencyMnemonic).toBe('EUR');
    expect(valuation.getMultiplier({
      accountType: 'CASH',
      commodityGuid: 'gbp-guid',
      commodityNamespace: 'CURRENCY',
    })).toBeCloseTo(1.17);
    expect(mockGetBaseCurrency).not.toHaveBeenCalled();
  });
});
