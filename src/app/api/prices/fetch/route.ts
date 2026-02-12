import { NextRequest, NextResponse } from 'next/server';
import { fetchAndStorePrices, ensureIndexCommodities, fetchIndexPrices } from '@/lib/price-service';
import { z } from 'zod';

/**
 * POST /api/prices/fetch
 *
 * Trigger historical price backfill from Yahoo Finance.
 * Only stores historical closing prices -- never real-time quotes.
 * The most recent price stored is always yesterday's close.
 *
 * Request body (optional):
 * {
 *   symbols?: string[]  // Specific symbols to fetch (default: all quotable commodities)
 *   force?: boolean     // Force full 3-month historical refetch (default: false)
 * }
 *
 * Response:
 * {
 *   stored: number,      // Total number of prices stored across all paths
 *   backfilled: number,  // Number of prices backfilled (new dates since last stored)
 *   gapsFilled: number,  // Number of gap prices filled from lookback detection
 *   failed: number,      // Number of failed symbol operations
 *   results: [...]       // Detailed results for each symbol
 * }
 */

const FetchPricesSchema = z.object({
  symbols: z.array(z.string()).optional(),
  force: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Parse request body
    let symbols: string[] | undefined;
    let force = false;

    const contentType = request.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      const parseResult = FetchPricesSchema.safeParse(body);

      if (!parseResult.success) {
        return NextResponse.json(
          { error: 'Validation failed', errors: parseResult.error.issues },
          { status: 400 }
        );
      }

      symbols = parseResult.data.symbols;
      force = parseResult.data.force ?? false;
    }

    // Fetch and store historical prices
    const result = await fetchAndStorePrices(symbols, force);

    // Fetch market index prices (S&P 500, DJIA) in the background
    let indexWarning: string | undefined;
    try {
      await ensureIndexCommodities();
      await fetchIndexPrices();
    } catch (err) {
      console.warn('Failed to fetch index prices:', err);
      indexWarning = 'Market index prices could not be updated';
    }

    return NextResponse.json({
      stored: result.stored,
      backfilled: result.backfilled,
      gapsFilled: result.gapsFilled,
      failed: result.failed,
      ...(indexWarning ? { indexWarning } : {}),
      results: result.results.map(r => ({
        symbol: r.symbol,
        pricesStored: r.pricesStored,
        dateRange: r.dateRange,
        success: r.success,
        error: r.error,
      })),
    });
  } catch (error) {
    console.error('Error in historical price backfill:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to fetch historical prices: ${message}` },
      { status: 500 }
    );
  }
}
