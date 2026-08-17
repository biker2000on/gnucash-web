/**
 * Investment Portfolio Report Generator
 *
 * Computes holdings for all STOCK/MUTUAL accounts including
 * shares, cost basis, market value, and unrealized gain/loss.
 */

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
    calculateMarketValue,
    calculateGainLoss,
    calculateGainLossPercent,
    totalHoldings,
    UNTRACED_BASIS_COVERAGE,
} from '@/lib/commodities';
import { getBaseCurrency } from '@/lib/currency';
import { WEEKEND_EVIDENCE_DAYS } from '@/lib/price-staleness';
import { ReportType, ReportFilters, InvestmentPortfolioData, PortfolioHolding } from './types';
import { sumSplitsByAccount, toDecimal } from './utils';

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

    // Report currency: price lookups must be filtered to it so a newer quote
    // in some other currency is never used as the report-currency price.
    const baseCurrency = await getBaseCurrency();

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
            commodity: { select: { mnemonic: true, fullname: true, namespace: true } },
        },
    });

    // Batch aggregate: shares (quantity sum) and cost basis (value sum) for
    // all accounts up to endDate in one GROUP BY query
    const holdingSums = await sumSplitsByAccount(
        accounts.map(a => a.guid),
        { lte: endDate }
    );

    // Batch price lookup: latest price per commodity up to endDate (in the
    // report currency) via one DISTINCT ON query instead of one per account
    const commodityGuids = [
        ...new Set(
            accounts
                .map(a => a.commodity_guid)
                .filter((g): g is string => g !== null)
        ),
    ];
    const priceRows = commodityGuids.length > 0
        ? await prisma.$queryRaw<Array<{
            commodity_guid: string;
            date: Date;
            value_num: bigint;
            value_denom: bigint;
            weekend_quote_days: bigint | number | null;
        }>>`
            WITH latest AS (
                SELECT DISTINCT ON (commodity_guid)
                       commodity_guid, date, value_num, value_denom
                FROM prices
                WHERE commodity_guid = ANY(${commodityGuids}::text[])
                  AND date <= ${endDate}
                  -- GnuCash's split register records implied $0 prices for
                  -- zero-value transfer transactions; never value holdings with them
                  AND value_num > 0
                  ${baseCurrency ? Prisma.sql`AND currency_guid = ${baseCurrency.guid}` : Prisma.empty}
                ORDER BY commodity_guid, date DESC
            ),
            -- Quotes on days an exchange would be shut: the observed evidence
            -- that a commodity's venue never closes, which is what decides how
            -- old its price may be before the table says so. Read from the price
            -- history rather than from the commodity namespace, which is free
            -- text and carries whatever an importer wrote.
            weekend AS (
                SELECT commodity_guid, COUNT(DISTINCT date::date) AS weekend_quote_days
                FROM prices
                WHERE commodity_guid = ANY(${commodityGuids}::text[])
                  AND date <= ${endDate}
                  AND date > ${endDate}::timestamp - make_interval(days => ${WEEKEND_EVIDENCE_DAYS})
                  AND value_num > 0
                  AND EXTRACT(ISODOW FROM date) >= 6
                GROUP BY commodity_guid
            )
            SELECT latest.*, COALESCE(weekend.weekend_quote_days, 0) AS weekend_quote_days
            FROM latest
            LEFT JOIN weekend ON weekend.commodity_guid = latest.commodity_guid
        `
        : [];
    const priceByCommodity = new Map(
        priceRows.map(p => [p.commodity_guid, {
            value: toDecimal(p.value_num, p.value_denom),
            date: p.date,
            // COUNT() crosses the wire as a bigint.
            weekendQuoteDays: Number(p.weekend_quote_days ?? 0),
        }])
    );

    const holdingResults = accounts.map((account): PortfolioHolding | null => {
        const sums = holdingSums.get(account.guid);
        const shares = sums?.quantity ?? 0;

        // Skip zero-share accounts unless requested
        const isZeroShares = Math.abs(shares) < 0.0001;
        if (isZeroShares && !showZeroShares) {
            return null;
        }

        const costBasis = isZeroShares ? 0 : (sums?.value ?? 0);
        const symbol = account.commodity?.mnemonic || '???';

        // Latest price up to endDate (in the report currency)
        const priceData = account.commodity_guid
            ? priceByCommodity.get(account.commodity_guid) ?? null
            : null;
        const latestPrice = priceData?.value || 0;
        const priceDate = priceData?.date
            ? priceData.date.toISOString().split('T')[0]
            : '';

        const effectiveShares = isZeroShares ? 0 : shares;
        const marketValue = isZeroShares ? 0 : calculateMarketValue(effectiveShares, latestPrice);
        // This report sums raw split values with no transfer tracing, so it
        // cannot say how much of the position that basis covers. The statement
        // now travels into the report data instead of being made and dropped:
        // the table cannot render an unverified basis as a complete one if it
        // has to narrow on the coverage to display it.
        const costBasisCoverage = UNTRACED_BASIS_COVERAGE;
        const gain = calculateGainLoss({
            shares: effectiveShares,
            pricePerShare: latestPrice,
            costBasis,
            coverage: costBasisCoverage,
        });
        const gainPercent = calculateGainLossPercent(gain, costBasis);

        return {
            guid: account.guid,
            accountName: account.name,
            symbol,
            shares: effectiveShares,
            latestPrice,
            priceDate,
            // Travel with the quote date they qualify: the table needs all three
            // to judge whether this price is too old to stand for "current".
            // Namespace alone would not do it — it is free text, so the crypto in
            // an imported book may be filed under anything at all; the weekend
            // count is the evidence that settles it either way.
            commodityNamespace: account.commodity?.namespace ?? null,
            priceWeekendQuoteDays: priceData?.weekendQuoteDays ?? 0,
            marketValue,
            costBasis,
            costBasisCoverage,
            gain,
            gainPercent,
        };
    });

    // Filter out nulls (zero-share accounts that were skipped)
    const holdings = holdingResults.filter((h): h is PortfolioHolding => h !== null);

    // Sort by account name
    holdings.sort((a, b) => a.accountName.localeCompare(b.accountName));

    // Compute totals through the shared helper, which SUMS the per-holding
    // gains and pools their coverage. `totalMarketValue - totalCostBasis` is
    // the same subtraction that made the account view disagree with its own
    // rows: it happens to match today because every row here is unknown-coverage
    // (whole-position gain), and would silently overstate the total the moment
    // one row's basis covered only part of its shares.
    const totals = totalHoldings(holdings.map(h => ({
        costBasis: h.costBasis,
        costBasisCoverage: h.costBasisCoverage,
        marketValue: h.marketValue,
        gainLoss: h.gain,
    })));

    return {
        type: ReportType.INVESTMENT_PORTFOLIO,
        title: 'Investment Portfolio',
        generatedAt: new Date().toISOString(),
        filters,
        holdings,
        totals: {
            marketValue: totals.totalValue,
            costBasis: totals.totalCostBasis,
            costBasisCoverage: totals.totalCostBasisCoverage,
            gain: totals.totalGainLoss,
            gainPercent: totals.totalGainLossPercent,
        },
        showZeroShares,
    };
}
