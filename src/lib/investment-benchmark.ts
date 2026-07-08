/**
 * Investment Benchmark Comparison
 *
 * Compares a portfolio's time-weighted return against a market index over a
 * selectable window. The alignment + return-diff math is kept PURE (and unit
 * tested) so it can run without a database. `loadBenchmarkComparison()` wires
 * the pure builder up to the same data sources that feed the performance chart
 * (portfolio value history from the GnuCash splits/prices tables, and index
 * price history from the market index service).
 */

import {
  calculateTimeWeightedReturn,
  type PerformanceHistoryPoint,
  type PerformanceCashFlowPoint,
} from '@/lib/investment-performance';

// Client-safe constants and types live in a separate module so client
// components can import them without pulling this file's DB loader into the
// browser bundle. Imported for local use and re-exported for API/server callers.
import {
  BENCHMARK_INDEX_OPTIONS,
  DEFAULT_BENCHMARK_SYMBOL,
  indexNameForSymbol,
  type BenchmarkWindow,
  type BenchmarkIndexOption,
} from '@/lib/investment-benchmark-constants';

export {
  BENCHMARK_INDEX_OPTIONS,
  DEFAULT_BENCHMARK_SYMBOL,
  indexNameForSymbol,
};
export type { BenchmarkWindow, BenchmarkIndexOption };

/** A single aligned point on the comparison chart (both series rebased to 100). */
export interface BenchmarkSeriesPoint {
  date: string;
  /** Portfolio growth-of-100 curve (cumulative time-weighted return). */
  portfolio: number | null;
  /** Index growth-of-100 curve (price rebased to 100 at window start). */
  index: number | null;
}

/** Result of a portfolio-vs-index comparison over a window. */
export interface BenchmarkComparison {
  indexSymbol: string;
  indexName: string;
  window: BenchmarkWindow;
  startDate: string | null;
  endDate: string | null;
  /** Portfolio time-weighted return over the window, in percent. */
  portfolioReturn: number;
  /** Index total return over the window, in percent. */
  indexReturn: number;
  /** portfolioReturn − indexReturn, in percent (alpha vs the index). */
  alpha: number;
  /** Aligned series, both rebased to 100 at the window start. */
  series: BenchmarkSeriesPoint[];
  /** True when the index has no usable price data across the window. */
  insufficientCoverage: boolean;
  /** Human-readable coverage note (present when coverage is insufficient). */
  coverageNote?: string;
}

/** Inputs for the pure comparison builder. */
export interface BenchmarkBuilderInput {
  history: PerformanceHistoryPoint[];
  cashFlows: PerformanceCashFlowPoint[];
  indexHistory: { date: string; value: number }[];
  indexSymbol: string;
  indexName: string;
  window: BenchmarkWindow;
  /** Reference "today" for window math (defaults to now). */
  referenceDate?: Date;
}

function formatDateYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the inclusive start date (YYYY-MM-DD) for a window relative to a
 * reference date. Returns null for 'max' (no lower bound).
 */
export function resolveWindowStart(
  window: BenchmarkWindow,
  referenceDate: Date = new Date()
): string | null {
  if (window === 'max') return null;

  if (window === 'YTD') {
    return `${referenceDate.getUTCFullYear()}-01-01`;
  }

  const cutoff = new Date(referenceDate.getTime());
  switch (window) {
    case '1Y':
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
      break;
    case '3Y':
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
      break;
    case '5Y':
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
      break;
  }
  return formatDateYMD(cutoff);
}

/**
 * Filter a date-sorted point series to the window. Points with a date on or
 * after the window start are kept; 'max' keeps everything. Input is assumed
 * ascending by date but is defensively re-sorted.
 */
export function filterByWindow<T extends { date: string }>(
  points: T[],
  window: BenchmarkWindow,
  referenceDate: Date = new Date()
): T[] {
  const start = resolveWindowStart(window, referenceDate);
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (start === null) return sorted;
  return sorted.filter((p) => p.date >= start);
}

/**
 * Align an index price history onto an explicit list of target dates,
 * forward-filling missing days with the most recent prior index value.
 * Dates that precede the first index observation resolve to null.
 *
 * @param indexHistory ascending {date, value} index prices
 * @param dates ascending target dates (typically the portfolio's dates)
 */
export function forwardFillIndex(
  indexHistory: { date: string; value: number }[],
  dates: string[]
): (number | null)[] {
  const sortedIndex = [...indexHistory].sort((a, b) => a.date.localeCompare(b.date));
  const result: (number | null)[] = [];
  let pointer = 0;
  let lastKnown: number | null = null;

  for (const date of dates) {
    while (pointer < sortedIndex.length && sortedIndex[pointer].date <= date) {
      lastKnown = sortedIndex[pointer].value;
      pointer += 1;
    }
    result.push(lastKnown);
  }

  return result;
}

/**
 * Rebase a value series so the first non-null value becomes 100. Nulls are
 * preserved. A zero/invalid base yields all-null output.
 */
export function rebaseTo100(values: (number | null)[]): (number | null)[] {
  let base: number | null = null;
  for (const v of values) {
    if (v !== null && Number.isFinite(v) && v !== 0) {
      base = v;
      break;
    }
  }
  if (base === null) return values.map(() => null);

  return values.map((v) =>
    v !== null && Number.isFinite(v) ? (v / base!) * 100 : null
  );
}

/**
 * Total return over an aligned series, in percent: from the first non-null
 * value to the last non-null value. Returns 0 when fewer than two usable
 * points exist or the base is non-positive.
 */
export function totalReturnOverWindow(values: (number | null)[]): number {
  let first: number | null = null;
  let last: number | null = null;

  for (const v of values) {
    if (v !== null && Number.isFinite(v)) {
      if (first === null) first = v;
      last = v;
    }
  }

  if (first === null || last === null || first <= 0) return 0;
  return (last / first - 1) * 100;
}

/**
 * Build the portfolio growth-of-100 curve from a value history + external cash
 * flows using cumulative time-weighted return. Each point is
 * 100 × (1 + TWR[start..point] / 100), so the final point equals the headline
 * portfolio return and the curve is directly comparable to a rebased index.
 */
export function buildPortfolioGrowthSeries(
  history: PerformanceHistoryPoint[],
  cashFlows: PerformanceCashFlowPoint[]
): (number | null)[] {
  if (history.length === 0) return [];

  return history.map((point, index) => {
    if (index === 0) return 100;
    const slice = history.slice(0, index + 1);
    const flows = cashFlows.filter((f) => f.date <= point.date);
    const twr = calculateTimeWeightedReturn(slice, flows);
    const safe = Number.isFinite(twr) ? twr : 0;
    return 100 * (1 + safe / 100);
  });
}

/**
 * Pure comparison builder. Aligns portfolio + index over the window, computes
 * the portfolio TWR, the index total return, alpha, and the two rebased-to-100
 * series for charting. No database access.
 */
export function buildBenchmarkComparison(
  input: BenchmarkBuilderInput
): BenchmarkComparison {
  const {
    history,
    cashFlows,
    indexHistory,
    indexSymbol,
    indexName,
    window,
    referenceDate = new Date(),
  } = input;

  const windowedHistory = filterByWindow(history, window, referenceDate);
  const startDate = windowedHistory.length > 0 ? windowedHistory[0].date : null;
  const endDate =
    windowedHistory.length > 0 ? windowedHistory[windowedHistory.length - 1].date : null;

  const windowedCashFlows = cashFlows.filter(
    (f) => startDate !== null && endDate !== null && f.date >= startDate && f.date <= endDate
  );

  // Portfolio time-weighted return over the window.
  const portfolioReturn =
    windowedHistory.length >= 2
      ? (() => {
          const twr = calculateTimeWeightedReturn(windowedHistory, windowedCashFlows);
          return Number.isFinite(twr) ? twr : 0;
        })()
      : 0;

  // Align the index onto the portfolio's dates, bounded to the window so that
  // pre-window index values never leak into the rebasing/return math.
  const dates = windowedHistory.map((p) => p.date);
  const windowedIndex = indexHistory.filter(
    (p) => startDate === null || p.date >= startDate
  );
  const alignedIndexRaw = forwardFillIndex(windowedIndex, dates);

  const indexReturn = totalReturnOverWindow(alignedIndexRaw);

  const portfolioSeries = buildPortfolioGrowthSeries(windowedHistory, windowedCashFlows);
  const indexSeries = rebaseTo100(alignedIndexRaw);

  const series: BenchmarkSeriesPoint[] = dates.map((date, i) => ({
    date,
    portfolio: portfolioSeries[i] ?? null,
    index: indexSeries[i] ?? null,
  }));

  const usableIndexPoints = alignedIndexRaw.filter((v) => v !== null).length;
  const insufficientCoverage = dates.length >= 2 && usableIndexPoints < 2;

  let coverageNote: string | undefined;
  if (insufficientCoverage) {
    coverageNote =
      `No ${indexName} (${indexSymbol}) price data covers this window. ` +
      `Run the index backfill (POST /api/investments/backfill-indices) to fetch history.`;
  }

  return {
    indexSymbol,
    indexName,
    window,
    startDate,
    endDate,
    portfolioReturn,
    indexReturn,
    alpha: portfolioReturn - indexReturn,
    series,
    insufficientCoverage,
    coverageNote,
  };
}

/**
 * Load the portfolio value history + external cash flows for the active book,
 * reusing the same GnuCash splits/prices sources that feed the performance
 * chart (point-in-time share counts, forward-filled prices, non-positive
 * prices excluded to avoid false cliffs).
 */
async function loadPortfolioHistory(): Promise<{
  history: PerformanceHistoryPoint[];
  cashFlows: PerformanceCashFlowPoint[];
}> {
  const { default: prisma, toDecimal } = await import('@/lib/prisma');
  const { getBookAccountGuids } = await import('@/lib/book-scope');

  // Full available history; the window filter narrows it later.
  const startDate = new Date();
  startDate.setUTCFullYear(startDate.getUTCFullYear() - 100);
  const startDateStr = startDate.toISOString().split('T')[0];

  const bookAccountGuids = await getBookAccountGuids();

  const accounts = await prisma.accounts.findMany({
    where: {
      guid: { in: bookAccountGuids },
      account_type: { in: ['STOCK', 'MUTUAL'] },
      commodity: { namespace: { not: 'CURRENCY' } },
    },
    select: { guid: true, commodity_guid: true },
  });

  if (accounts.length === 0) {
    return { history: [], cashFlows: [] };
  }

  interface SplitWithDate {
    account_guid: string;
    commodity_guid: string;
    quantity: number;
    postDate: Date;
  }

  const allSplits: SplitWithDate[] = [];
  const cashFlowByDate = new Map<string, number>();

  const splitsPerAccount = await Promise.all(
    accounts.map(async (account) => {
      const splits = await prisma.splits.findMany({
        where: { account_guid: account.guid },
        select: {
          quantity_num: true,
          quantity_denom: true,
          value_num: true,
          value_denom: true,
          transaction: { select: { post_date: true } },
        },
      });
      return { account, splits };
    })
  );

  for (const { account, splits } of splitsPerAccount) {
    for (const split of splits) {
      if (!split.transaction.post_date) continue;
      allSplits.push({
        account_guid: account.guid,
        commodity_guid: account.commodity_guid!,
        quantity: parseFloat(toDecimal(split.quantity_num, split.quantity_denom)),
        postDate: split.transaction.post_date,
      });

      const dateStr = split.transaction.post_date.toISOString().split('T')[0];
      const flowAmount = parseFloat(toDecimal(split.value_num, split.value_denom));
      cashFlowByDate.set(dateStr, (cashFlowByDate.get(dateStr) || 0) + flowAmount);
    }
  }

  allSplits.sort((a, b) => a.postDate.getTime() - b.postDate.getTime());

  const commodityGuids = [...new Set(accounts.map((a) => a.commodity_guid).filter(Boolean))];

  const prices = await prisma.prices.findMany({
    where: {
      commodity_guid: { in: commodityGuids as string[] },
      date: { gte: startDate },
      value_num: { gt: 0 },
    },
    orderBy: { date: 'asc' },
    select: { commodity_guid: true, date: true, value_num: true, value_denom: true },
  });

  const latestPricesByCommodity = new Map<string, number>();
  await Promise.all(
    commodityGuids.map(async (commodityGuid) => {
      const latestBefore = await prisma.prices.findFirst({
        where: {
          commodity_guid: commodityGuid as string,
          date: { lt: startDate },
          value_num: { gt: 0 },
        },
        orderBy: { date: 'desc' },
        select: { value_num: true, value_denom: true },
      });
      if (latestBefore) {
        latestPricesByCommodity.set(
          commodityGuid as string,
          parseFloat(toDecimal(latestBefore.value_num, latestBefore.value_denom))
        );
      }
    })
  );

  const pricesByDateByCommodity = new Map<string, Map<string, number>>();
  for (const price of prices) {
    const dateStr = price.date.toISOString().split('T')[0];
    const priceValue = parseFloat(toDecimal(price.value_num, price.value_denom));
    if (!pricesByDateByCommodity.has(price.commodity_guid)) {
      pricesByDateByCommodity.set(price.commodity_guid, new Map());
    }
    pricesByDateByCommodity.get(price.commodity_guid)!.set(dateStr, priceValue);
  }

  const portfolioValueByDate = new Map<string, number>();

  const allDates = new Set<string>();
  prices.forEach((p) => allDates.add(p.date.toISOString().split('T')[0]));
  allSplits.forEach((split) => {
    const dateStr = split.postDate.toISOString().split('T')[0];
    if (dateStr >= startDateStr) allDates.add(dateStr);
  });
  allDates.add(startDateStr);
  const sortedDates = Array.from(allDates).sort();

  const sharesByAccount = new Map<string, number>();
  let splitPointer = 0;

  for (const dateStr of sortedDates) {
    const dateEnd = new Date(dateStr + 'T23:59:59Z');

    while (splitPointer < allSplits.length && allSplits[splitPointer].postDate <= dateEnd) {
      const split = allSplits[splitPointer];
      sharesByAccount.set(
        split.account_guid,
        (sharesByAccount.get(split.account_guid) || 0) + split.quantity
      );
      splitPointer += 1;
    }

    for (const [commodityGuid, pricesByDate] of pricesByDateByCommodity) {
      const priceOnDate = pricesByDate.get(dateStr);
      if (priceOnDate !== undefined) {
        latestPricesByCommodity.set(commodityGuid, priceOnDate);
      }
    }

    let portfolioValue = 0;
    for (const account of accounts) {
      const shares = sharesByAccount.get(account.guid) || 0;
      const price = latestPricesByCommodity.get(account.commodity_guid!) || 0;
      portfolioValue += shares * price;
    }

    if (portfolioValue > 0) {
      portfolioValueByDate.set(dateStr, portfolioValue);
    }
  }

  const history: PerformanceHistoryPoint[] = Array.from(portfolioValueByDate.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const cashFlows: PerformanceCashFlowPoint[] = Array.from(cashFlowByDate.entries())
    .filter(([date]) => date >= startDateStr)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { history, cashFlows };
}

/** Options for the DB-backed loader. */
export interface LoadBenchmarkOptions {
  indexSymbol?: string;
  window?: BenchmarkWindow;
  referenceDate?: Date;
}

/**
 * DB-backed comparison loader. Reuses the portfolio-history source (above) and
 * the index-history source (market-index-service.getIndexHistory), then hands
 * off to the pure builder. Book scoping is inherited from getBookAccountGuids.
 */
export async function loadBenchmarkComparison(
  options: LoadBenchmarkOptions = {}
): Promise<BenchmarkComparison> {
  const referenceDate = options.referenceDate ?? new Date();
  const window = options.window ?? '1Y';
  const requested = options.indexSymbol ?? DEFAULT_BENCHMARK_SYMBOL;
  const indexSymbol = BENCHMARK_INDEX_OPTIONS.some((o) => o.symbol === requested)
    ? requested
    : DEFAULT_BENCHMARK_SYMBOL;
  const indexName = indexNameForSymbol(indexSymbol);

  const { getIndexHistory } = await import('@/lib/market-index-service');

  // Fetch index history from a bit before the window start so forward-fill has
  // a value available on the very first portfolio date.
  const windowStart = resolveWindowStart(window, referenceDate);
  const indexFetchStart = windowStart ? new Date(`${windowStart}T00:00:00Z`) : new Date(0);
  // Pad 10 days so a market holiday at the window edge still forward-fills.
  indexFetchStart.setUTCDate(indexFetchStart.getUTCDate() - 10);

  const [{ history, cashFlows }, indexHistory] = await Promise.all([
    loadPortfolioHistory(),
    getIndexHistory(indexSymbol, indexFetchStart),
  ]);

  return buildBenchmarkComparison({
    history,
    cashFlows,
    indexHistory,
    indexSymbol,
    indexName,
    window,
    referenceDate,
  });
}
