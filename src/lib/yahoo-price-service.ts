/**
 * Yahoo Finance Price Service
 *
 * Service for fetching historical closing prices from Yahoo Finance
 * and storing them in the GnuCash prices table.
 *
 * DESIGN RULE: Only historical closing prices are stored.
 * The most recent price is always yesterday's close. No real-time quotes.
 *
 * Uses the yahoo-finance2 package which requires no API key.
 */

import YahooFinance from 'yahoo-finance2';
import { getCurrencyByMnemonic } from './currency';
import { fromDecimal, generateGuid } from './prisma';

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
 * Get yesterday's date at midnight UTC
 */
function getYesterday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
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
 * Get a Set of YYYY-MM-DD date strings for all existing prices in a range.
 * CRITICAL: The prices table has NO unique constraint, so we must deduplicate
 * by checking existing dates before every insert.
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
  // Map to the same HistoricalPriceRow interface used by all callers
  const quotes = result.quotes ?? [];
  return quotes
    .filter((q) => typeof q.close === 'number' && q.close > 0)
    .map((q) => ({ date: q.date, close: q.close as number }));
}

/**
 * Detect and fill gaps in stored price history for a commodity.
 * Fetches existing dates, gets historical prices from Yahoo, and stores only missing dates.
 * Uses yesterday as the upper bound -- never today.
 *
 * @param commodityGuid GUID of the commodity
 * @param symbol Stock ticker symbol
 * @param lookbackMonths Number of months to look back for gaps (default 3)
 * @returns Number of gap prices filled
 */
export async function detectAndFillGaps(
  commodityGuid: string,
  symbol: string,
  lookbackMonths: number = 3
): Promise<number> {
  const yesterday = getYesterday();
  const startDate = new Date(yesterday);
  startDate.setUTCMonth(startDate.getUTCMonth() - lookbackMonths);

  // Get all existing dates in the range
  const existingDates = await getExistingPriceDates(commodityGuid, startDate, yesterday);

  // If no existing prices at all, skip gap detection (backfill should handle it)
  if (existingDates.size === 0) {
    return 0;
  }

  // Fetch historical prices for the full range
  let historicalPrices: HistoricalPriceRow[];
  try {
    historicalPrices = await fetchHistoricalPrices(symbol, startDate, yesterday);
  } catch (err) {
    console.warn(`Gap detection: failed to fetch historical prices for ${symbol}:`, err);
    return 0;
  }

  // Store only dates that are missing
  let filled = 0;
  for (const row of historicalPrices) {
    const dateStr = formatDateYMD(row.date);
    if (!existingDates.has(dateStr)) {
      const stored = await storeFetchedPrice(commodityGuid, symbol, row.close, row.date);
      if (stored) {
        filled++;
        // Add to set so we don't double-insert within this batch
        existingDates.add(dateStr);
      }
    }
  }

  return filled;
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
  const { default: prisma } = await import('./prisma');

  // TODO: Accept currencyGuid parameter instead of hardcoding USD lookup
  // Currently hardcodes USD, but should use the commodity's quote currency or book's base currency
  const usd = await getCurrencyByMnemonic('USD');
  if (!usd) {
    console.error(`Cannot store price for ${symbol}: USD currency not found`);
    return null;
  }

  try {
    const guid = generateGuid();
    const { num, denom } = fromDecimal(price, usd.fraction);

    await prisma.prices.create({
      data: {
        guid,
        commodity_guid: commodityGuid,
        currency_guid: usd.guid,
        date: date,
        value_num: num,
        value_denom: denom,
        source: 'Finance::Quote',
        type: 'last',
      },
    });

    return guid;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to store price for ${symbol}:`, errorMessage);
    return null;
  }
}

/**
 * Fetch and store historical closing prices for all quotable commodities (or specific symbols).
 *
 * DESIGN: Only historical closing prices are stored. The most recent price is
 * always yesterday's close. No real-time quotes are fetched or stored.
 *
 * Three MUTUALLY EXCLUSIVE paths:
 * 1. force=true: Fetch full 3-month range, insert only missing dates
 * 2. !lastDate: First-time backfill, fetch 3 months up to yesterday
 * 3. Normal: Backfill from lastDate+1 to yesterday, then gap detection
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
  const yesterday = getYesterday();

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

  const results: PriceFetchResult[] = [];
  let totalBackfilled = 0;
  let totalGapsFilled = 0;
  let totalFailed = 0;

  for (const commodity of targetCommodities) {
    const symbol = commodity.mnemonic;
    let pricesStored = 0;
    let earliestDate: string | null = null;
    let latestDate: string | null = null;

    try {
      if (force) {
        // PATH 1: Force -- fetch full 3-month range, insert only missing
        // Mutually exclusive: skip normal backfill and gap detection
        const startDate = new Date(yesterday);
        startDate.setUTCMonth(startDate.getUTCMonth() - LOOKBACK_MONTHS);

        const existingDates = await getExistingPriceDates(commodity.guid, startDate, yesterday);
        const historicalPrices = await fetchHistoricalPrices(symbol, startDate, yesterday);

        for (const row of historicalPrices) {
          const dateStr = formatDateYMD(row.date);
          if (!existingDates.has(dateStr)) {
            const stored = await storeFetchedPrice(commodity.guid, symbol, row.close, row.date);
            if (stored) {
              pricesStored++;
              existingDates.add(dateStr);
              if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
              if (!latestDate || dateStr > latestDate) latestDate = dateStr;
            }
          }
        }

        // Force counts toward backfilled (it is a full-range backfill)
        totalBackfilled += pricesStored;
      } else {
        const lastDate = await getLastPriceDate(commodity.guid);

        if (!lastDate) {
          // PATH 2: First-time backfill -- fetch 3 months up to yesterday
          const startDate = new Date(yesterday);
          startDate.setUTCMonth(startDate.getUTCMonth() - LOOKBACK_MONTHS);

          const existingDates = await getExistingPriceDates(commodity.guid, startDate, yesterday);
          const historicalPrices = await fetchHistoricalPrices(symbol, startDate, yesterday);

          for (const row of historicalPrices) {
            const dateStr = formatDateYMD(row.date);
            if (!existingDates.has(dateStr)) {
              const stored = await storeFetchedPrice(commodity.guid, symbol, row.close, row.date);
              if (stored) {
                pricesStored++;
                existingDates.add(dateStr);
                if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
                if (!latestDate || dateStr > latestDate) latestDate = dateStr;
              }
            }
          }

          totalBackfilled += pricesStored;
        } else {
          // PATH 3: Normal -- backfill from lastDate+1 to yesterday, then gap detection
          const backfillStart = new Date(lastDate);
          backfillStart.setUTCDate(backfillStart.getUTCDate() + 1);
          backfillStart.setUTCHours(0, 0, 0, 0);

          let backfillCount = 0;

          // Only backfill if there are days to fill
          if (backfillStart <= yesterday) {
            const existingDates = await getExistingPriceDates(commodity.guid, backfillStart, yesterday);
            const historicalPrices = await fetchHistoricalPrices(symbol, backfillStart, yesterday);

            for (const row of historicalPrices) {
              const dateStr = formatDateYMD(row.date);
              if (!existingDates.has(dateStr)) {
                const stored = await storeFetchedPrice(commodity.guid, symbol, row.close, row.date);
                if (stored) {
                  backfillCount++;
                  existingDates.add(dateStr);
                  if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
                  if (!latestDate || dateStr > latestDate) latestDate = dateStr;
                }
              }
            }
          }

          totalBackfilled += backfillCount;
          pricesStored += backfillCount;

          // Gap detection on the full lookback range
          const gapsFilled = await detectAndFillGaps(commodity.guid, symbol, LOOKBACK_MONTHS);
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
