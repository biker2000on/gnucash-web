import { NextRequest, NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getIndexHistory, normalizeToPercent, IndexPriceData } from '@/lib/market-index-service';
import { requireRole } from '@/lib/auth';

interface HistoryPoint {
  date: string;
  value: number;
}

interface InvestmentHistoryResponse {
  history: HistoryPoint[];
  indices: {
    sp500: IndexPriceData[];
    djia: IndexPriceData[];
  };
}

/**
 * GET /api/investments/history?days=365&accountGuids=guid1,guid2
 *
 * Returns daily portfolio value over time period.
 * Calculates value using point-in-time share counts and historical prices.
 *
 * Query params:
 * - days: number of days to look back (default: 365)
 * - accountGuids: optional comma-separated account GUIDs to filter (default: all investment accounts)
 */
export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;

  const searchParams = request.nextUrl.searchParams;
  const days = parseInt(searchParams.get('days') || '365', 10);
  const accountGuidsParam = searchParams.get('accountGuids');
  const filterAccountGuids = accountGuidsParam ? accountGuidsParam.split(',') : null;

  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - days);

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

    // Filter to specific accounts if provided
    const filteredAccounts = filterAccountGuids
      ? accounts.filter(a => filterAccountGuids.includes(a.guid))
      : accounts;

    if (filteredAccounts.length === 0) {
      return NextResponse.json({ history: [] });
    }

    // Fetch ALL splits for all investment accounts with their transaction post_dates
    interface SplitWithDate {
      account_guid: string;
      commodity_guid: string;
      quantity: number;
      postDate: Date;
    }

    const allSplits: SplitWithDate[] = [];

    for (const account of filteredAccounts) {
      const splits = await prisma.splits.findMany({
        where: { account_guid: account.guid },
        select: {
          quantity_num: true,
          quantity_denom: true,
          transaction: { select: { post_date: true } },
        },
      });

      for (const split of splits) {
        if (!split.transaction.post_date) continue;
        allSplits.push({
          account_guid: account.guid,
          commodity_guid: account.commodity_guid!,
          quantity: parseFloat(toDecimal(split.quantity_num, split.quantity_denom)),
          postDate: split.transaction.post_date,
        });
      }
    }

    // Sort splits by date ascending for pointer-based accumulation
    allSplits.sort((a, b) => a.postDate.getTime() - b.postDate.getTime());

    // Get all unique commodity GUIDs
    const commodityGuids = [...new Set(filteredAccounts.map(a => a.commodity_guid).filter(Boolean))];

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

    // Initialize forward-fill with latest prices BEFORE startDate for each commodity
    const latestPricesByCommodity = new Map<string, number>();

    for (const commodityGuid of commodityGuids) {
      const latestBefore = await prisma.prices.findFirst({
        where: {
          commodity_guid: commodityGuid as string,
          date: { lt: startDate },
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
    }

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

    // Build portfolio value time series with point-in-time share counts
    const portfolioValueByDate = new Map<string, number>();

    // Get all unique dates and sort
    const allDates = new Set<string>();
    prices.forEach(p => allDates.add(p.date.toISOString().split('T')[0]));
    const sortedDates = Array.from(allDates).sort();

    // Running share totals per account (accumulated over time)
    const sharesByAccount = new Map<string, number>();
    let splitPointer = 0;

    // For each date, calculate portfolio value with point-in-time shares
    for (const dateStr of sortedDates) {
      const dateEnd = new Date(dateStr + 'T23:59:59Z');

      // Advance pointer: accumulate splits with postDate <= dateEnd
      while (splitPointer < allSplits.length && allSplits[splitPointer].postDate <= dateEnd) {
        const split = allSplits[splitPointer];
        sharesByAccount.set(
          split.account_guid,
          (sharesByAccount.get(split.account_guid) || 0) + split.quantity
        );
        splitPointer++;
      }

      // Update latest known prices for this date (forward-fill)
      for (const [commodityGuid, pricesByDate] of pricesByDateByCommodity) {
        const priceOnDate = pricesByDate.get(dateStr);
        if (priceOnDate !== undefined) {
          latestPricesByCommodity.set(commodityGuid, priceOnDate);
        }
      }

      // Calculate total portfolio value with point-in-time shares and latest known prices
      let portfolioValue = 0;

      for (const account of filteredAccounts) {
        const shares = sharesByAccount.get(account.guid) || 0;
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

    // Fetch market index data for the same date range (only for portfolio-wide requests)
    let indices: InvestmentHistoryResponse['indices'] = { sp500: [], djia: [] };
    if (!filterAccountGuids) {
      try {
        const [sp500Raw, djiaRaw] = await Promise.all([
          getIndexHistory('^GSPC', startDate),
          getIndexHistory('^DJI', startDate),
        ]);

        indices = {
          sp500: normalizeToPercent(sp500Raw, startDate),
          djia: normalizeToPercent(djiaRaw, startDate),
        };
      } catch (err) {
        console.warn('Failed to fetch market index data for history:', err);
      }
    }

    return NextResponse.json({ history, indices });
  } catch (error) {
    console.error('Error fetching history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch history' },
      { status: 500 }
    );
  }
}
