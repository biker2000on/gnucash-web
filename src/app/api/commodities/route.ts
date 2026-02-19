import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { requireRole } from '@/lib/auth';

/**
 * @openapi
 * /api/commodities:
 *   get:
 *     description: Returns a list of commodities (currencies, stocks, etc.).
 *     parameters:
 *       - name: type
 *         in: query
 *         description: Filter by namespace (CURRENCY, STOCK, etc.)
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A list of commodities.
 */
export async function GET(request: NextRequest) {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    try {
        const searchParams = request.nextUrl.searchParams;
        const type = searchParams.get('type');

        const commodities = await prisma.commodities.findMany({
            where: type ? { namespace: type } : undefined,
            orderBy: [
                { namespace: 'asc' },
                { mnemonic: 'asc' },
            ],
            select: {
                guid: true,
                namespace: true,
                mnemonic: true,
                fullname: true,
                cusip: true,
                fraction: true,
                quote_flag: true,
                quote_source: true,
                quote_tz: true,
            },
        });

        return NextResponse.json(serializeBigInts(commodities));
    } catch (error) {
        console.error('Error fetching commodities:', error);
        return NextResponse.json({ error: 'Failed to fetch commodities' }, { status: 500 });
    }
}
