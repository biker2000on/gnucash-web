import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts, generateGuid } from '@/lib/gnucash';
import { requireRole } from '@/lib/auth';
import { z } from 'zod';

const UpdateCommoditySchema = z.object({
    guid: z.string().length(32, 'Invalid commodity GUID'),
    namespace: z.string().min(1).max(2048).optional(),
    mnemonic: z.string().min(1).max(2048).optional(),
    fullname: z.string().max(2048).nullable().optional(),
    cusip: z.string().max(2048).nullable().optional(),
    fraction: z.number().int().positive().optional(),
    quote_flag: z.boolean().optional(),
    quote_source: z.string().max(255).nullable().optional(),
    quote_tz: z.string().max(255).nullable().optional(),
});

const CreateCommoditySchema = z.object({
    namespace: z.string().min(1).max(2048),
    mnemonic: z.string().min(1).max(2048),
    fullname: z.string().max(2048).nullable().optional(),
    cusip: z.string().max(2048).nullable().optional(),
    fraction: z.number().int().positive(),
    quote_flag: z.boolean().optional(),
    quote_source: z.string().max(255).nullable().optional(),
    quote_tz: z.string().max(255).nullable().optional(),
});

const COMMODITY_SELECT = {
    guid: true,
    namespace: true,
    mnemonic: true,
    fullname: true,
    cusip: true,
    fraction: true,
    quote_flag: true,
    quote_source: true,
    quote_tz: true,
} as const;

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
            select: COMMODITY_SELECT,
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

        const { guid, quote_flag, ...rest } = parseResult.data;

        const updateData: Record<string, unknown> = { ...rest };
        if (quote_flag !== undefined) {
            updateData.quote_flag = quote_flag ? 1 : 0;
        }

        const updated = await prisma.commodities.update({
            where: { guid },
            data: updateData,
            select: COMMODITY_SELECT,
        });

        return NextResponse.json(serializeBigInts(updated));
    } catch (error: unknown) {
        const code = (error as { code?: string } | null)?.code;
        if (code === 'P2002') {
            return NextResponse.json(
                { error: 'A commodity with this namespace and symbol already exists' },
                { status: 409 }
            );
        }
        console.error('Error updating commodity:', error);
        return NextResponse.json({ error: 'Failed to update commodity' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    try {
        const body = await request.json().catch(() => null);
        const parseResult = CreateCommoditySchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const data = parseResult.data;

        const existing = await prisma.commodities.findFirst({
            where: { namespace: data.namespace, mnemonic: data.mnemonic },
            select: { guid: true },
        });
        if (existing) {
            return NextResponse.json(
                { error: 'A commodity with this namespace and symbol already exists' },
                { status: 409 }
            );
        }

        const created = await prisma.commodities.create({
            data: {
                guid: generateGuid(),
                namespace: data.namespace,
                mnemonic: data.mnemonic,
                fullname: data.fullname ?? null,
                cusip: data.cusip ?? null,
                fraction: data.fraction,
                quote_flag: data.quote_flag ? 1 : 0,
                quote_source: data.quote_source ?? null,
                quote_tz: data.quote_tz ?? null,
            },
            select: COMMODITY_SELECT,
        });

        return NextResponse.json(serializeBigInts(created), { status: 201 });
    } catch (error: unknown) {
        const code = (error as { code?: string } | null)?.code;
        if (code === 'P2002') {
            return NextResponse.json(
                { error: 'A commodity with this namespace and symbol already exists' },
                { status: 409 }
            );
        }
        console.error('Error creating commodity:', error);
        return NextResponse.json({ error: 'Failed to create commodity' }, { status: 500 });
    }
}
