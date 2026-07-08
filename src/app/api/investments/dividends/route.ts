import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getAccountHoldings, type CostBasisOptions } from '@/lib/commodities';
import { createCostBasisCache, type CostBasisMethod } from '@/lib/cost-basis';
import {
    loadDividendPayments,
    summarizeDividends,
    type SecurityValuation,
} from '@/lib/dividends';

/**
 * GET /api/investments/dividends
 *
 * Query params:
 *   - year (optional): calendar year to add a per-year column; default view is
 *     trailing-12-months.
 *   - costBasisMethod (optional): fifo | lifo | average (default fifo)
 *   - costBasisCarryOver (optional): 'false' disables transfer cost tracing
 *
 * Returns totals, per-security breakdown with yields, a monthly income series,
 * and a forward payment calendar.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const yearParam = searchParams.get('year');
        const year = yearParam ? parseInt(yearParam, 10) : null;
        const costBasisCarryOver = searchParams.get('costBasisCarryOver') !== 'false';
        const costBasisMethod = (searchParams.get('costBasisMethod') || 'fifo') as CostBasisMethod;

        const bookAccountGuids = await getBookAccountGuids();

        // 1. Load dividend payments resolved to their paying security.
        const payments = await loadDividendPayments(bookAccountGuids);

        // 2. Build per-security valuations (cost basis + market value) so we can
        //    compute yield-on-cost and current yield. Reuses the same holdings
        //    engine as the portfolio report.
        const costBasisCache = createCostBasisCache();
        const costBasisOptions: CostBasisOptions | undefined = costBasisCarryOver
            ? { enabled: true, method: costBasisMethod, cache: costBasisCache }
            : undefined;

        const stockAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
                account_type: { in: ['STOCK', 'MUTUAL'] },
                commodity: { namespace: { not: 'CURRENCY' } },
            },
            include: { commodity: { select: { guid: true, mnemonic: true } } },
        });

        // Aggregate holdings per commodity across all investment accounts.
        const byCommodity = new Map<string, SecurityValuation>();
        await Promise.all(
            stockAccounts.map(async (account) => {
                const commodityGuid = account.commodity_guid;
                if (!commodityGuid) return;
                const holdings = await getAccountHoldings(account.guid, undefined, costBasisOptions);
                if (Math.abs(holdings.shares) < 0.0001 && Math.abs(holdings.marketValue) < 0.01) return;
                const ticker = account.commodity?.mnemonic || '???';
                const existing = byCommodity.get(commodityGuid);
                if (existing) {
                    existing.costBasis += holdings.costBasis;
                    existing.marketValue += holdings.marketValue;
                } else {
                    byCommodity.set(commodityGuid, {
                        commodityGuid,
                        ticker,
                        costBasis: holdings.costBasis,
                        marketValue: holdings.marketValue,
                    });
                }
            }),
        );

        // Key valuations by both commodity GUID and ticker so ticker-only
        // (cash-dividend) securities can still resolve a valuation.
        const valuations = new Map<string, SecurityValuation>();
        for (const val of byCommodity.values()) {
            valuations.set(`c:${val.commodityGuid}`, val);
            if (!valuations.has(`t:${val.ticker}`)) {
                valuations.set(`t:${val.ticker}`, val);
            }
        }

        // 3. Assemble the report (pure).
        const summary = summarizeDividends(payments, {
            asOf: new Date(),
            year,
            valuations,
        });

        return NextResponse.json(summary);
    } catch (error) {
        console.error('Dividends API error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch dividend data' },
            { status: 500 },
        );
    }
}
