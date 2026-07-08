/**
 * Client-safe constants and types for the investment benchmark comparison.
 *
 * This module intentionally has NO server-only imports (prisma, market index
 * service, etc.) so it can be imported by client components without dragging
 * the DB layer into the browser bundle. The heavy comparison engine lives in
 * `investment-benchmark.ts`, which re-exports everything here.
 */

/** Selectable comparison window. */
export type BenchmarkWindow = '1Y' | '3Y' | '5Y' | 'YTD' | 'max';

/** A candidate index the underlying market-index-service can supply. */
export interface BenchmarkIndexOption {
  symbol: string;
  name: string;
}

/**
 * Index symbols supported by the market index service (see
 * INDEX_DEFINITIONS in market-index-service.ts). The S&P 500 is the primary
 * index and the default for the comparison.
 */
export const BENCHMARK_INDEX_OPTIONS: BenchmarkIndexOption[] = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^DJI', name: 'Dow Jones' },
  { symbol: '^IXIC', name: 'NASDAQ' },
  { symbol: '^RUT', name: 'Russell 2000' },
];

/** Default index for the comparison (the primary index the service supports). */
export const DEFAULT_BENCHMARK_SYMBOL = '^GSPC';

export function indexNameForSymbol(symbol: string): string {
  return BENCHMARK_INDEX_OPTIONS.find((o) => o.symbol === symbol)?.name || symbol;
}
