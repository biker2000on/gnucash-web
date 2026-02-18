/**
 * Market Index Service
 *
 * Manages virtual commodities for market indices (^GSPC, ^DJI) and their
 * historical price data. Index commodities are stored in the GnuCash
 * commodities table with namespace='INDEX' and quote_flag=0 to prevent
 * interference with the regular price fetching flow.
 */

import { generateGuid } from '@/lib/gnucash';
import {
  fetchHistoricalPrices,
  storeFetchedPrice,
  getExistingPriceDates,
} from '@/lib/price-service';

/** A single index price data point */
export interface IndexPriceData {
  date: string;      // YYYY-MM-DD
  value: number;     // Absolute index value
  percentChange: number;  // % change from base date
}

/** Full index history response */
export interface IndexHistoryResult {
  symbol: string;
  name: string;
  data: IndexPriceData[];
}

interface IndexDefinition {
  mnemonic: string;
  fullname: string;
}

const INDEX_DEFINITIONS: IndexDefinition[] = [
  { mnemonic: '^GSPC', fullname: 'S&P 500 Index' },
  { mnemonic: '^DJI', fullname: 'Dow Jones Industrial Average' },
];

/**
 * Format a Date as YYYY-MM-DD string (UTC)
 */
function formatDateYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Ensure INDEX commodities exist in the commodities table.
 * Creates ^GSPC and ^DJI with namespace='INDEX' and quote_flag=0 if they don't exist.
 * Returns a map of mnemonic -> commodity guid.
 */
export async function ensureIndexCommodities(): Promise<Map<string, string>> {
  const { default: prisma } = await import('@/lib/prisma');
  const result = new Map<string, string>();

  for (const def of INDEX_DEFINITIONS) {
    // Check if already exists
    const existing = await prisma.commodities.findFirst({
      where: {
        namespace: 'INDEX',
        mnemonic: def.mnemonic,
      },
      select: { guid: true },
    });

    if (existing) {
      result.set(def.mnemonic, existing.guid);
      continue;
    }

    // Create new INDEX commodity using raw SQL
    // The commodities table has exactly 9 columns:
    // guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz
    const guid = generateGuid();
    await prisma.$executeRaw`
      INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
      VALUES (${guid}, 'INDEX', ${def.mnemonic}, ${def.fullname}, '', 10000, 0, NULL, NULL)
    `;

    result.set(def.mnemonic, guid);
    console.log(`Created INDEX commodity: ${def.mnemonic} (${guid})`);
  }

  return result;
}

/**
 * Fetch and store historical prices for both market indices.
 * Uses the getExistingPriceDates() dedup pattern since the prices table has NO unique constraint.
 *
 * @param days Number of days of history to fetch (default 365)
 * @returns Number of prices stored for each index
 */
export async function fetchIndexPrices(
  days: number = 365
): Promise<{ symbol: string; stored: number }[]> {
  const indexGuids = await ensureIndexCommodities();
  const results: { symbol: string; stored: number }[] = [];

  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  endDate.setUTCDate(endDate.getUTCDate() - 1); // yesterday

  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - days);

  for (const [symbol, commodityGuid] of indexGuids) {
    let stored = 0;
    try {
      // Fetch historical prices from Yahoo Finance (uses chart() endpoint)
      const prices = await fetchHistoricalPrices(symbol, startDate, endDate);

      // Dedup: get existing dates to avoid duplicate inserts
      const existingDates = await getExistingPriceDates(
        commodityGuid,
        startDate,
        endDate
      );

      for (const row of prices) {
        const dateStr = formatDateYMD(row.date);
        if (!existingDates.has(dateStr)) {
          const result = await storeFetchedPrice(
            commodityGuid,
            symbol,
            row.close,
            row.date
          );
          if (result) {
            stored++;
            existingDates.add(dateStr);
          }
        }
      }

      console.log(`Stored ${stored} prices for ${symbol}`);
    } catch (error) {
      console.warn(`Failed to fetch index prices for ${symbol}:`, error);
    }

    results.push({ symbol, stored });
  }

  return results;
}

/**
 * Get stored index price history from the prices table.
 *
 * @param indexSymbol The index symbol (e.g., '^GSPC', '^DJI')
 * @param startDate Start date for history
 * @returns Array of { date, value } objects sorted by date ascending
 */
export async function getIndexHistory(
  indexSymbol: string,
  startDate: Date
): Promise<{ date: string; value: number }[]> {
  const { default: prisma } = await import('@/lib/prisma');

  // Find the commodity guid for this index
  const commodity = await prisma.commodities.findFirst({
    where: {
      namespace: 'INDEX',
      mnemonic: indexSymbol,
    },
    select: { guid: true },
  });

  if (!commodity) return [];

  const prices = await prisma.prices.findMany({
    where: {
      commodity_guid: commodity.guid,
      date: { gte: startDate },
    },
    orderBy: { date: 'asc' },
    select: {
      date: true,
      value_num: true,
      value_denom: true,
    },
  });

  return prices.map((p) => ({
    date: formatDateYMD(p.date),
    value: Number(p.value_num) / Number(p.value_denom),
  }));
}

/**
 * Convert absolute prices to percent change from a base date.
 * The first data point on or after baseDate becomes 0%.
 *
 * @param prices Array of { date, value } objects
 * @param baseDate The date to normalize from (first date >= baseDate is used)
 * @returns Array of IndexPriceData with percentChange calculated
 */
export function normalizeToPercent(
  prices: { date: string; value: number }[],
  baseDate: Date
): IndexPriceData[] {
  if (prices.length === 0) return [];

  const baseDateStr = formatDateYMD(baseDate);

  // Find the base value: first price on or after baseDate
  let baseValue: number | null = null;
  for (const p of prices) {
    if (p.date >= baseDateStr) {
      baseValue = p.value;
      break;
    }
  }

  // Fallback to first price if no price found on/after baseDate
  if (baseValue === null) {
    baseValue = prices[0].value;
  }

  return prices.map((p) => ({
    date: p.date,
    value: p.value,
    percentChange:
      baseValue! > 0
        ? Math.round(((p.value - baseValue!) / baseValue!) * 10000) / 100
        : 0,
  }));
}

/**
 * Backfill index prices to the earliest transaction date.
 * Fetches historical data for the gap between earliest transaction
 * and earliest stored index price.
 */
export async function backfillIndexPrices(): Promise<{ symbol: string; stored: number; dateRange: string }[]> {
  const { default: prisma } = await import('@/lib/prisma');

  // Find the earliest transaction date across all books
  const earliest = await prisma.transactions.findFirst({
    orderBy: { post_date: 'asc' },
    select: { post_date: true },
  });
  if (!earliest || !earliest.post_date) return [];

  const earliestDate = new Date(earliest.post_date);
  earliestDate.setUTCHours(0, 0, 0, 0);

  const indexGuids = await ensureIndexCommodities();
  const results: { symbol: string; stored: number; dateRange: string }[] = [];

  for (const [symbol, commodityGuid] of indexGuids) {
    let stored = 0;

    // Find earliest stored price for this index
    const earliestPrice = await prisma.prices.findFirst({
      where: { commodity_guid: commodityGuid },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    const endDate = earliestPrice
      ? new Date(earliestPrice.date)
      : new Date();

    // Only backfill if there's a gap
    if (earliestDate < endDate) {
      try {
        const prices = await fetchHistoricalPrices(symbol, earliestDate, endDate);
        const existingDates = await getExistingPriceDates(commodityGuid, earliestDate, endDate);

        for (const row of prices) {
          const dateStr = formatDateYMD(row.date);
          if (!existingDates.has(dateStr)) {
            const result = await storeFetchedPrice(commodityGuid, symbol, row.close, row.date);
            if (result) {
              stored++;
              existingDates.add(dateStr);
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to backfill ${symbol}:`, error);
      }
    }

    results.push({
      symbol,
      stored,
      dateRange: `${formatDateYMD(earliestDate)} to ${formatDateYMD(endDate)}`,
    });
  }

  return results;
}

/**
 * Get coverage info for index price data.
 * Returns earliest/latest dates and whether backfill is needed.
 */
export async function getIndexCoverage(): Promise<{
  earliestTransaction: string | null;
  indices: { symbol: string; name: string; count: number; earliest: string | null; latest: string | null }[];
  isUpToDate: boolean;
}> {
  const { default: prisma } = await import('@/lib/prisma');

  // Find earliest transaction date
  const earliestTx = await prisma.transactions.findFirst({
    orderBy: { post_date: 'asc' },
    select: { post_date: true },
  });
  const earliestTransaction = earliestTx?.post_date
    ? formatDateYMD(new Date(earliestTx.post_date))
    : null;

  const indexGuids = await ensureIndexCommodities();
  const indices: { symbol: string; name: string; count: number; earliest: string | null; latest: string | null }[] = [];
  let isUpToDate = true;

  const nameMap: Record<string, string> = {
    '^GSPC': 'S&P 500',
    '^DJI': 'Dow Jones',
  };

  for (const [symbol, commodityGuid] of indexGuids) {
    const count = await prisma.prices.count({
      where: { commodity_guid: commodityGuid },
    });

    const earliestPrice = await prisma.prices.findFirst({
      where: { commodity_guid: commodityGuid },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    const latestPrice = await prisma.prices.findFirst({
      where: { commodity_guid: commodityGuid },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    const earliest = earliestPrice ? formatDateYMD(new Date(earliestPrice.date)) : null;
    const latest = latestPrice ? formatDateYMD(new Date(latestPrice.date)) : null;

    // Check if there's a gap to backfill
    if (earliestTransaction && (!earliest || earliestTransaction < earliest)) {
      isUpToDate = false;
    }

    indices.push({
      symbol,
      name: nameMap[symbol] || symbol,
      count,
      earliest,
      latest,
    });
  }

  return { earliestTransaction, indices, isUpToDate };
}
