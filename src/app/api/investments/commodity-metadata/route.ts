import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { refreshAllMetadata, refreshMetadata } from '@/lib/commodity-metadata';

const RefreshSchema = z.object({
    /**
     * Optional symbol list. When present, metadata for these held
     * commodities is force-refreshed from Yahoo Finance (bypassing the
     * 7-day cache TTL). When omitted, all quotable commodities with a
     * missing/expired cache are refreshed.
     */
    symbols: z.array(z.string().min(1).max(50)).max(200).optional(),
});

/**
 * POST /api/investments/commodity-metadata
 *
 * Backfill sector/industry/sector-weight metadata
 * (gnucash_web_commodity_metadata) via the existing yahoo-finance2
 * quoteSummary path (assetProfile for stocks, topHoldings sector
 * weightings for funds/ETFs).
 *
 * Body: { symbols?: string[] }
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        let symbols: string[] | undefined;
        try {
            const body = await request.json();
            symbols = RefreshSchema.parse(body).symbols;
        } catch (err) {
            if (err instanceof z.ZodError) {
                return NextResponse.json(
                    { error: 'Invalid payload', details: err.issues },
                    { status: 400 }
                );
            }
            // Empty body is fine — refresh everything stale.
        }

        if (symbols && symbols.length > 0) {
            // Targeted force-refresh for held commodities matching the symbols.
            const bookAccountGuids = await getBookAccountGuids();
            const accounts = await prisma.accounts.findMany({
                where: {
                    guid: { in: bookAccountGuids },
                    account_type: { in: ['STOCK', 'MUTUAL'] },
                    commodity: {
                        mnemonic: { in: symbols },
                        namespace: { not: 'CURRENCY' },
                    },
                },
                select: {
                    commodity: { select: { guid: true, mnemonic: true } },
                },
            });

            const byGuid = new Map<string, string>();
            for (const a of accounts) {
                if (a.commodity) byGuid.set(a.commodity.guid, a.commodity.mnemonic);
            }

            let refreshed = 0;
            let failed = 0;
            for (const [guid, mnemonic] of byGuid) {
                const result = await refreshMetadata(guid, mnemonic);
                if (result) refreshed++;
                else failed++;
            }

            return NextResponse.json({
                refreshed,
                skipped: 0,
                failed,
                requested: symbols.length,
                matched: byGuid.size,
            });
        }

        const result = await refreshAllMetadata();
        return NextResponse.json(result);
    } catch (error) {
        console.error('Commodity metadata refresh error:', error);
        return NextResponse.json(
            { error: 'Failed to refresh commodity metadata' },
            { status: 500 }
        );
    }
}
