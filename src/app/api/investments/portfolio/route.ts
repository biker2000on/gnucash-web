import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccountHoldings } from '@/lib/commodities';
import { getBookAccountGuids } from '@/lib/book-scope';

interface PortfolioResponse {
  summary: {
    totalValue: number;
    totalCostBasis: number;
    totalGainLoss: number;
    totalGainLossPercent: number;
    dayChange: number;
    dayChangePercent: number;
  };
  holdings: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    commodityGuid: string;
    symbol: string;
    fullname: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
    latestPrice: number;
    priceDate: string;
  }>;
  allocation: Array<{
    category: string;
    value: number;
    percent: number;
  }>;
}

/**
 * Extract category from account path for allocation grouping
 * Uses the parent folder name (second-to-last segment)
 */
function extractAccountCategory(accountPath: string): string {
  const parts = accountPath.split(':');
  if (parts.length >= 3) {
    return parts[parts.length - 2]; // Parent folder
  }
  return parts[parts.length - 1] || 'Other';
}

/**
 * Build account path by traversing parent relationships
 */
async function buildAccountPath(accountGuid: string): Promise<string> {
  const pathSegments: string[] = [];
  let currentGuid: string | null = accountGuid;

  while (currentGuid) {
    const account: { name: string; parent_guid: string | null } | null =
      await prisma.accounts.findUnique({
        where: { guid: currentGuid },
        select: { name: true, parent_guid: true },
      });

    if (!account) break;

    pathSegments.unshift(account.name);
    currentGuid = account.parent_guid;
  }

  return pathSegments.join(':');
}

export async function GET() {
  try {
    // Get book account GUIDs for scoping
    const bookAccountGuids = await getBookAccountGuids();

    // Get all STOCK accounts with non-CURRENCY commodities in active book
    const stockAccounts = await prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
        account_type: { in: ['STOCK', 'MUTUAL'] },
        commodity: {
          namespace: { not: 'CURRENCY' },
        },
      },
      include: {
        commodity: {
          select: {
            guid: true,
            mnemonic: true,
            fullname: true,
          },
        },
      },
    });

    // Build holdings data for each account
    const holdingsPromises = stockAccounts.map(async (account) => {
      const holdings = await getAccountHoldings(account.guid);
      const accountPath = await buildAccountPath(account.guid);

      return {
        accountGuid: account.guid,
        accountName: account.name,
        accountPath,
        commodityGuid: account.commodity_guid!,
        symbol: account.commodity?.mnemonic || '',
        fullname: account.commodity?.fullname || '',
        shares: holdings.shares,
        costBasis: holdings.costBasis,
        marketValue: holdings.marketValue,
        gainLoss: holdings.gainLoss,
        gainLossPercent: holdings.gainLossPercent,
        latestPrice: holdings.latestPrice?.value || 0,
        priceDate: holdings.latestPrice?.date.toISOString() || '',
      };
    });

    const holdings = (await Promise.all(holdingsPromises)).filter(h => h.shares !== 0);

    // Calculate portfolio summary
    const summary = holdings.reduce(
      (acc, holding) => ({
        totalValue: acc.totalValue + holding.marketValue,
        totalCostBasis: acc.totalCostBasis + holding.costBasis,
        totalGainLoss: acc.totalGainLoss + holding.gainLoss,
        totalGainLossPercent: 0, // Calculated after
        dayChange: 0, // Requires previous close tracking (not implemented yet)
        dayChangePercent: 0,
      }),
      {
        totalValue: 0,
        totalCostBasis: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        dayChange: 0,
        dayChangePercent: 0,
      }
    );

    // Calculate total gain/loss percentage
    if (summary.totalCostBasis !== 0) {
      summary.totalGainLossPercent =
        (summary.totalGainLoss / Math.abs(summary.totalCostBasis)) * 100;
    }

    // Build allocation by category
    const categoryMap = new Map<string, number>();

    holdings.forEach((holding) => {
      const category = extractAccountCategory(holding.accountPath);
      const currentValue = categoryMap.get(category) || 0;
      categoryMap.set(category, currentValue + holding.marketValue);
    });

    const allocation = Array.from(categoryMap.entries()).map(([category, value]) => ({
      category,
      value,
      percent: summary.totalValue > 0 ? (value / summary.totalValue) * 100 : 0,
    }));

    // Sort allocation by value descending
    allocation.sort((a, b) => b.value - a.value);

    const response: PortfolioResponse = {
      summary,
      holdings,
      allocation,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Portfolio API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch portfolio data' },
      { status: 500 }
    );
  }
}
