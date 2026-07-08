import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  loadBenchmarkComparison,
  BENCHMARK_INDEX_OPTIONS,
  DEFAULT_BENCHMARK_SYMBOL,
  type BenchmarkWindow,
} from '@/lib/investment-benchmark';

const VALID_WINDOWS: BenchmarkWindow[] = ['1Y', '3Y', '5Y', 'YTD', 'max'];

/**
 * GET /api/investments/benchmark?index=^GSPC&window=1Y
 *
 * Compares the active book's portfolio time-weighted return against a market
 * index over the selected window. Returns the portfolio TWR, the index total
 * return, alpha (portfolio − index), and two rebased-to-100 series for
 * charting. If the index has no price coverage over the window, the response
 * flags it and points at the backfill endpoint.
 *
 * Query params:
 * - index: index symbol (default ^GSPC / S&P 500). Falls back to the default
 *   when an unsupported symbol is passed.
 * - window: 1Y | 3Y | 5Y | YTD | max (default 1Y).
 */
export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;

  try {
    const searchParams = request.nextUrl.searchParams;

    const requestedIndex = searchParams.get('index') || DEFAULT_BENCHMARK_SYMBOL;
    const indexSymbol = BENCHMARK_INDEX_OPTIONS.some((o) => o.symbol === requestedIndex)
      ? requestedIndex
      : DEFAULT_BENCHMARK_SYMBOL;

    const requestedWindow = searchParams.get('window') as BenchmarkWindow | null;
    const window: BenchmarkWindow =
      requestedWindow && VALID_WINDOWS.includes(requestedWindow) ? requestedWindow : '1Y';

    const comparison = await loadBenchmarkComparison({ indexSymbol, window });

    return NextResponse.json({
      ...comparison,
      availableIndices: BENCHMARK_INDEX_OPTIONS,
      backfillEndpoint: '/api/investments/backfill-indices',
    });
  } catch (error) {
    console.error('Benchmark comparison failed:', error);
    return NextResponse.json(
      { error: 'Failed to build benchmark comparison' },
      { status: 500 }
    );
  }
}
