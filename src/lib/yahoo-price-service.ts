/**
 * Yahoo Finance Price Service
 *
 * Service for fetching historical closing prices from Yahoo Finance
 * and storing them in the GnuCash prices table.
 *
 * DESIGN RULE: Only historical closing prices are stored.
 * The most recent price is the latest available close. No real-time quotes.
 *
 * Uses the yahoo-finance2 package which requires no API key.
 */

import YahooFinance from 'yahoo-finance2';
import { Prisma } from '@prisma/client';
import { getCurrencyByMnemonic } from './currency';
import { fromDecimal, generateGuid } from './prisma';
import { yahooSymbolFor } from './yahoo-symbol';

export { yahooSymbolFor };

/**
 * Denominator for stored price quotes. Prices need higher precision than a
 * currency's 1/100 fraction so sub-cent assets (many cryptos) don't round to
 * zero. 1e8 keeps num within int64 for any realistic price.
 */
export const PRICE_DENOM = 100_000_000;

/**
 * Result of a price fetch operation for a single symbol
 */
export interface PriceFetchResult {
  symbol: string;
  pricesStored: number;
  dateRange: { from: string; to: string } | null;
  success: boolean;
  error?: string;
}

/**
 * Commodity that can be quoted (has quote_flag=1 and is not a currency)
 */
export interface QuotableCommodity {
  guid: string;
  mnemonic: string;
  namespace: string;
  fullname: string | null;
}

/**
 * Result summary from fetchAndStorePrices operation
 */
export interface FetchAndStoreResult {
  stored: number;
  backfilled: number;
  gapsFilled: number;
  failed: number;
  results: PriceFetchResult[];
}

/**
 * Compute the earliest date affected by a fetchAndStorePrices run so cached
 * dashboard metrics can be invalidated from that date forward. Per-symbol
 * dateRange covers backfilled prices; gap fills are not date-tracked but are
 * bounded by the 3-month lookback window, so fall back to 3 months ago when
 * gaps were filled (or when prices were stored without a tracked range).
 * Returns null when nothing was stored.
 */
export function earliestBackfilledDate(result: FetchAndStoreResult): Date | null {
  if (result.stored <= 0) return null;

  let earliest: Date | null = null;
  for (const r of result.results) {
    if (r.success && r.dateRange) {
      const from = new Date(r.dateRange.from);
      if (!earliest || from < earliest) earliest = from;
    }
  }

  if (result.gapsFilled > 0 || !earliest) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
    if (!earliest || threeMonthsAgo < earliest) earliest = threeMonthsAgo;
  }

  return earliest;
}

export interface AuditPricesResult {
  stored: number;
  audited: number;
  failed: number;
  results: PriceFetchResult[];
}

/**
 * A single historical price row returned from Yahoo Finance
 */
interface HistoricalPriceRow {
  date: Date;
  close: number;
}

/**
 * Format a Date as YYYY-MM-DD string (UTC)
 */
function formatDateYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}


/**
 * Get the date of the most recent stored price for a commodity
 * @param commodityGuid GUID of the commodity
 * @returns The latest price date, or null if no prices exist
 */
export async function getLastPriceDate(commodityGuid: string): Promise<Date | null> {
  const { default: prisma } = await import('./prisma');

  const latestPrice = await prisma.prices.findFirst({
    where: { commodity_guid: commodityGuid },
    orderBy: { date: 'desc' },
    select: { date: true },
  });

  return latestPrice?.date ?? null;
}

/**
 * Get the earliest stored price date for a commodity.
 */
async function getFirstPriceDate(commodityGuid: string): Promise<Date | null> {
  const { default: prisma } = await import('./prisma');

  const firstPrice = await prisma.prices.findFirst({
    where: { commodity_guid: commodityGuid },
    orderBy: { date: 'asc' },
    select: { date: true },
  });

  return firstPrice?.date ?? null;
}

/**
 * Get the earliest transaction date for accounts using a commodity.
 */
async function getFirstCommodityTransactionDate(commodityGuid: string): Promise<Date | null> {
  const { default: prisma } = await import('./prisma');

  const accounts = await prisma.accounts.findMany({
    where: {
      commodity_guid: commodityGuid,
      account_type: { in: ['STOCK', 'MUTUAL'] },
    },
    select: { guid: true },
  });

  if (accounts.length === 0) {
    return null;
  }

  const firstSplit = await prisma.splits.findFirst({
    where: {
      account_guid: { in: accounts.map((account) => account.guid) },
    },
    orderBy: {
      transaction: {
        post_date: 'asc',
      },
    },
    select: {
      transaction: {
        select: {
          post_date: true,
        },
      },
    },
  });

  return firstSplit?.transaction.post_date ?? null;
}

/**
 * Determine the earliest date that should have historical prices for a commodity.
 */
async function getCommodityAuditStartDate(commodityGuid: string): Promise<Date> {
  const [firstTransactionDate, firstPriceDate] = await Promise.all([
    getFirstCommodityTransactionDate(commodityGuid),
    getFirstPriceDate(commodityGuid),
  ]);

  const candidates = [firstTransactionDate, firstPriceDate].filter((date): date is Date => Boolean(date));
  if (candidates.length > 0) {
    const earliest = new Date(Math.min(...candidates.map((date) => date.getTime())));
    earliest.setUTCHours(0, 0, 0, 0);
    return earliest;
  }

  const fallback = new Date();
  fallback.setUTCMonth(fallback.getUTCMonth() - 3);
  fallback.setUTCHours(0, 0, 0, 0);
  return fallback;
}

/**
 * Get a Set of YYYY-MM-DD date strings for all existing prices in a range.
 * The prices table's unique index (uq_prices_commodity_currency_date) is per
 * exact timestamp, not per calendar day, so we still deduplicate by checking
 * existing DATES before every insert (and storeFetchedPrice's ON CONFLICT
 * handles the same-instant race).
 *
 * @param commodityGuid GUID of the commodity
 * @param startDate Start of range (inclusive)
 * @param endDate End of range (inclusive)
 * @returns Set of date strings in YYYY-MM-DD format
 */
export async function getExistingPriceDates(
  commodityGuid: string,
  startDate: Date,
  endDate: Date
): Promise<Set<string>> {
  const { default: prisma } = await import('./prisma');

  const existing = await prisma.prices.findMany({
    where: {
      commodity_guid: commodityGuid,
      date: { gte: startDate, lte: endDate },
    },
    select: { date: true },
  });

  const dateSet = new Set<string>();
  for (const row of existing) {
    dateSet.add(formatDateYMD(row.date));
  }
  return dateSet;
}

/**
 * Fetch historical closing prices from Yahoo Finance.
 * Uses yahooFinance.chart() (migrated from deprecated historical() endpoint).
 *
 * @param symbol Stock ticker symbol
 * @param startDate Start date (inclusive)
 * @param endDate End date (inclusive)
 * @returns Array of { date, close } objects
 */
export async function fetchHistoricalPrices(
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<HistoricalPriceRow[]> {
  const yahooFinance = new YahooFinance();

  const result = await yahooFinance.chart(symbol, {
    period1: startDate,
    period2: endDate,
    interval: '1d',
  });

  // chart() returns { quotes: Array<{ date, open, high, low, close, volume }> }
  // Filter out today's date only if the US market is still open (before 9 PM UTC,
  // which covers 4 PM EST / 5 PM EDT close). After market close, today's bar is final.
  const now = new Date();
  const todayStr = formatDateYMD(now);
  const marketClosed = now.getUTCHours() >= 21; // 9 PM UTC = after US market close
  const quotes = result.quotes ?? [];
  return quotes
    .filter((q) => {
      if (typeof q.close !== 'number' || q.close <= 0) return false;
      if (!marketClosed && formatDateYMD(q.date) === todayStr) return false;
      return true;
    })
    .map((q) => ({ date: q.date, close: q.close as number }));
}

/**
 * Detect and fill gaps in stored price history for a commodity.
 * Fetches existing dates, gets historical prices from Yahoo, and stores only missing dates.
 * Uses now as the upper bound to capture the most recent market close.
 *
 * @param commodityGuid GUID of the commodity
 * @param symbol Stock ticker symbol
 * @param lookbackMonths Number of months to look back for gaps (default 3)
 * @returns Number of gap prices filled
 */
export async function detectAndFillGaps(
  commodityGuid: string,
  symbol: string,
  lookbackMonths: number = 3,
  currencyGuid?: string,
): Promise<number> {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setUTCMonth(startDate.getUTCMonth() - lookbackMonths);

  // Get all existing dates in the range
  const existingDates = await getExistingPriceDates(commodityGuid, startDate, endDate);

  // If no existing prices at all, skip gap detection (backfill should handle it)
  if (existingDates.size === 0) {
    return 0;
  }

  // Fetch historical prices for the full range
  let historicalPrices: HistoricalPriceRow[];
  try {
    historicalPrices = await fetchHistoricalPrices(symbol, startDate, endDate);
  } catch (err) {
    console.warn(`Gap detection: failed to fetch historical prices for ${symbol}:`, err);
    return 0;
  }

  const quoteCurrency = currencyGuid ?? (await getCurrencyByMnemonic('USD'))?.guid;
  if (!quoteCurrency) return 0;
  return (await storeMissingHistoricalPrices(
    commodityGuid,
    symbol,
    historicalPrices,
    existingDates,
    quoteCurrency,
  )).count;
}

/**
 * Fetch batch quotes from Yahoo Finance (real-time).
 * KEPT AS UTILITY but NOT used by fetchAndStorePrices.
 * Only historical closing prices are stored in the database.
 *
 * @param symbols Array of stock symbols to fetch
 * @returns Array of raw quote results
 */
export async function fetchBatchQuotes(symbols: string[]): Promise<Array<{
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  timestamp: Date;
  success: boolean;
  error?: string;
}>> {
  if (symbols.length === 0) {
    return [];
  }

  const results: Array<{
    symbol: string;
    price: number;
    previousClose: number;
    change: number;
    changePercent: number;
    timestamp: Date;
    success: boolean;
    error?: string;
  }> = [];

  try {
    const yahooFinance = new YahooFinance();
    const quotes = await yahooFinance.quote(symbols);

    const quotesMap = new Map<string, typeof quotes[number]>();
    for (const quote of quotes) {
      if (quote && quote.symbol) {
        quotesMap.set(quote.symbol.toUpperCase(), quote);
      }
    }

    for (const symbol of symbols) {
      const quote = quotesMap.get(symbol.toUpperCase());

      if (quote && typeof quote.regularMarketPrice === 'number') {
        results.push({
          symbol: symbol,
          price: quote.regularMarketPrice,
          previousClose: quote.regularMarketPreviousClose || 0,
          change: quote.regularMarketChange || 0,
          changePercent: quote.regularMarketChangePercent || 0,
          timestamp: quote.regularMarketTime
            ? new Date(quote.regularMarketTime)
            : new Date(),
          success: true,
        });
      } else {
        results.push({
          symbol: symbol,
          price: 0,
          previousClose: 0,
          change: 0,
          changePercent: 0,
          timestamp: new Date(),
          success: false,
          error: 'Symbol not found or invalid response',
        });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Yahoo Finance batch quote error:', errorMessage);

    for (const symbol of symbols) {
      results.push({
        symbol: symbol,
        price: 0,
        previousClose: 0,
        change: 0,
        changePercent: 0,
        timestamp: new Date(),
        success: false,
        error: errorMessage,
      });
    }
  }

  return results;
}

/**
 * Get commodities that can be quoted from Yahoo Finance
 * (have quote_flag=1 and are not in CURRENCY namespace)
 * @returns Array of quotable commodities
 */
export async function getQuotableCommodities(): Promise<QuotableCommodity[]> {
  const { default: prisma } = await import('./prisma');

  const commodities = await prisma.commodities.findMany({
    where: {
      quote_flag: 1,
      NOT: {
        namespace: 'CURRENCY',
      },
    },
    select: {
      guid: true,
      mnemonic: true,
      namespace: true,
      fullname: true,
    },
  });

  return commodities;
}

/**
 * Store a fetched price in the GnuCash prices table
 * @param commodityGuid GUID of the commodity
 * @param symbol Symbol of the commodity (for logging)
 * @param price Price value
 * @param date Date of the price
 * @returns The created price GUID, or null if storage failed
 */
export async function storeFetchedPrice(
  commodityGuid: string,
  symbol: string,
  price: number,
  date: Date
): Promise<string | null> {
  const stored = await storeFetchedPrices([{ commodityGuid, symbol, price, date }]);
  return stored.get(`${commodityGuid}:${formatDateYMD(date)}`) ?? null;
}

interface FetchedPriceInput {
  commodityGuid: string;
  symbol: string;
  price: number;
  date: Date;
}

/** Store fetched quotes in chunks while preserving the user-price conflict guard. */
export async function storeFetchedPrices(
  inputs: FetchedPriceInput[],
  currencyGuid?: string,
): Promise<Map<string, string>> {
  const { default: prisma } = await import('./prisma');

  if (inputs.length === 0) return new Map();
  let quoteCurrencyGuid = currencyGuid;
  if (!quoteCurrencyGuid) {
    const usd = await getCurrencyByMnemonic('USD');
    quoteCurrencyGuid = usd?.guid;
  }
  if (!quoteCurrencyGuid) {
    console.error('Cannot store fetched prices: USD currency not found');
    return new Map();
  }

  const stored = new Map<string, string>();
  for (let offset = 0; offset < inputs.length; offset += 500) {
    const chunk = inputs.slice(offset, offset + 500).map(input => {
      const { num, denom } = fromDecimal(input.price, PRICE_DENOM);
      return {
        ...input,
        guid: generateGuid(),
        num,
        denom,
      };
    });
    try {
      const values = Prisma.join(chunk.map(input => Prisma.sql`(
        ${input.guid}, ${input.commodityGuid}, ${quoteCurrencyGuid}, ${input.date},
        'Finance::Quote', 'last', ${input.num}, ${input.denom}
      )`));
      const rows = await prisma.$queryRaw<Array<{
        guid: string;
        commodity_guid: string;
        date: Date;
      }>>(Prisma.sql`
        INSERT INTO prices
          (guid, commodity_guid, currency_guid, date, source, type, value_num, value_denom)
        VALUES ${values}
        ON CONFLICT (commodity_guid, currency_guid, date)
        DO UPDATE SET value_num = EXCLUDED.value_num, value_denom = EXCLUDED.value_denom
        WHERE prices.source = 'Finance::Quote'
        RETURNING guid, commodity_guid, date
      `);
      for (const row of rows) {
        stored.set(`${row.commodity_guid}:${formatDateYMD(row.date)}`, row.guid);
      }
    } catch (error) {
      const symbols = [...new Set(chunk.map(input => input.symbol))].join(', ');
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to store fetched price batch for ${symbols}:`, message);
    }
  }
  return stored;
}

async function storeMissingHistoricalPrices(
  commodityGuid: string,
  symbol: string,
  historicalPrices: HistoricalPriceRow[],
  existingDates: Set<string>,
  currencyGuid: string,
): Promise<{ count: number; earliest: string | null; latest: string | null }> {
  const missing = historicalPrices.filter(row => !existingDates.has(formatDateYMD(row.date)));
  const stored = await storeFetchedPrices(missing.map(row => ({
    commodityGuid,
    symbol,
    price: row.close,
    date: row.date,
  })), currencyGuid);

  let earliest: string | null = null;
  let latest: string | null = null;
  for (const row of missing) {
    const date = formatDateYMD(row.date);
    if (!stored.has(`${commodityGuid}:${date}`)) continue;
    existingDates.add(date);
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }
  return { count: stored.size, earliest, latest };
}

/**
 * Fetch and store historical closing prices for all quotable commodities (or specific symbols).
 *
 * DESIGN: Only historical closing prices are stored. The ceiling is now (new Date())
 * so the most recent available market close is always captured. No real-time quotes.
 *
 * Three MUTUALLY EXCLUSIVE paths:
 * 1. force=true: Fetch full 3-month range, insert only missing dates
 * 2. !lastDate: First-time backfill, fetch 3 months up to now
 * 3. Normal: Backfill from lastDate+1 to now, then gap detection
 *
 * @param symbols Optional array of specific symbols to fetch. If not provided, fetches all quotable commodities.
 * @param force If true, fetch full 3-month historical range regardless of existing data
 * @returns Summary of the fetch and store operation
 */
export async function fetchAndStorePrices(
  symbols?: string[],
  force: boolean = false
): Promise<FetchAndStoreResult> {
  const LOOKBACK_MONTHS = 3;
  const endDate = new Date();

  // Get quotable commodities
  const commodities = await getQuotableCommodities();

  // Filter to requested symbols if provided
  let targetCommodities = commodities;
  if (symbols && symbols.length > 0) {
    const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
    targetCommodities = commodities.filter(c => symbolSet.has(c.mnemonic.toUpperCase()));
  }

  if (targetCommodities.length === 0) {
    return { stored: 0, backfilled: 0, gapsFilled: 0, failed: 0, results: [] };
  }
  const usd = await getCurrencyByMnemonic('USD');
  if (!usd) throw new Error('USD currency not found');

  const results: PriceFetchResult[] = [];
  let totalBackfilled = 0;
  let totalGapsFilled = 0;
  let totalFailed = 0;

  for (const commodity of targetCommodities) {
    const symbol = yahooSymbolFor(commodity);
    let pricesStored = 0;
    let earliestDate: string | null = null;
    let latestDate: string | null = null;

    try {
      if (force) {
        // PATH 1: Force -- fetch full 3-month range, insert only missing
        // Mutually exclusive: skip normal backfill and gap detection
        const startDate = new Date(endDate);
        startDate.setUTCMonth(startDate.getUTCMonth() - LOOKBACK_MONTHS);

        const existingDates = await getExistingPriceDates(commodity.guid, startDate, endDate);
        const historicalPrices = await fetchHistoricalPrices(symbol, startDate, endDate);

        const batch = await storeMissingHistoricalPrices(
          commodity.guid, symbol, historicalPrices, existingDates, usd.guid,
        );
        pricesStored += batch.count;
        earliestDate = batch.earliest;
        latestDate = batch.latest;

        // Force counts toward backfilled (it is a full-range backfill)
        totalBackfilled += pricesStored;
      } else {
        const lastDate = await getLastPriceDate(commodity.guid);

        if (!lastDate) {
          // PATH 2: First-time backfill -- fetch 3 months up to now
          const startDate = new Date(endDate);
          startDate.setUTCMonth(startDate.getUTCMonth() - LOOKBACK_MONTHS);

          const existingDates = await getExistingPriceDates(commodity.guid, startDate, endDate);
          const historicalPrices = await fetchHistoricalPrices(symbol, startDate, endDate);

          const batch = await storeMissingHistoricalPrices(
            commodity.guid, symbol, historicalPrices, existingDates, usd.guid,
          );
          pricesStored += batch.count;
          earliestDate = batch.earliest;
          latestDate = batch.latest;

          totalBackfilled += pricesStored;
        } else {
          // PATH 3: Normal -- backfill from lastDate+1 to now, then gap detection
          const backfillStart = new Date(lastDate);
          backfillStart.setUTCDate(backfillStart.getUTCDate() + 1);
          backfillStart.setUTCHours(0, 0, 0, 0);

          let backfillCount = 0;

          // Only backfill if there are days to fill
          if (backfillStart <= endDate) {
            const existingDates = await getExistingPriceDates(commodity.guid, backfillStart, endDate);
            const historicalPrices = await fetchHistoricalPrices(symbol, backfillStart, endDate);

            const batch = await storeMissingHistoricalPrices(
              commodity.guid, symbol, historicalPrices, existingDates, usd.guid,
            );
            backfillCount += batch.count;
            earliestDate = batch.earliest;
            latestDate = batch.latest;
          }

          totalBackfilled += backfillCount;
          pricesStored += backfillCount;

          // Gap detection on the full lookback range
          const gapsFilled = await detectAndFillGaps(
            commodity.guid, symbol, LOOKBACK_MONTHS, usd.guid,
          );
          totalGapsFilled += gapsFilled;
          pricesStored += gapsFilled;
        }
      }

      results.push({
        symbol,
        pricesStored,
        dateRange: earliestDate && latestDate ? { from: earliestDate, to: latestDate } : null,
        success: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to process ${symbol}:`, errorMessage);
      totalFailed++;
      results.push({
        symbol,
        pricesStored: 0,
        dateRange: null,
        success: false,
        error: errorMessage,
      });
    }
  }

  return {
    stored: totalBackfilled + totalGapsFilled,
    backfilled: totalBackfilled,
    gapsFilled: totalGapsFilled,
    failed: totalFailed,
    results,
  };
}

/**
 * Audit each commodity's full historical coverage from its first transaction
 * or earliest known price and backfill every missing trading day.
 */
export async function auditAndBackfillPrices(
  symbols?: string[]
): Promise<AuditPricesResult> {
  const endDate = new Date();
  const commodities = await getQuotableCommodities();

  let targetCommodities = commodities;
  if (symbols && symbols.length > 0) {
    const symbolSet = new Set(symbols.map((symbol) => symbol.toUpperCase()));
    targetCommodities = commodities.filter((commodity) => symbolSet.has(commodity.mnemonic.toUpperCase()));
  }

  if (targetCommodities.length === 0) {
    return { stored: 0, audited: 0, failed: 0, results: [] };
  }
  const usd = await getCurrencyByMnemonic('USD');
  if (!usd) throw new Error('USD currency not found');

  const results: PriceFetchResult[] = [];
  let totalStored = 0;
  let totalAudited = 0;
  let totalFailed = 0;

  for (const commodity of targetCommodities) {
    const symbol = yahooSymbolFor(commodity);

    try {
      const startDate = await getCommodityAuditStartDate(commodity.guid);
      const existingDates = await getExistingPriceDates(commodity.guid, startDate, endDate);
      const historicalPrices = await fetchHistoricalPrices(symbol, startDate, endDate);

      const batch = await storeMissingHistoricalPrices(
        commodity.guid, symbol, historicalPrices, existingDates, usd.guid,
      );
      const pricesStored = batch.count;
      const latestStored = batch.latest;

      totalStored += pricesStored;
      totalAudited++;
      results.push({
        symbol,
        pricesStored,
        dateRange: {
          from: formatDateYMD(startDate),
          to: latestStored ?? formatDateYMD(endDate),
        },
        success: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to audit ${symbol}:`, errorMessage);
      totalFailed++;
      results.push({
        symbol,
        pricesStored: 0,
        dateRange: null,
        success: false,
        error: errorMessage,
      });
    }
  }

  return {
    stored: totalStored,
    audited: totalAudited,
    failed: totalFailed,
    results,
  };
}
