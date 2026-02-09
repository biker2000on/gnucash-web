/**
 * Yahoo Finance Price Service
 *
 * Service for fetching stock/commodity prices from Yahoo Finance
 * and storing them in the GnuCash prices table.
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
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  timestamp: Date;
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
  fetched: number;
  stored: number;
  failed: number;
  skipped: number;
  results: PriceFetchResult[];
}

/**
 * Check if a price already exists for a commodity today
 * @param commodityGuid GUID of the commodity to check
 * @returns true if a price exists for today, false otherwise
 */
async function hasPriceForToday(commodityGuid: string): Promise<boolean> {
  const { default: prisma } = await import('./prisma');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const existingPrice = await prisma.prices.findFirst({
    where: {
      commodity_guid: commodityGuid,
      date: { gte: today, lt: tomorrow },
    },
  });

  return existingPrice !== null;
}

/**
 * Fetch batch quotes from Yahoo Finance
 * @param symbols Array of stock symbols to fetch
 * @returns Array of price fetch results
 */
export async function fetchBatchQuotes(symbols: string[]): Promise<PriceFetchResult[]> {
  if (symbols.length === 0) {
    return [];
  }

  const results: PriceFetchResult[] = [];

  try {
    const yahooFinance = new YahooFinance();
    const quotes = await yahooFinance.quote(symbols);

    // Build a map of returned quotes for quick lookup
    const quotesMap = new Map<string, typeof quotes[number]>();
    for (const quote of quotes) {
      if (quote && quote.symbol) {
        quotesMap.set(quote.symbol.toUpperCase(), quote);
      }
    }

    // Process each requested symbol
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
        console.warn(`Price fetch: Symbol not found or invalid response: ${symbol}`);
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
    // If the entire API call fails, mark all symbols as failed
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

  // Get USD currency for price storage
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
 * Fetch and store prices for all quotable commodities (or specific symbols)
 * @param symbols Optional array of specific symbols to fetch. If not provided, fetches all quotable commodities.
 * @param force If true, fetch prices even if today's price already exists
 * @returns Summary of the fetch and store operation
 */
export async function fetchAndStorePrices(
  symbols?: string[],
  force: boolean = false
): Promise<FetchAndStoreResult> {
  // Get quotable commodities
  const commodities = await getQuotableCommodities();

  // Filter to requested symbols if provided
  let targetCommodities = commodities;
  if (symbols && symbols.length > 0) {
    const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
    targetCommodities = commodities.filter(c => symbolSet.has(c.mnemonic.toUpperCase()));
  }

  if (targetCommodities.length === 0) {
    return {
      fetched: 0,
      stored: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };
  }

  // Filter out commodities that already have today's price (unless force=true)
  let commoditiesToFetch = targetCommodities;
  let skippedCount = 0;

  if (!force) {
    commoditiesToFetch = [];
    for (const commodity of targetCommodities) {
      const hasToday = await hasPriceForToday(commodity.guid);
      if (!hasToday) {
        commoditiesToFetch.push(commodity);
      } else {
        skippedCount++;
      }
    }

    if (commoditiesToFetch.length === 0) {
      return { fetched: 0, stored: 0, failed: 0, skipped: skippedCount, results: [] };
    }
  }

  // Create symbol to commodity GUID mapping
  const symbolToGuid = new Map<string, string>();
  for (const commodity of commoditiesToFetch) {
    symbolToGuid.set(commodity.mnemonic.toUpperCase(), commodity.guid);
  }

  // Fetch prices from Yahoo Finance
  const fetchSymbols = commoditiesToFetch.map(c => c.mnemonic);
  const fetchResults = await fetchBatchQuotes(fetchSymbols);

  let stored = 0;
  let failed = 0;
  const now = new Date();

  // Store successful fetches
  for (const result of fetchResults) {
    if (result.success) {
      const commodityGuid = symbolToGuid.get(result.symbol.toUpperCase());
      if (commodityGuid) {
        const priceGuid = await storeFetchedPrice(
          commodityGuid,
          result.symbol,
          result.price,
          now
        );
        if (priceGuid) {
          stored++;
        } else {
          failed++;
          result.success = false;
          result.error = 'Failed to store price';
        }
      }
    } else {
      failed++;
    }
  }

  return {
    fetched: fetchResults.filter(r => r.success && r.price > 0).length,
    stored,
    failed,
    skipped: skippedCount,
    results: fetchResults,
  };
}
