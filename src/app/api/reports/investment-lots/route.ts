import { NextRequest, NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { getLatestPrice } from '@/lib/commodities';
import { buildAccountPathMap } from '@/lib/reports/utils';

interface LotReportRow {
    accountName: string;
    accountGuid: string;
    commodityMnemonic: string;
    lotTitle: string;
    lotGuid: string;
    isClosed: boolean;
    openDate: string | null;
    closeDate: string | null;
    shares: number;
    costBasis: number;
    marketValue: number | null;
    realizedGain: number;
    unrealizedGain: number | null;
    totalGain: number | null;
    holdingPeriod: 'short_term' | 'long_term' | null;
    daysHeld: number | null;
}

interface InvestmentLotsReportData {
    rows: LotReportRow[];
    summary: {
        totalCostBasis: number;
        totalMarketValue: number | null;
        totalRealizedGain: number;
        totalUnrealizedGain: number | null;
        openLotCount: number;
        closedLotCount: number;
        shortTermCount: number;
        longTermCount: number;
    };
    generatedAt: string;
}

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const showClosed = searchParams.get('showClosed') === 'true';
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const bookAccountGuids = await getBookAccountGuids();

        // Find all investment accounts (STOCK, MUTUAL) in the active book
        const investmentAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
                account_type: { in: ['STOCK', 'MUTUAL'] },
            },
            include: {
                commodity: true,
                lots: {
                    include: {
                        splits: {
                            include: {
                                transaction: true,
                            },
                            orderBy: {
                                transaction: { post_date: 'asc' },
                            },
                        },
                    },
                },
            },
        });

        const accountPathMap = await buildAccountPathMap(bookAccountGuids);
        const now = new Date();
        const rows: LotReportRow[] = [];

        for (const account of investmentAccounts) {
            const accountName = accountPathMap.get(account.guid) || account.name;
            const commodityMnemonic = account.commodity?.mnemonic || '';
            const commodityGuid = account.commodity_guid;

            // Get current price for unrealized gain calculation
            let currentPrice: number | null = null;
            if (commodityGuid) {
                try {
                    const priceData = await getLatestPrice(commodityGuid);
                    if (priceData) currentPrice = priceData.value;
                } catch {
                    // No price available
                }
            }

            // Get lot titles from slots table
            const lotGuids = account.lots.map(l => l.guid);
            const lotTitleSlots = lotGuids.length > 0
                ? await prisma.slots.findMany({
                    where: {
                        obj_guid: { in: lotGuids },
                        name: 'title',
                    },
                })
                : [];
            const lotTitleMap = new Map(lotTitleSlots.map(s => [s.obj_guid, s.string_val || '']));

            for (const lot of account.lots) {
                if (!showClosed && lot.is_closed === 1) continue;

                const splits = lot.splits;
                if (splits.length === 0) continue;

                // Calculate lot metrics
                let totalShares = 0;
                let buyCost = 0;
                let totalValue = 0;

                for (const split of splits) {
                    const qty = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
                    const val = parseFloat(toDecimal(split.value_num, split.value_denom));
                    totalShares += qty;
                    totalValue += val;
                    if (qty > 0) {
                        buyCost += Math.abs(val);
                    }
                }

                // Dates
                const openDate = splits[0]?.transaction?.post_date
                    ? new Date(splits[0].transaction.post_date).toISOString().split('T')[0]
                    : null;
                const lastSplitDate = splits[splits.length - 1]?.transaction?.post_date;
                const closeDate = lot.is_closed === 1 && lastSplitDate
                    ? new Date(lastSplitDate).toISOString().split('T')[0]
                    : null;

                // Realized gain for closed lots: sum of all split values
                const realizedGain = lot.is_closed === 1 ? totalValue : 0;

                // Unrealized gain for open lots
                const unrealizedGain = lot.is_closed !== 1 && currentPrice !== null && totalShares !== 0
                    ? (currentPrice * totalShares) - buyCost
                    : null;

                const marketValue = lot.is_closed !== 1 && currentPrice !== null
                    ? currentPrice * totalShares
                    : null;

                // Holding period
                let holdingPeriod: 'short_term' | 'long_term' | null = null;
                let daysHeld: number | null = null;
                if (openDate) {
                    const openMs = new Date(openDate).getTime();
                    const endMs = closeDate ? new Date(closeDate).getTime() : now.getTime();
                    daysHeld = Math.floor((endMs - openMs) / (1000 * 60 * 60 * 24));
                    holdingPeriod = daysHeld >= 365 ? 'long_term' : 'short_term';
                }

                const lotTitle = lotTitleMap.get(lot.guid) || `Lot ${account.lots.indexOf(lot) + 1}`;

                // Date filtering: skip lots opened after the end date,
                // or closed lots that closed before the start date
                if (endDate && openDate && openDate > endDate) continue;
                if (startDate && lot.is_closed === 1 && closeDate && closeDate < startDate) continue;

                rows.push({
                    accountName,
                    accountGuid: account.guid,
                    commodityMnemonic,
                    lotTitle,
                    lotGuid: lot.guid,
                    isClosed: lot.is_closed === 1,
                    openDate,
                    closeDate,
                    shares: totalShares,
                    costBasis: buyCost,
                    marketValue,
                    realizedGain,
                    unrealizedGain,
                    totalGain: unrealizedGain !== null ? unrealizedGain : (lot.is_closed === 1 ? realizedGain : null),
                    holdingPeriod,
                    daysHeld,
                });
            }
        }

        // Sort: open lots first, then by account name, then by open date
        rows.sort((a, b) => {
            if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
            if (a.accountName !== b.accountName) return a.accountName.localeCompare(b.accountName);
            if (a.openDate && b.openDate) return a.openDate.localeCompare(b.openDate);
            return 0;
        });

        const summary = {
            totalCostBasis: rows.filter(r => !r.isClosed).reduce((s, r) => s + r.costBasis, 0),
            totalMarketValue: rows.some(r => r.marketValue !== null)
                ? rows.filter(r => !r.isClosed).reduce((s, r) => s + (r.marketValue || 0), 0)
                : null,
            totalRealizedGain: rows.filter(r => r.isClosed).reduce((s, r) => s + r.realizedGain, 0),
            totalUnrealizedGain: rows.some(r => r.unrealizedGain !== null)
                ? rows.filter(r => !r.isClosed).reduce((s, r) => s + (r.unrealizedGain || 0), 0)
                : null,
            openLotCount: rows.filter(r => !r.isClosed).length,
            closedLotCount: rows.filter(r => r.isClosed).length,
            shortTermCount: rows.filter(r => r.holdingPeriod === 'short_term').length,
            longTermCount: rows.filter(r => r.holdingPeriod === 'long_term').length,
        };

        const reportData: InvestmentLotsReportData = {
            rows,
            summary,
            generatedAt: new Date().toISOString(),
        };

        return NextResponse.json(reportData);
    } catch (error) {
        console.error('Error generating investment lots report:', error);
        return NextResponse.json(
            { error: 'Failed to generate investment lots report' },
            { status: 500 }
        );
    }
}
