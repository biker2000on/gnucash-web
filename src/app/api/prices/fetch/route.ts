import { NextRequest, NextResponse } from 'next/server';
import { isFmpConfigured } from '@/lib/config';
import { fetchAndStorePrices } from '@/lib/price-service';
import { z } from 'zod';

/**
 * POST /api/prices/fetch
 *
 * Trigger price fetching from FMP API
 *
 * Request body (optional):
 * {
 *   symbols?: string[]  // Specific symbols to fetch (default: all quotable commodities)
 *   force?: boolean     // Force refetch even if price exists for today (default: false)
 * }
 *
 * Response:
 * {
 *   fetched: number,    // Number of prices successfully fetched from API
 *   stored: number,     // Number of prices successfully stored in database
 *   failed: number,     // Number of failed operations
 *   skipped: number,    // Number of symbols skipped (price already exists)
 *   results: [...]      // Detailed results for each symbol
 * }
 */

const FetchPricesSchema = z.object({
  symbols: z.array(z.string()).optional(),
  force: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  // Check if FMP is configured
  if (!isFmpConfigured()) {
    return NextResponse.json(
      { error: 'FMP API key is not configured. Set FMP_API_KEY environment variable.' },
      { status: 401 }
    );
  }

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

    // Fetch and store prices
    const result = await fetchAndStorePrices(symbols, force);

    return NextResponse.json({
      fetched: result.fetched,
      stored: result.stored,
      failed: result.failed,
      skipped: result.skipped,
      results: result.results.map(r => ({
        symbol: r.symbol,
        price: r.price,
        previousClose: r.previousClose,
        change: r.change,
        changePercent: r.changePercent,
        timestamp: r.timestamp.toISOString(),
        success: r.success,
        error: r.error,
      })),
    });
  } catch (error) {
    console.error('Error in price fetch:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to fetch prices: ${message}` },
      { status: 500 }
    );
  }
}
