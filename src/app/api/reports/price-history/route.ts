import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/reports/utils';
import { requireRole } from '@/lib/auth';

const GUID_RE = /^[0-9a-f]{32}$/i;

/**
 * Price history for one commodity from the GnuCash prices table.
 *
 * GET /api/reports/price-history?commodityGuid=&startDate=&endDate=
 *
 * The commodity list itself is served by the existing /api/commodities
 * endpoint (filter out namespace CURRENCY/template client-side).
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const commodityGuid = searchParams.get('commodityGuid');
        if (!commodityGuid || !GUID_RE.test(commodityGuid)) {
            return NextResponse.json({ error: 'commodityGuid is required' }, { status: 400 });
        }

        const commodity = await prisma.commodities.findUnique({
            where: { guid: commodityGuid },
            select: { guid: true, namespace: true, mnemonic: true, fullname: true },
        });
        if (!commodity) {
            return NextResponse.json({ error: 'Commodity not found' }, { status: 404 });
        }

        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        const prices = await prisma.prices.findMany({
            where: {
                commodity_guid: commodityGuid,
                ...(startDate || endDate
                    ? {
                          date: {
                              ...(startDate ? { gte: new Date(startDate + 'T00:00:00Z') } : {}),
                              ...(endDate ? { lte: new Date(endDate + 'T23:59:59Z') } : {}),
                          },
                      }
                    : {}),
            },
            select: {
                date: true,
                value_num: true,
                value_denom: true,
                source: true,
                type: true,
                currency: { select: { mnemonic: true } },
            },
            orderBy: { date: 'asc' },
        });

        return NextResponse.json({
            title: 'Price History',
            generatedAt: new Date().toISOString(),
            startDate,
            endDate,
            commodity,
            points: prices.map(p => ({
                date: p.date.toISOString().split('T')[0],
                value: toDecimal(p.value_num, p.value_denom),
                source: p.source,
                type: p.type,
                currency: p.currency.mnemonic,
            })),
        });
    } catch (error) {
        console.error('Error generating price history report:', error);
        return NextResponse.json(
            { error: 'Failed to generate price history report' },
            { status: 500 }
        );
    }
}
