import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { requireRole } from '@/lib/auth';
import { z } from 'zod';

const UpdateCommoditySchema = z.object({
    guid: z.string().length(32, 'Invalid commodity GUID'),
    quote_flag: z.boolean(),
    quote_source: z.string().max(255).nullable().optional(),
    quote_tz: z.string().max(255).nullable().optional(),
});

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

export async function PATCH(request: NextRequest) {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    try {
        const body = await request.json().catch(() => null);
        const parseResult = UpdateCommoditySchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const data = parseResult.data;

        const updated = await prisma.commodities.update({
            where: { guid: data.guid },
            data: {
                quote_flag: data.quote_flag ? 1 : 0,
                quote_source: data.quote_source ?? null,
                quote_tz: data.quote_tz ?? null,
            },
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

        return NextResponse.json(serializeBigInts(updated));
    } catch (error) {
        console.error('Error updating commodity:', error);
        return NextResponse.json({ error: 'Failed to update commodity' }, { status: 500 });
    }
}
