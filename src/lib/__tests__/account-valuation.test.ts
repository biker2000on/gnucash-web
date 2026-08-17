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
import {
  buildAccountValuationContext,
  collectValuationCoverage,
  mergeValuationCoverage,
} from '../account-valuation';
import {
  CONTINUOUS_STALENESS_DAYS,
  CONTINUOUS_WEEKEND_EVIDENCE,
  PRICE_STALENESS_DAYS,
} from '../price-staleness';

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

function pricePair(
  commodityGuid: string,
  currencyGuid: string,
  value: number,
  opts: { date?: Date; commodityMnemonic?: string; continuousWeekends?: number } = {},
) {
  const denom = 1000000;
  return {
    commodity_guid: commodityGuid,
    currency_guid: currencyGuid,
    commodity_mnemonic: opts.commodityMnemonic ?? commodityGuid,
    currency_mnemonic: currencyGuid,
    value_num: BigInt(Math.round(value * denom)),
    value_denom: BigInt(denom),
    date: opts.date ?? null,
    // COUNT() arrives from Postgres as a bigint, so the double sends one.
    continuous_weekends: BigInt(opts.continuousWeekends ?? 0),
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

  describe('price staleness', () => {
    const ASOF = new Date('2026-08-17T13:00:00.000Z');
    const stock = {
      accountType: 'STOCK',
      commodityGuid: 'stock-guid',
      commodityNamespace: 'NASDAQ',
    };

    it('says nothing about a quote from the last trading session', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: new Date('2026-08-14T20:00:00.000Z'),
          commodityMnemonic: 'AAPL',
        }),
      ]);

      const valuation = await buildAccountValuationContext([stock], ASOF, USD);

      expect(valuation.getMultiplier(stock)).toBe(123.45);
      expect(valuation.stalePrices).toEqual([]);
    });

    it('says nothing about a quote sitting exactly on the bound', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: new Date(ASOF.getTime() - PRICE_STALENESS_DAYS * 86_400_000),
          commodityMnemonic: 'AAPL',
        }),
      ]);

      const valuation = await buildAccountValuationContext([stock], ASOF, USD);

      expect(valuation.stalePrices).toEqual([]);
    });

    it('discloses a quote past the bound while still valuing the holding', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: new Date('2026-06-01T00:00:00.000Z'),
          commodityMnemonic: 'AAPL',
        }),
      ]);

      const valuation = await buildAccountValuationContext([stock], ASOF, USD);

      // Still valued -- an unpriced portfolio is a worse answer than a priced
      // one with the age of the quote stated.
      expect(valuation.getMultiplier(stock)).toBe(123.45);
      expect(valuation.isConvertible?.(stock)).toBe(true);
      expect(valuation.stalePrices).toEqual([
        expect.objectContaining({
          commodityGuid: 'stock-guid',
          label: 'AAPL',
          priceDate: '2026-06-01',
          ageDays: 77,
        }),
      ]);
      expect(valuation.stalePrices?.[0].message).toContain('AAPL');
      expect(valuation.stalePrices?.[0].message).toContain('77 days old');
    });

    it('holds a continuously-traded commodity to its own, tighter bound', async () => {
      // Same quote date, same as-of date, two verdicts. Four days back: within
      // the gap a closed exchange can explain over a long weekend, and four days
      // of trading nobody recorded on a market that never shut.
      const friday = new Date('2026-08-12T20:00:00.000Z');
      const btc = {
        accountType: 'STOCK',
        commodityGuid: 'btc-guid',
        commodityNamespace: 'CRYPTO',
      };
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: friday,
          commodityMnemonic: 'AAPL',
        }),
        pricePair('btc-guid', 'usd-guid', 61000, {
          date: friday,
          commodityMnemonic: 'BTC',
        }),
      ]);

      const valuation = await buildAccountValuationContext([stock, btc], ASOF, USD);

      // Both still valued; only one is disclosed as old.
      expect(valuation.getMultiplier(btc)).toBe(61000);
      expect(valuation.stalePrices).toEqual([
        expect.objectContaining({ commodityGuid: 'btc-guid', label: 'BTC' }),
      ]);
      expect(valuation.stalePrices?.[0].message).toContain(
        `older than ${CONTINUOUS_STALENESS_DAYS} days`,
      );
    });

    it('applies the tighter bound to crypto filed under a made-up namespace', async () => {
      // `commodities.namespace` is free text and the commodities API accepts
      // any string, so an imported book's crypto may be filed under a wallet
      // name. That namespace names no venue, so the price history decides —
      // complete weekends of fetched quotes, which only a market that stayed
      // open produces.
      const btc = {
        accountType: 'STOCK',
        commodityGuid: 'btc-guid',
        commodityNamespace: 'Ledger Nano X',
      };
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('btc-guid', 'usd-guid', 61000, {
          date: new Date(ASOF.getTime() - 4 * 86_400_000),
          commodityMnemonic: 'BTC',
          continuousWeekends: CONTINUOUS_WEEKEND_EVIDENCE,
        }),
      ]);

      const valuation = await buildAccountValuationContext([btc], ASOF, USD);

      expect(valuation.stalePrices).toEqual([
        expect.objectContaining({ commodityGuid: 'btc-guid', label: 'BTC', ageDays: 4 }),
      ]);
      expect(valuation.stalePrices?.[0].message).toContain(
        `older than ${CONTINUOUS_STALENESS_DAYS} days`,
      );
    });

    it('keeps the exchange bound for a security with no weekend quotes', async () => {
      // The same four-day gap, on an instrument whose history shows it stops
      // for the weekend: within what the calendar explains, so nothing is said.
      const stockAcct = {
        accountType: 'STOCK',
        commodityGuid: 'stock-guid',
        commodityNamespace: 'Fidelity Import',
      };
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: new Date(ASOF.getTime() - 4 * 86_400_000),
          commodityMnemonic: 'AAPL',
          continuousWeekends: 0,
        }),
      ]);

      const valuation = await buildAccountValuationContext([stockAcct], ASOF, USD);

      expect(valuation.stalePrices).toEqual([]);
    });

    it('keeps the exchange bound for a listed security whose history has weekend rows', async () => {
      // The namespace names a venue with a weekend, so it is authoritative and
      // the history is not consulted. Weekend-dated rows reach a listed
      // security's price table by several ordinary routes — a week-ending
      // custodian import, a monthly valuation, a timezone-shifted timestamp —
      // and none of them mean NASDAQ opened on a Saturday. Letting them decide
      // would put a recurring four-day warning on a healthy equity, which is the
      // cry-wolf failure the looser bound exists to prevent.
      const stockAcct = {
        accountType: 'STOCK',
        commodityGuid: 'nasdaq-guid',
        commodityNamespace: 'NASDAQ',
      };
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('nasdaq-guid', 'usd-guid', 61000, {
          date: new Date(ASOF.getTime() - 4 * 86_400_000),
          // A crypto ticker too: a spot-crypto ETF is exactly this shape.
          commodityMnemonic: 'BTC',
          continuousWeekends: 13,
        }),
      ]);

      const valuation = await buildAccountValuationContext([stockAcct], ASOF, USD);

      expect(valuation.stalePrices).toEqual([]);
    });

    it('leaves a crypto quote inside the tighter bound alone', async () => {
      const btc = {
        accountType: 'STOCK',
        commodityGuid: 'btc-guid',
        commodityNamespace: 'CRYPTO',
      };
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('btc-guid', 'usd-guid', 61000, {
          date: new Date(ASOF.getTime() - CONTINUOUS_STALENESS_DAYS * 86_400_000),
          commodityMnemonic: 'BTC',
        }),
      ]);

      const valuation = await buildAccountValuationContext([btc], ASOF, USD);

      expect(valuation.stalePrices).toEqual([]);
    });

    it('discloses a stale exchange rate for a foreign-currency balance', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('eur-guid', 'usd-guid', 1.08, {
          date: new Date('2026-06-01T00:00:00.000Z'),
          commodityMnemonic: 'EUR',
        }),
      ]);

      const cash = {
        accountType: 'CASH',
        commodityGuid: 'eur-guid',
        commodityNamespace: 'CURRENCY',
      };
      const valuation = await buildAccountValuationContext([cash], ASOF, USD);

      expect(valuation.getMultiplier(cash)).toBeCloseTo(1.08);
      expect(valuation.stalePrices).toHaveLength(1);
      expect(valuation.stalePrices?.[0].commodityGuid).toBe('eur-guid');
    });

    it('dates a triangulated rate by its older leg', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('gbp-guid', 'eur-guid', 1.17, {
          date: new Date('2026-08-16T00:00:00.000Z'),
          commodityMnemonic: 'GBP',
        }),
        pricePair('eur-guid', 'usd-guid', 1.08, {
          date: new Date('2026-06-01T00:00:00.000Z'),
          commodityMnemonic: 'EUR',
        }),
      ]);

      const cash = {
        accountType: 'CASH',
        commodityGuid: 'gbp-guid',
        commodityNamespace: 'CURRENCY',
      };
      const valuation = await buildAccountValuationContext([cash], ASOF, USD);

      expect(valuation.getMultiplier(cash)).toBeCloseTo(1.17 * 1.08);
      // A fresh GBP->EUR leg does not make the GBP->USD product fresh.
      expect(valuation.stalePrices).toEqual([
        expect.objectContaining({ commodityGuid: 'gbp-guid', priceDate: '2026-06-01' }),
      ]);
    });

    it('carries the disclosure into the coverage record the statements render', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: new Date('2026-06-01T00:00:00.000Z'),
          commodityMnemonic: 'AAPL',
        }),
      ]);

      const valuation = await buildAccountValuationContext([stock], ASOF, USD);
      const coverage = collectValuationCoverage(valuation, [
        { account: stock, quantity: 100 },
      ]);

      // The total is whole -- nothing was excluded -- but it rests on an old quote.
      expect(coverage.complete).toBe(true);
      expect(coverage.stalePrices).toHaveLength(1);
      expect(coverage.stalePrices[0].label).toBe('AAPL');
    });

    it('keeps a stale quote for a closed position out of the disclosure', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        pricePair('stock-guid', 'usd-guid', 123.45, {
          date: new Date('2026-06-01T00:00:00.000Z'),
          commodityMnemonic: 'AAPL',
        }),
      ]);

      const valuation = await buildAccountValuationContext([stock], ASOF, USD);
      const coverage = collectValuationCoverage(valuation, [
        { account: stock, quantity: 0 },
      ]);

      // A dead commodity cannot move a total it does not appear in.
      expect(coverage.stalePrices).toEqual([]);
    });

    it('unions stale disclosures across two merged coverages', async () => {
      const a = {
        complete: true,
        unvaluedAccountCount: 0,
        gaps: [],
        stalePrices: [{
          commodityGuid: 'stock-guid',
          label: 'AAPL',
          priceDate: '2026-06-01',
          ageDays: 77,
          message: 'AAPL message',
        }],
      };
      const b = {
        complete: true,
        unvaluedAccountCount: 0,
        gaps: [],
        stalePrices: [
          {
            commodityGuid: 'stock-guid',
            label: 'AAPL',
            priceDate: '2026-06-01',
            ageDays: 77,
            message: 'AAPL message',
          },
          {
            commodityGuid: 'eur-guid',
            label: 'EUR',
            priceDate: '2026-05-01',
            ageDays: 108,
            message: 'EUR message',
          },
        ],
      };

      const merged = mergeValuationCoverage(a, b);

      expect(merged.stalePrices.map(s => s.commodityGuid)).toEqual(['stock-guid', 'eur-guid']);
    });
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
