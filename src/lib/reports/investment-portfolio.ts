/**
 * Investment Portfolio Report Generator
 *
 * Computes holdings for all STOCK/MUTUAL accounts including
 * shares, cost basis, market value, and unrealized gain/loss.
 */

import prisma from '@/lib/prisma';
import { getLatestPrice, calculateShares, calculateCostBasis, calculateMarketValue, calculateGainLoss, calculateGainLossPercent } from '@/lib/commodities';
import { ReportType, ReportFilters, InvestmentPortfolioData, PortfolioHolding } from './types';

/**
 * Generate Investment Portfolio report data.
 *
 * @param filters - Standard report filters (endDate determines valuation date)
 * @param showZeroShares - If true, include accounts with zero shares (default false)
 */
export async function generateInvestmentPortfolio(
    filters: ReportFilters,
    showZeroShares: boolean = false
): Promise<InvestmentPortfolioData> {
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Get all STOCK and MUTUAL accounts (include hidden - investment accounts may be hidden)
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: { in: ['STOCK', 'MUTUAL'] },
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            commodity_guid: true,
            commodity: { select: { mnemonic: true, fullname: true } },
        },
    });

    // Process each account in parallel
    const holdingResults = await Promise.all(
        accounts.map(async (account): Promise<PortfolioHolding | null> => {
            // Get all splits up to endDate
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: { lte: endDate },
                    },
                },
                select: {
                    quantity_num: true,
                    quantity_denom: true,
                    value_num: true,
                    value_denom: true,
                },
            });

            const shares = calculateShares(splits);

            // Skip zero-share accounts unless requested
            const isZeroShares = Math.abs(shares) < 0.0001;
            if (isZeroShares && !showZeroShares) {
                return null;
            }

            const costBasis = isZeroShares ? 0 : calculateCostBasis(splits);
            const symbol = account.commodity?.mnemonic || '???';

            // Get latest price up to endDate
            const priceData = account.commodity_guid
                ? await getLatestPrice(account.commodity_guid, undefined, endDate)
                : null;
            const latestPrice = priceData?.value || 0;
            const priceDate = priceData?.date
                ? priceData.date.toISOString().split('T')[0]
                : '';

            const effectiveShares = isZeroShares ? 0 : shares;
            const marketValue = isZeroShares ? 0 : calculateMarketValue(effectiveShares, latestPrice);
            const gain = calculateGainLoss(marketValue, costBasis);
            const gainPercent = calculateGainLossPercent(gain, costBasis);

            return {
                guid: account.guid,
                accountName: account.name,
                symbol,
                shares: effectiveShares,
                latestPrice,
                priceDate,
                marketValue,
                costBasis,
                gain,
                gainPercent,
            };
        })
    );

    // Filter out nulls (zero-share accounts that were skipped)
    const holdings = holdingResults.filter((h): h is PortfolioHolding => h !== null);

    // Sort by account name
    holdings.sort((a, b) => a.accountName.localeCompare(b.accountName));

    // Compute totals
    const totalMarketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalCostBasis = holdings.reduce((sum, h) => sum + h.costBasis, 0);
    const totalGain = totalMarketValue - totalCostBasis;
    const totalGainPercent = totalCostBasis !== 0
        ? (totalGain / Math.abs(totalCostBasis)) * 100
        : 0;

    return {
        type: ReportType.INVESTMENT_PORTFOLIO,
        title: 'Investment Portfolio',
        generatedAt: new Date().toISOString(),
        filters,
        holdings,
        totals: {
            marketValue: totalMarketValue,
            costBasis: totalCostBasis,
            gain: totalGain,
            gainPercent: totalGainPercent,
        },
        showZeroShares,
    };
}
