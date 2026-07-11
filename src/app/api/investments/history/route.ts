import { NextRequest, NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getIndexHistory, normalizeToPercent, IndexPriceData } from '@/lib/market-index-service';
import { requireRole } from '@/lib/auth';

interface HistoryPoint {
  date: string;
  value: number;
}

interface CashFlowPoint {
  date: string;
  amount: number;
}

interface InvestmentHistoryResponse {
  history: HistoryPoint[];
  cashFlows: CashFlowPoint[];
  indices: {
    sp500: IndexPriceData[];
    djia: IndexPriceData[];
    nasdaq: IndexPriceData[];
    russell2000: IndexPriceData[];
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
  // Optional cash/currency accounts (e.g. an investment account's own cash) whose
  // running $ balance is added to the value series. Without this, an account
  // reads as ~$0 during a rebalance (holdings sold to cash, not yet reinvested),
  // producing a false cliff in the chart and breaking TWR (-100%).
  const cashAccountGuidsParam = searchParams.get('cashAccountGuids');
  // Preferred for the per-account view: resolve the whole subtree of an
  // investment parent account server-side. This picks up EVERY holding ever held
  // under it — including fully-closed positions (0 shares now) that are excluded
  // from current holdings — plus the account's cash, so historical value is
  // complete regardless of what is held today.
  const parentAccountGuid = searchParams.get('parentAccountGuid');

  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - days);

  try {
    // Get book account GUIDs for scoping
    const bookAccountGuids = await getBookAccountGuids();

    // When a parent account is given, resolve its full descendant subtree so we
    // can split it into holdings (STOCK/MUTUAL) and cash (CURRENCY) accounts,
    // including closed positions.
    let subtreeGuids: Set<string> | null = null;
    if (parentAccountGuid && bookAccountGuids.includes(parentAccountGuid)) {
      const tree = await prisma.accounts.findMany({
        where: { guid: { in: bookAccountGuids } },
        select: { guid: true, parent_guid: true },
      });
      const childrenByParent = new Map<string, string[]>();
      for (const a of tree) {
        if (!a.parent_guid) continue;
        if (!childrenByParent.has(a.parent_guid)) childrenByParent.set(a.parent_guid, []);
        childrenByParent.get(a.parent_guid)!.push(a.guid);
      }
      subtreeGuids = new Set<string>([parentAccountGuid]);
      const stack = [parentAccountGuid];
      while (stack.length > 0) {
        const g = stack.pop()!;
        for (const child of childrenByParent.get(g) ?? []) {
          if (!subtreeGuids.has(child)) {
            subtreeGuids.add(child);
            stack.push(child);
          }
        }
      }
    }

    // Get all STOCK/MUTUAL accounts (non-CURRENCY) in the active book. No share
    // filter, so closed positions are included.
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

    // Determine which holding accounts and cash accounts to value.
    let filteredAccounts: { guid: string; commodity_guid: string | null }[];
    let cashAccountGuids: string[];
    if (subtreeGuids) {
      filteredAccounts = accounts.filter(a => subtreeGuids!.has(a.guid));
      // Cash = CURRENCY-denominated accounts anywhere in the subtree (includes
      // the parent itself when it holds cash directly).
      const cashAccounts = await prisma.accounts.findMany({
        where: {
          guid: { in: [...subtreeGuids] },
          commodity: { namespace: 'CURRENCY' },
        },
        select: { guid: true },
      });
      cashAccountGuids = cashAccounts.map(a => a.guid);
    } else {
      filteredAccounts = filterAccountGuids
        ? accounts.filter(a => filterAccountGuids.includes(a.guid))
        : accounts;
      cashAccountGuids = cashAccountGuidsParam
        ? cashAccountGuidsParam.split(',').filter((g) => bookAccountGuids.includes(g))
        : [];
    }

    if (filteredAccounts.length === 0 && cashAccountGuids.length === 0) {
      return NextResponse.json({ history: [], cashFlows: [], indices: { sp500: [], djia: [], nasdaq: [], russell2000: [] } });
    }

    // Fetch ALL splits for all investment accounts with their transaction post_dates
    interface SplitWithDate {
      account_guid: string;
      commodity_guid: string;
      quantity: number;
      postDate: Date;
    }

    const allSplits: SplitWithDate[] = [];
    const cashFlowByDate = new Map<string, number>();

    const splitsPerAccount = await Promise.all(
      filteredAccounts.map(async (account) => {
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

    // Sort splits by date ascending for pointer-based accumulation
    allSplits.sort((a, b) => a.postDate.getTime() - b.postDate.getTime());

    // Cash accounts: accumulate a running $ balance over time (value splits, no
    // price needed). Their splits also join cashFlowByDate so that internal
    // transfers (sell holding -> cash, cash -> buy holding) net to zero and only
    // genuine external contributions/withdrawals affect TWR/MWR.
    interface CashSplit {
      amount: number;
      postDate: Date;
    }
    const cashSplits: CashSplit[] = [];
    if (cashAccountGuids.length > 0) {
      const rows = await prisma.splits.findMany({
        where: { account_guid: { in: cashAccountGuids } },
        select: {
          value_num: true,
          value_denom: true,
          transaction: { select: { post_date: true } },
        },
      });
      for (const split of rows) {
        if (!split.transaction.post_date) continue;
        const amount = parseFloat(toDecimal(split.value_num, split.value_denom));
        cashSplits.push({ amount, postDate: split.transaction.post_date });
        const dateStr = split.transaction.post_date.toISOString().split('T')[0];
        cashFlowByDate.set(dateStr, (cashFlowByDate.get(dateStr) || 0) + amount);
      }
      cashSplits.sort((a, b) => a.postDate.getTime() - b.postDate.getTime());
    }

    // Get all unique commodity GUIDs
    const commodityGuids = [...new Set(filteredAccounts.map(a => a.commodity_guid).filter(Boolean))];

    // Fetch all prices in date range for these commodities. Exclude
    // non-positive prices: GnuCash's split register records an implied
    // $0 price for zero-value transfers, which would zero out a holding
    // for the day (forward-fill picks it up) and show a false cliff.
    const prices = await prisma.prices.findMany({
      where: {
        commodity_guid: { in: commodityGuids as string[] },
        date: { gte: startDate },
        value_num: { gt: 0 },
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
    allSplits.forEach(split => {
      const dateStr = split.postDate.toISOString().split('T')[0];
      if (dateStr >= startDate.toISOString().split('T')[0]) {
        allDates.add(dateStr);
      }
    });
    cashSplits.forEach(split => {
      const dateStr = split.postDate.toISOString().split('T')[0];
      if (dateStr >= startDate.toISOString().split('T')[0]) {
        allDates.add(dateStr);
      }
    });
    allDates.add(startDate.toISOString().split('T')[0]);
    const sortedDates = Array.from(allDates).sort();

    // Running share totals per account (accumulated over time)
    const sharesByAccount = new Map<string, number>();
    let splitPointer = 0;
    // Running cash balance across all cash accounts (accumulated over time)
    let cashBalance = 0;
    let cashPointer = 0;

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

      // Advance cash pointer: accumulate cash balance with postDate <= dateEnd
      while (cashPointer < cashSplits.length && cashSplits[cashPointer].postDate <= dateEnd) {
        cashBalance += cashSplits[cashPointer].amount;
        cashPointer++;
      }

      // Update latest known prices for this date (forward-fill)
      for (const [commodityGuid, pricesByDate] of pricesByDateByCommodity) {
        const priceOnDate = pricesByDate.get(dateStr);
        if (priceOnDate !== undefined) {
          latestPricesByCommodity.set(commodityGuid, priceOnDate);
        }
      }

      // Calculate total portfolio value with point-in-time shares and latest known prices
      let portfolioValue = cashBalance;

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

    const cashFlows: CashFlowPoint[] = Array.from(cashFlowByDate.entries())
      .filter(([date]) => date >= startDate.toISOString().split('T')[0])
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Fetch market index data for the same date range (only for portfolio-wide requests)
    let indices: InvestmentHistoryResponse['indices'] = { sp500: [], djia: [], nasdaq: [], russell2000: [] };
    if (!filterAccountGuids) {
      try {
        const [sp500Raw, djiaRaw, nasdaqRaw, russell2000Raw] = await Promise.all([
          getIndexHistory('^GSPC', startDate),
          getIndexHistory('^DJI', startDate),
          getIndexHistory('^IXIC', startDate),
          getIndexHistory('^RUT', startDate),
        ]);

        indices = {
          sp500: normalizeToPercent(sp500Raw, startDate),
          djia: normalizeToPercent(djiaRaw, startDate),
          nasdaq: normalizeToPercent(nasdaqRaw, startDate),
          russell2000: normalizeToPercent(russell2000Raw, startDate),
        };
      } catch (err) {
        console.warn('Failed to fetch market index data for history:', err);
      }
    }

    return NextResponse.json({ history, cashFlows, indices });
  } catch (error) {
    console.error('Error fetching history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch history' },
      { status: 500 }
    );
  }
}
