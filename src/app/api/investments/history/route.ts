import { NextRequest, NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';

interface HistoryPoint {
  date: string;
  value: number;
}

/**
 * GET /api/investments/history?days=365
 *
 * Returns daily portfolio value over time period.
 * Calculates value using current shares and historical prices.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const days = parseInt(searchParams.get('days') || '365', 10);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  try {
    // Get book account GUIDs for scoping
    const bookAccountGuids = await getBookAccountGuids();

    // Get all STOCK accounts with non-CURRENCY commodities in active book
    const accounts = await prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
        account_type: { in: ['STOCK', 'MUTUAL'] },
        commodity: {
          namespace: { not: 'CURRENCY' },
        },
      },
      select: {
        guid: true,
        commodity_guid: true,
      },
    });

    if (accounts.length === 0) {
      return NextResponse.json({ history: [] });
    }

    // Get current shares for each account (sum of split quantities)
    const accountSharesMap = new Map<string, number>();

    for (const account of accounts) {
      const splits = await prisma.splits.findMany({
        where: { account_guid: account.guid },
        select: { quantity_num: true, quantity_denom: true },
      });

      const totalShares = splits.reduce((sum: number, split) => {
        return sum + parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
      }, 0);

      accountSharesMap.set(account.guid, totalShares);
    }

    // Get all unique commodity GUIDs
    const commodityGuids = [...new Set(accounts.map(a => a.commodity_guid).filter(Boolean))];

    // Fetch all prices in date range for these commodities
    const prices = await prisma.prices.findMany({
      where: {
        commodity_guid: { in: commodityGuids as string[] },
        date: { gte: startDate },
      },
      orderBy: { date: 'asc' },
      select: {
        commodity_guid: true,
        date: true,
        value_num: true,
        value_denom: true,
      },
    });

    // Build a map of commodity -> latest price by date
    const pricesByDateByCommodity = new Map<string, Map<string, number>>();

    for (const price of prices) {
      const dateStr = price.date.toISOString().split('T')[0];
      const priceValue = parseFloat(toDecimal(price.value_num, price.value_denom));

      if (!pricesByDateByCommodity.has(price.commodity_guid)) {
        pricesByDateByCommodity.set(price.commodity_guid, new Map());
      }

      pricesByDateByCommodity.get(price.commodity_guid)!.set(dateStr, priceValue);
    }

    // Build portfolio value time series
    const portfolioValueByDate = new Map<string, number>();

    // Create forward-filled price map (carry forward last known price)
    const latestPricesByCommodity = new Map<string, number>();

    // Get all unique dates and sort
    const allDates = new Set<string>();
    prices.forEach(p => allDates.add(p.date.toISOString().split('T')[0]));
    const sortedDates = Array.from(allDates).sort();

    // For each date, calculate portfolio value
    for (const dateStr of sortedDates) {
      // Update latest known prices for this date
      for (const [commodityGuid, pricesByDate] of pricesByDateByCommodity) {
        const priceOnDate = pricesByDate.get(dateStr);
        if (priceOnDate !== undefined) {
          latestPricesByCommodity.set(commodityGuid, priceOnDate);
        }
      }

      // Calculate total portfolio value with latest known prices
      let portfolioValue = 0;

      for (const account of accounts) {
        const shares = accountSharesMap.get(account.guid) || 0;
        const price = latestPricesByCommodity.get(account.commodity_guid!) || 0;
        portfolioValue += shares * price;
      }

      if (portfolioValue > 0) {
        portfolioValueByDate.set(dateStr, portfolioValue);
      }
    }

    // Convert to array format
    const history: HistoryPoint[] = Array.from(portfolioValueByDate.entries())
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({ history });
  } catch (error) {
    console.error('Error fetching history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch history' },
      { status: 500 }
    );
  }
}
