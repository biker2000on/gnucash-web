import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccountHoldings } from '@/lib/commodities';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getCachedMetadata, getPortfolioSectorExposure } from '@/lib/commodity-metadata';
import type { SectorExposure } from '@/lib/commodity-metadata';
import { requireRole } from '@/lib/auth';

interface CashByAccount {
  parentGuid: string;
  parentName: string;
  parentPath: string;
  cashBalance: number;
  investmentValue: number;
  cashPercent: number;
}

interface OverallCash {
  totalCashBalance: number;
  totalInvestmentValue: number;
  totalValue: number;
  cashPercent: number;
}

interface ConsolidatedHolding {
  commodityGuid: string;
  symbol: string;
  fullname: string;
  totalShares: number;
  totalCostBasis: number;
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  latestPrice: number;
  priceDate: string;
  accounts: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
  }>;
}

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
  cashByAccount: CashByAccount[];
  overallCash: OverallCash;
  sectorExposure: SectorExposure[];
  consolidatedHoldings: ConsolidatedHolding[];
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
 * Build account path by traversing parent relationships using pre-fetched lookup
 */
function buildAccountPathFromMap(
  accountGuid: string,
  lookup: Map<string, { name: string; parent_guid: string | null }>
): string {
  const segments: string[] = [];
  let currentGuid: string | null = accountGuid;
  while (currentGuid) {
    const account = lookup.get(currentGuid);
    if (!account) break;
    segments.unshift(account.name);
    currentGuid = account.parent_guid;
  }
  return segments.join(':');
}

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    // Get book account GUIDs for scoping
    const bookAccountGuids = await getBookAccountGuids();

    // Pre-fetch all accounts for path building (eliminates N+1 queries)
    const allBookAccounts = await prisma.accounts.findMany({
      where: { guid: { in: bookAccountGuids } },
      select: { guid: true, name: true, parent_guid: true, account_type: true },
    });
    const accountLookup = new Map(allBookAccounts.map(a => [a.guid, { name: a.name, parent_guid: a.parent_guid }]));

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
      const accountPath = buildAccountPathFromMap(account.guid, accountLookup);

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
        parentGuid: account.parent_guid,
      };
    });

    const allHoldings = await Promise.all(holdingsPromises);

    // Filter out fully closed positions (zero shares AND zero market value)
    const holdings = allHoldings.filter(h => Math.abs(h.shares) >= 0.0001 || Math.abs(h.marketValue) >= 0.01);

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

    // ===== T2.1: Cash Detection =====
    // Find parent accounts of STOCK/MUTUAL accounts and detect cash siblings
    const parentGuids = new Set<string>();
    for (const h of holdings) {
      if (h.parentGuid) parentGuids.add(h.parentGuid);
    }

    // For each parent, find sibling BANK/ASSET/CASH accounts
    const cashByAccount: CashByAccount[] = [];
    const cashAccountTypes = ['BANK', 'ASSET', 'CASH'];

    for (const parentGuid of parentGuids) {
      // Find cash siblings under this parent
      const cashSiblings = allBookAccounts.filter(
        a => a.parent_guid === parentGuid && cashAccountTypes.includes(a.account_type)
      );

      // Sum cash balances from splits
      let cashBalance = 0;
      for (const cashAccount of cashSiblings) {
        const splits = await prisma.splits.findMany({
          where: { account_guid: cashAccount.guid },
          select: { value_num: true, value_denom: true },
        });
        for (const split of splits) {
          const num = Number(split.value_num);
          const denom = Number(split.value_denom);
          if (denom !== 0) cashBalance += num / denom;
        }
      }

      // Sum investment value for holdings under this parent
      const investmentValue = holdings
        .filter(h => h.parentGuid === parentGuid)
        .reduce((sum, h) => sum + h.marketValue, 0);

      const parentPath = buildAccountPathFromMap(parentGuid, accountLookup);
      const parentAccount = accountLookup.get(parentGuid);
      const totalAccountValue = cashBalance + investmentValue;

      cashByAccount.push({
        parentGuid,
        parentName: parentAccount?.name || 'Unknown',
        parentPath,
        cashBalance: Math.round(cashBalance * 100) / 100,
        investmentValue: Math.round(investmentValue * 100) / 100,
        cashPercent: totalAccountValue > 0
          ? Math.round((cashBalance / totalAccountValue) * 10000) / 100
          : 0,
      });
    }

    // Calculate overall cash totals
    const totalCashBalance = cashByAccount.reduce((sum, c) => sum + c.cashBalance, 0);
    const totalInvestmentValue = cashByAccount.reduce((sum, c) => sum + c.investmentValue, 0);
    const totalPortfolioValue = totalCashBalance + totalInvestmentValue;

    const overallCash: OverallCash = {
      totalCashBalance: Math.round(totalCashBalance * 100) / 100,
      totalInvestmentValue: Math.round(totalInvestmentValue * 100) / 100,
      totalValue: Math.round(totalPortfolioValue * 100) / 100,
      cashPercent: totalPortfolioValue > 0
        ? Math.round((totalCashBalance / totalPortfolioValue) * 10000) / 100
        : 0,
    };

    // ===== T2.2: Sector Exposure =====
    // Build holdings input for sector calculation
    const holdingsForSector = holdings.map(h => ({
      commodityGuid: h.commodityGuid,
      marketValue: h.marketValue,
    }));

    let sectorExposure: SectorExposure[] = [];
    try {
      sectorExposure = await getPortfolioSectorExposure(holdingsForSector);
    } catch (err) {
      console.warn('Failed to compute sector exposure:', err);
    }

    // Trigger background refresh for commodities without metadata
    const uniqueCommodityGuids = [...new Set(holdings.map(h => h.commodityGuid))];
    refreshMissingMetadata(uniqueCommodityGuids, stockAccounts).catch(() => {});

    // ===== T2.3: Commodity Deduplication =====
    const commodityGroups = new Map<string, typeof holdings>();
    for (const h of holdings) {
      const existing = commodityGroups.get(h.commodityGuid) || [];
      existing.push(h);
      commodityGroups.set(h.commodityGuid, existing);
    }

    const consolidatedHoldings: ConsolidatedHolding[] = [];
    for (const [commodityGuid, group] of commodityGroups) {
      const totalShares = group.reduce((s, h) => s + h.shares, 0);
      const totalCostBasis = group.reduce((s, h) => s + h.costBasis, 0);
      const totalMarketValue = group.reduce((s, h) => s + h.marketValue, 0);
      const totalGainLoss = totalMarketValue - totalCostBasis;
      const totalGainLossPercent = totalCostBasis !== 0
        ? (totalGainLoss / Math.abs(totalCostBasis)) * 100
        : 0;

      // Use the first holding's price info (same commodity = same price)
      const first = group[0];

      consolidatedHoldings.push({
        commodityGuid,
        symbol: first.symbol,
        fullname: first.fullname,
        totalShares: Math.round(totalShares * 10000) / 10000,
        totalCostBasis: Math.round(totalCostBasis * 100) / 100,
        totalMarketValue: Math.round(totalMarketValue * 100) / 100,
        totalGainLoss: Math.round(totalGainLoss * 100) / 100,
        totalGainLossPercent: Math.round(totalGainLossPercent * 100) / 100,
        latestPrice: first.latestPrice,
        priceDate: first.priceDate,
        accounts: group.map(h => ({
          accountGuid: h.accountGuid,
          accountName: h.accountName,
          accountPath: h.accountPath,
          shares: h.shares,
          costBasis: h.costBasis,
          marketValue: h.marketValue,
          gainLoss: h.gainLoss,
          gainLossPercent: h.gainLossPercent,
        })),
      });
    }

    // Sort consolidated holdings by market value descending
    consolidatedHoldings.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    // Strip parentGuid from holdings response (internal field)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const holdingsResponse = holdings.map(({ parentGuid: _pg, ...rest }) => rest);

    const response: PortfolioResponse = {
      summary,
      holdings: holdingsResponse,
      allocation,
      cashByAccount,
      overallCash,
      sectorExposure,
      consolidatedHoldings,
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

/**
 * Trigger background refresh for commodities missing metadata.
 * Does not block the response.
 */
async function refreshMissingMetadata(
  commodityGuids: string[],
  stockAccounts: Array<{ commodity_guid: string | null; commodity: { mnemonic: string } | null }>
) {
  const { refreshMetadata } = await import('@/lib/commodity-metadata');

  for (const guid of commodityGuids) {
    const cached = await getCachedMetadata(guid);
    if (cached) continue;

    // Find the symbol for this commodity
    const account = stockAccounts.find(a => a.commodity_guid === guid);
    const symbol = account?.commodity?.mnemonic;
    if (symbol) {
      await refreshMetadata(guid, symbol).catch(() => {});
    }
  }
}
